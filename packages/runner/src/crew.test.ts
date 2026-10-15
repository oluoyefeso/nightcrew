import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { phaseMeasurements } from "@nightcrew/core";
import {
  addRepo,
  createMission,
  createTask,
  type Db,
  getDispatchBackoff,
  getRun,
  getTask,
  listRunEvents,
  openDb,
  saveDispatchBackoff,
  updateMission,
  updateRepo,
  updateSettings,
  updateTask,
  upsertRuns,
} from "@nightcrew/db";
import { Crew, takeCrewLock } from "./crew";
import { ScriptedEngine } from "./engine";
import { git } from "./git";
import type { ReviewOutput } from "./prompts";

let dir: string;
let db: Db;
const READY: ReviewOutput = { verdict: "ready", summary: "ok", criteria: [], concerns: [], report: "ok" };

async function repo(name: string) {
  const path = join(dir, name);
  mkdirSync(join(path, "src"), { recursive: true });
  writeFileSync(join(path, "src", "index.ts"), "export {};\n");
  await git(path, "init", "-q", "-b", "main");
  await git(path, "add", "-A");
  await git(path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return addRepo(db, { name, path, defaultBranch: "main" });
}

/** An engine whose build phase takes `ms` and records how many ran at once. */
function slowEngine(ms: number, log: { concurrent: number; peak: number; order: string[] }) {
  return new ScriptedEngine({
    implement: async (req) => {
      log.concurrent++;
      log.peak = Math.max(log.peak, log.concurrent);
      log.order.push(req.prompt.match(/## Task\n(.+)/)?.[1] ?? "?");
      await new Promise((r) => setTimeout(r, ms));
      writeFileSync(join(req.cwd, "src", `${log.order.length}.ts`), "export {};\n");
      log.concurrent--;
      return { text: "done", costUsd: 0.5, tokensIn: 30_000 };
    },
    review: () => ({ structured: READY, costUsd: 0.1 }),
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nc-crew-"));
  db = openDb(":memory:");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const crewWith = (engine: ScriptedEngine) => new Crew({ db, engine, dataDir: join(dir, "data"), publish: false });

describe("dispatcher", () => {
  test("a limited engine holds unsupported work while admitted research can finish", async () => {
    const r = await repo("engine-admission");
    const code = createTask(db, { repoId: r.id, title: "Build a feature", status: "queued", workflow: "quick" });
    const research = createTask(db, { repoId: r.id, title: "Inspect behavior", type: "research", status: "queued" });
    const engine = new ScriptedEngine({ research: () => ({ text: "Synthetic research result." }) });
    Object.defineProperty(engine, "capabilities", {
      value: { phases: ["research"], structuredOutput: false, sessionContinuation: false },
    });
    const crew = crewWith(engine);
    expect(crew.preflight([code]).tasks[0]?.signals).toContainEqual(
      expect.objectContaining({ code: "engine-capability", kind: "hold" }),
    );
    expect(crew.getQueue().find((entry) => entry.taskId === code.id)?.kind).toBe("setup");
    await crew.drain();
    expect(getTask(db, code.id)).toMatchObject({ status: "queued", lastRunId: null });
    expect(getTask(db, research.id)?.status).toBe("done");
    expect(engine.calls.map((call) => call.phase)).toEqual(["research"]);
  });
  test("an unsupported stored task type stays held without crashing or spending model tokens", async () => {
    const r = await repo("invalid-routing");
    const task = createTask(db, { repoId: r.id, title: "Repair metadata", status: "queued" });
    // Simulate a database created by an older integration that skipped domain validation.
    db.$client.query("UPDATE tasks SET type = ? WHERE id = ?").run("feature", task.id);
    const engine = new ScriptedEngine({});
    const crew = crewWith(engine);
    expect(crew.preflight([getTask(db, task.id)!]).tasks[0]?.signals).toContainEqual(
      expect.objectContaining({ code: "task-routing", kind: "hold" }),
    );
    await crew.drain();
    expect(engine.calls).toHaveLength(0);
    expect(getTask(db, task.id)?.status).toBe("queued");
    updateTask(db, task.id, { type: "implementation" });
    expect(crew.preflight([getTask(db, task.id)!]).tasks[0]?.signals.some((s) => s.code === "task-routing")).toBe(
      false,
    );
  });
  test("an expired mission stays held after recovery while unrelated work can complete", async () => {
    const r = await repo("restart-limit");
    const mission = createMission(db, {
      title: "Bounded",
      objective: "Stop on time",
      stopAt: new Date(0).toISOString(),
    });
    const held = createTask(db, {
      repoId: r.id,
      title: "Interrupted",
      type: "research",
      status: "running",
      missionId: mission.id,
    });
    const free = createTask(db, { repoId: r.id, title: "Unrelated", type: "research", status: "queued" });
    const engine = new ScriptedEngine({ research: () => ({ text: "Report" }) });
    const crew = crewWith(engine);
    expect(crew.recover()).toBe(1);
    await crew.drain();
    expect(getTask(db, held.id)?.status).toBe("queued");
    expect(getTask(db, free.id)?.status).toBe("done");
    expect(crew.getQueue().find((entry) => entry.taskId === held.id)).toMatchObject({ kind: "deadline" });
    expect(crew.getQueue().find((entry) => entry.taskId === held.id)?.reason).toContain("stop deadline");
    expect(engine.calls).toHaveLength(1);
    const restarted = crewWith(engine);
    await restarted.drain();
    expect(engine.calls).toHaveLength(1);
  });

  test("tightening a mission stops active work even while dispatch is paused and saves unfinished code", async () => {
    const r = await repo("tighten-limit");
    const mission = createMission(db, { title: "Bounded", objective: "Keep unfinished progress" });
    const task = createTask(db, {
      repoId: r.id,
      title: "Active",
      missionId: mission.id,
      status: "queued",
      scope: ["src/**"],
    });
    const queued = createTask(db, { repoId: r.id, title: "Next", missionId: mission.id, status: "queued" });
    let began = () => {};
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    let signal: AbortSignal | undefined;
    const engine = new ScriptedEngine({
      implement: async (req) => {
        signal = req.signal;
        writeFileSync(join(req.cwd, "src/unfinished.ts"), "export const progress = true;\n");
        began();
        await new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve(), { once: true }));
        return { ok: false, error: "Stopped", tokensIn: 12, tokensOut: 3, usageStatus: "partial" };
      },
    });
    const crew = crewWith(engine);
    try {
      await crew.pump();
      await started;
      updateSettings(db, { dispatch: false });
      updateMission(db, mission.id, { stopAt: new Date(Date.now() + 100).toISOString() });
      await crew.pump();
      await crew.drain();
      expect(signal?.aborted).toBe(true);
      const runId = getTask(db, task.id)!.lastRunId!;
      expect(getRun(db, runId)?.run).toMatchObject({
        status: "timeout",
        reason: expect.stringContaining("Mission stop deadline reached"),
      });
      expect(
        phaseMeasurements(listRunEvents(db, runId), false).find((phase) => phase.phase === "implement")?.status,
      ).toBe("timed_out");
      expect((await git(r.path, "show", `refs/nightcrew/wip/${task.id}:src/unfinished.ts`)).stdout).toContain(
        "progress = true",
      );
      expect(getTask(db, queued.id)?.status).toBe("queued");
      expect(engine.calls.some((call) => call.phase === "review")).toBe(false);
      updateSettings(db, { dispatch: true });
      await crew.pump();
      expect(getTask(db, queued.id)?.status).toBe("queued");
    } finally {
      await crew.shutdown();
    }
  });

  for (const change of ["extend", "clear"] as const)
    test(`${change} does not relax the earliest stop time of active work`, async () => {
      const r = await repo(`retain-${change}`);
      const mission = createMission(db, { title: "Bounded", objective: "Keep active limits" });
      const task = createTask(db, {
        repoId: r.id,
        title: "Waiting",
        missionId: mission.id,
        status: "queued",
        type: "research",
      });
      let began = () => {};
      const started = new Promise<void>((resolve) => {
        began = resolve;
      });
      const engine = new ScriptedEngine({
        research: async (req) => {
          began();
          await new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve(), { once: true }));
          return { ok: false, error: "Stopped" };
        },
      });
      const crew = crewWith(engine);
      try {
        await crew.pump();
        await started;
        updateMission(db, mission.id, { stopAt: new Date(Date.now() + 100).toISOString() });
        await crew.pump();
        updateMission(db, mission.id, {
          stopAt: change === "clear" ? null : new Date(Date.now() + 60_000).toISOString(),
        });
        await crew.pump();
        await crew.drain();
        expect(getRun(db, getTask(db, task.id)!.lastRunId!)?.run.reason).toContain("Mission stop deadline reached");
        expect(getTask(db, task.id)?.autoRetries).toBe(0);
      } finally {
        await crew.shutdown();
      }
    });

  test("pausing a mission lets active work finish, holds its next task and leaves other work runnable", async () => {
    const r = await repo("mission");
    const mission = createMission(db, { title: "Team invitations", objective: "Original mission objective" });
    const first = createTask(db, {
      repoId: r.id,
      title: "First task",
      missionId: mission.id,
      status: "queued",
      scope: ["src/**"],
    });
    const second = createTask(db, {
      repoId: r.id,
      title: "Second task",
      missionId: mission.id,
      status: "queued",
      scope: ["src/**"],
    });
    const unrelated = createTask(db, { repoId: r.id, title: "Independent task", status: "queued", scope: ["src/**"] });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let began = () => {};
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const order: string[] = [];
    const engine = new ScriptedEngine({
      implement: async (req) => {
        const title = req.prompt.match(/## Task\n(.+)/)?.[1] ?? "";
        order.push(title);
        if (title === first.title) {
          began();
          await gate;
        }
        writeFileSync(join(req.cwd, "src/feature.ts"), `export const n = ${order.length};\n`);
        return { text: "Done" };
      },
      review: () => ({ structured: READY }),
    });
    const crew = crewWith(engine);
    try {
      await crew.pump();
      await started;
      updateMission(db, mission.id, { paused: true, objective: "Revised mission objective" });
      expect(crew.getQueue().find((entry) => entry.taskId === second.id)?.reason).toContain("Mission paused");
      release();
      await crew.drain();
      expect(order).toEqual([first.title, unrelated.title]);
      expect(getTask(db, first.id)?.status).toBe("done");
      expect(getTask(db, second.id)?.status).toBe("queued");
      const review = engine.calls.find((call) => call.phase === "review" && call.prompt.includes(first.title));
      expect(review?.prompt).toContain("Original mission objective");
      expect(review?.prompt).not.toContain("Revised mission objective");
      expect(review?.prompt).toContain("Implement only this task's scope");
      updateMission(db, mission.id, { paused: false });
      await crew.drain();
      expect(order).toEqual([first.title, unrelated.title, second.title]);
      expect(
        engine.calls.find((call) => call.phase === "implement" && call.prompt.includes(second.title))?.prompt,
      ).toContain("Revised mission objective");
    } finally {
      release();
      await crew.drain();
    }
  });

  test("required setup holds spend no tokens and resume after configuration is fixed", async () => {
    const r = await repo("preflight");
    updateRepo(db, r.id, {
      policies: { implementation: { autonomy: null, requireTests: true, visual: false, regression: false } },
    });
    const task = createTask(db, { repoId: r.id, title: "Build a feature", status: "queued", scope: ["src/**"] });
    const engine = slowEngine(1, { concurrent: 0, peak: 0, order: [] });
    const crew = crewWith(engine);
    expect(crew.preflight([task]).tasks[0]?.signals.some((s) => s.code === "tests" && s.kind === "hold")).toBe(true);
    await crew.drain();
    expect(engine.calls).toHaveLength(0);
    expect(getTask(db, task.id)?.lastRunId).toBeNull();
    expect(crew.getQueue()[0]?.kind).toBe("setup");
    updateRepo(db, r.id, { testCommand: "test -f src/1.ts" });
    await crew.drain();
    expect(getTask(db, task.id)?.status).toBe("done");
    expect(engine.calls.some((c) => c.phase === "implement")).toBe(true);
  });

  test("preview accounts for running reservations without creating tasks or starting work", async () => {
    const r = await repo("reservations");
    updateSettings(db, { dailyTokenBudget: 1_500_000 });
    const task = createTask(db, {
      repoId: r.id,
      title: "Active",
      status: "queued",
      tokenBudget: 1_000_000,
      scope: ["src/**"],
    });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let start = () => {};
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const engine = new ScriptedEngine({
      implement: async (req) => {
        start();
        await gate;
        writeFileSync(join(req.cwd, "src/feature.ts"), "export {};\n");
        return { text: "Done" };
      },
      review: () => ({ structured: READY }),
    });
    const crew = crewWith(engine);
    try {
      await crew.pump();
      await started;
      const report = crew.preflight([{ ...task, id: "draft:0", title: "Next", tokenBudget: 600_000 }]);
      expect(report.budget).toMatchObject({ reserved: 1_000_000, available: 500_000, requested: 600_000 });
      expect(report.tasks[0]?.signals.some((s) => s.code === "budget" && s.kind === "wait")).toBe(true);
      expect(getTask(db, "draft:0")).toBeNull();
    } finally {
      release();
      await crew.drain();
    }
  });

  test("preview distinguishes dependency cycles, missing prerequisites and possible overlap", async () => {
    const r = await repo("dependencies");
    const a = createTask(db, { repoId: r.id, title: "A", status: "queued", scope: ["src/**"] });
    const b = createTask(db, { repoId: r.id, title: "B", status: "queued", dependsOn: [a.id], scope: ["src/ui/**"] });
    const crew = crewWith(new ScriptedEngine({}));
    const cycle = crew.preflight([{ ...a, dependsOn: [b.id] }]);
    expect(cycle.tasks[0]?.signals.some((s) => s.code === "dependency-cycle" && s.kind === "hold")).toBe(true);
    const missing = crew.preflight([{ ...a, dependsOn: ["gone"] }]);
    expect(missing.tasks[0]?.signals.some((s) => s.code === "dependency-missing")).toBe(true);
    const independent = crew.preflight([{ ...a, id: "draft:0", title: "New work", scope: ["src/ui/button.ts"] }]);
    expect(independent.tasks[0]?.signals.some((s) => s.code === "overlap" && s.kind === "notice")).toBe(true);
    const ordered = crew.preflight([{ ...b }]);
    expect(ordered.tasks[0]?.signals.some((s) => s.code === "overlap")).toBe(false);
    expect(ordered.tasks[0]?.signals.some((s) => s.code === "dependency" && s.taskId === a.id)).toBe(true);
  });

  test("the Station explains dependency failures, schedules, pause, and budget without dispatching", () => {
    const r = addRepo(db, { name: "example", path: "/example/project", defaultBranch: "main" });
    const dependency = createTask(db, { repoId: r.id, title: "API change", status: "done" });
    upsertRuns(db, [
      {
        run: {
          id: "failed-dependency",
          taskId: dependency.id,
          title: dependency.title,
          repo: r.name,
          nightId: "2026-04-16",
          sessionId: "test",
          source: "local",
          status: "failed",
        },
        artifacts: [],
      },
    ]);
    updateTask(db, dependency.id, { lastRunId: "failed-dependency" });
    const blocked = createTask(db, { repoId: r.id, title: "UI change", status: "queued", dependsOn: [dependency.id] });
    const scheduled = createTask(db, {
      repoId: r.id,
      title: "Tomorrow",
      status: "queued",
      runAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const ready = createTask(db, { repoId: r.id, title: "Ready", status: "queued" });
    const crew = crewWith(new ScriptedEngine({}));
    const entry = (id: string) => crew.getQueue().find((t) => t.taskId === id);
    expect(entry(blocked.id)?.kind).toBe("dependency");
    expect(entry(blocked.id)?.reason).toContain("API change");
    expect(entry(scheduled.id)?.kind).toBe("scheduled");
    expect(entry(ready.id)?.kind).toBe("ready");
    updateSettings(db, { dispatch: false });
    expect(entry(ready.id)?.kind).toBe("paused");
    updateSettings(db, { dispatch: true, dailyTokenBudget: 100_000 });
    expect(entry(ready.id)?.kind).toBe("budget");
    expect(crew.getStatus().active).toHaveLength(0);
    expect(getTask(db, ready.id)?.status).toBe("queued");
  });

  test("a task left running by a crash goes back to the queue when the crew recovers", async () => {
    // Value: protects=recover() requeues tasks orphaned in "running" so a crash never strands work; fails_when=the recovery loop is dropped or touches other statuses; why_new=crash recovery untested; seam=none
    updateSettings(db, { dispatch: false });
    const r = await repo("a");
    const orphan = createTask(db, { repoId: r.id, title: "Orphan", scope: ["src/**"], status: "running" });
    const finished = createTask(db, { repoId: r.id, title: "Finished", scope: ["src/**"], status: "done" });
    const parked = createTask(db, { repoId: r.id, title: "Parked", scope: ["src/**"], status: "later" });
    const crew = crewWith(new ScriptedEngine({}));
    expect(crew.recover()).toBe(1);
    expect(getTask(db, orphan.id)?.status).toBe("queued");
    expect(getTask(db, finished.id)?.status).toBe("done");
    expect(getTask(db, parked.id)?.status).toBe("later");
    expect(crew.getStatus().queued).toBe(1);
  });

  test("constructing a crew alone leaves running tasks alone", async () => {
    // Value: protects=a CLI command (add, repo, import) never requeues tasks a live dashboard is running; fails_when=recovery moves back into the constructor and every process steals running work; why_new=R4 split recovery out of the constructor; seam=none
    const r = await repo("a");
    const live = createTask(db, { repoId: r.id, title: "Live", scope: ["src/**"], status: "running" });
    crewWith(new ScriptedEngine({}));
    expect(getTask(db, live.id)?.status).toBe("running");
  });

  test("only one process holds the crew lock; a dead owner's lock is taken over", async () => {
    // Value: protects=the dashboard and `nightcrew run` never dispatch the same queue at once, and a crash never wedges the lock; fails_when=the lock is not exclusive, a stale pid blocks forever, or release removes someone else's lock; why_new=R4 cross-process lock is new; seam=none
    const data = join(dir, "lockdata");
    mkdirSync(data, { recursive: true });
    const lockFile = join(data, "crew.lock");
    // Held by another live NightCrew (a child whose command line says so stands in for the dashboard).
    const owner = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 30000)", "nightcrew"]);
    try {
      writeFileSync(lockFile, JSON.stringify({ pid: owner.pid, startedAt: new Date().toISOString() }));
      expect(takeCrewLock(data)).toEqual({ ok: false, pid: owner.pid, file: lockFile });
    } finally {
      owner.kill();
    }
    // Its owner is gone: stale, so it's ours.
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    writeFileSync(lockFile, JSON.stringify({ pid: dead.pid, startedAt: "x" }));
    const mine = takeCrewLock(data);
    expect(mine.ok).toBe(true);
    const held = JSON.parse(readFileSync(lockFile, "utf8"));
    expect(held.pid).toBe(process.pid);
    expect(held.nonce).toBeString();
    if (mine.ok) mine.release();
    expect(existsSync(lockFile)).toBe(false);
  });

  test("a lock whose pid now belongs to some other program is stale", async () => {
    // Value: protects=after a reboot reuses the old pid for an unrelated process, NightCrew still starts; fails_when=liveness alone (kill 0 or EPERM) decides ownership again; why_new=a reused pid made NightCrew refuse to start forever; seam=none
    const data = join(dir, "lockdata");
    mkdirSync(data, { recursive: true });
    const lockFile = join(data, "crew.lock");
    const other = Bun.spawn(["sleep", "30"]);
    try {
      writeFileSync(
        lockFile,
        JSON.stringify({ pid: other.pid, startedAt: new Date().toISOString(), nonce: "old", command: "nightcrew" }),
      );
      const mine = takeCrewLock(data);
      expect(mine.ok).toBe(true);
      expect(JSON.parse(readFileSync(lockFile, "utf8")).pid).toBe(process.pid);
      // Release only removes our own lock, not one someone else wrote since.
      writeFileSync(lockFile, JSON.stringify({ pid: other.pid, startedAt: "x", nonce: "theirs" }));
      if (mine.ok) mine.release();
      expect(existsSync(lockFile)).toBe(true);
    } finally {
      other.kill();
    }
    // A process that started after the lock was written can't own it, whatever it's called.
    const late = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 30000)", "nightcrew"]);
    try {
      writeFileSync(lockFile, JSON.stringify({ pid: late.pid, startedAt: "2020-01-01T00:00:00Z", nonce: "old" }));
      expect(takeCrewLock(data).ok).toBe(true);
    } finally {
      late.kill();
    }
  });

  test("when processes can't be inspected (no ps), a live owner keeps its lock", async () => {
    // Value: protects=on a box without ps (busybox, slim containers) a live dashboard's lock is honoured, so two dispatchers never run the same queue; fails_when=ownsLock treats an empty process probe as stale again; why_new=W2 a null probe marked every live owner stale; seam=none
    const data = join(dir, "lockdata");
    mkdirSync(data, { recursive: true });
    const lockFile = join(data, "crew.lock");
    const noPs = () => null;
    const owner = Bun.spawn(["sleep", "30"]);
    try {
      writeFileSync(lockFile, JSON.stringify({ pid: owner.pid, startedAt: new Date().toISOString(), nonce: "theirs" }));
      expect(takeCrewLock(data, noPs)).toEqual({ ok: false, pid: owner.pid, file: lockFile });
    } finally {
      owner.kill();
      await owner.exited;
    }
    // Once the owner is gone, the lock is stale even without ps.
    const mine = takeCrewLock(data, noPs);
    expect(mine.ok).toBe(true);
    if (mine.ok) mine.release();
  });

  /** A stale lock: its pid is a live process that isn't NightCrew (a reused pid). */
  function staleLock(data: string, pid: number) {
    mkdirSync(data, { recursive: true });
    const lockFile = join(data, "crew.lock");
    writeFileSync(
      lockFile,
      JSON.stringify({ pid, startedAt: new Date().toISOString(), nonce: "old", command: "nightcrew dashboard" }),
    );
    return lockFile;
  }
  const notNightCrew = () => ({ command: "sleep 30", startedAt: null });

  test("two dispatchers taking over one stale lock: exactly one wins", async () => {
    // Value: protects=two processes that both find the lock stale can't both take it over and dispatch the same queue; fails_when=the takeover isn't guarded by an exclusive takeover file, so a second takeover that starts while the first is between its check and its swap also wins; why_new=Z2; seam=none
    const other = Bun.spawn(["sleep", "30"]);
    try {
      // B starts while A holds the takeover file (A's re-check under it looks at the owner).
      const data = join(dir, "lock-a");
      const lockFile = staleLock(data, other.pid);
      let lookups = 0;
      let b: ReturnType<typeof takeCrewLock> | null = null;
      const a = takeCrewLock(data, (pid) => {
        if (pid === other.pid && ++lookups === 2) b = takeCrewLock(data, notNightCrew);
        return notNightCrew();
      });
      expect(b as ReturnType<typeof takeCrewLock> | null).toEqual({ ok: false, pid: other.pid, file: lockFile });
      expect(a.ok).toBe(true);
      expect(existsSync(`${lockFile}.takeover`)).toBe(false);
      if (a.ok) a.release();

      // B starts and finishes while A is still deciding the lock is stale: B's lock stands.
      const data2 = join(dir, "lock-b");
      const lockFile2 = staleLock(data2, other.pid);
      let first = true;
      let b2: ReturnType<typeof takeCrewLock> | null = null;
      const a2 = takeCrewLock(data2, (pid) => {
        if (pid === other.pid && first) {
          first = false;
          b2 = takeCrewLock(data2, notNightCrew);
        }
        return notNightCrew();
      });
      expect((b2 as ReturnType<typeof takeCrewLock> | null)?.ok).toBe(true);
      expect(a2.ok).toBe(false);
      expect(JSON.parse(readFileSync(lockFile2, "utf8")).nonce).not.toBe("old");
    } finally {
      other.kill();
    }
  });

  test("a takeover file left by a takeover that died is cleared; a fresh one means someone is taking over", async () => {
    // Value: protects=a crash mid-takeover can't wedge the lock forever, and a takeover in progress isn't trampled; fails_when=the takeover file never goes stale, or is ignored; why_new=Z2; seam=none
    const other = Bun.spawn(["sleep", "30"]);
    try {
      const data = join(dir, "lock-c");
      const lockFile = staleLock(data, other.pid);
      writeFileSync(`${lockFile}.takeover`, "someone");
      expect(takeCrewLock(data, notNightCrew)).toEqual({ ok: false, pid: other.pid, file: lockFile });
      const old = new Date(Date.now() - 60_000);
      utimesSync(`${lockFile}.takeover`, old, old);
      const mine = takeCrewLock(data, notNightCrew);
      expect(mine.ok).toBe(true);
      expect(existsSync(`${lockFile}.takeover`)).toBe(false);
      if (mine.ok) mine.release();
    } finally {
      other.kill();
    }
  });

  test("shutting down puts in-flight work back in the queue and publishes nothing", async () => {
    // Value: protects=Ctrl-C requeues the running task, starts nothing new and never pushes a train on the way out; fails_when=Crew.finished treats a shutdown stop like a finished run (task marked done, retry or publishTrains runs); why_new=the first Ctrl-C used to mark in-flight tasks done and could git push during shutdown; seam=none
    const a = await repo("a");
    const long = createTask(db, { repoId: a.id, title: "Long", scope: ["src/**"], status: "queued" });
    const next = createTask(db, { repoId: a.id, title: "Next", scope: ["src/**"], status: "queued" });
    const started: string[] = [];
    let building: () => void = () => {};
    const inBuild = new Promise<void>((r) => {
      building = r;
    });
    const engine = new ScriptedEngine({
      implement: async (req) => {
        started.push(req.prompt.match(/## Task\n(.+)/)?.[1] ?? "?");
        building();
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 5_000);
          req.signal.addEventListener("abort", () => {
            clearTimeout(t);
            resolve();
          });
        });
        return { ok: false, error: "Stopped: the task ran out of time or was cancelled." };
      },
    });
    const crew = new Crew({ db, engine, dataDir: join(dir, "data"), publish: true });
    let published = 0;
    Object.assign(crew, {
      publishTrains: async () => {
        published++;
      },
    });
    await crew.pump();
    await inBuild;
    crew.shutdown();
    await crew.drain();
    expect(started).toEqual(["Long"]);
    expect(getTask(db, long.id)?.status).toBe("queued");
    expect(getTask(db, next.id)?.status).toBe("queued");
    expect(published).toBe(0);
    expect(crew.getStatus().active).toHaveLength(0);
  });

  test("a task whose run crashes goes back in the queue instead of staying running", async () => {
    // Value: protects=a thrown runTask never strands a task in "running", and a task that always crashes waits before retrying instead of spinning; fails_when=the launch catch only records a message, or requeues with no delay; why_new=a crash used to leave the task running until the next restart; seam=none
    const r = await repo("a");
    const t = createTask(db, { repoId: r.id, title: "Crashy", scope: ["src/**"], status: "queued" });
    // A data dir that is a file: runTask throws making its artifacts folder.
    const dataDir = join(dir, "data-file");
    writeFileSync(dataDir, "not a folder");
    const crew = new Crew({ db, engine: new ScriptedEngine({}), dataDir, publish: false });
    await crew.drain();
    const after = getTask(db, t.id);
    expect(after?.status).toBe("queued");
    expect(new Date(after?.runAt ?? 0).getTime()).toBeGreaterThan(Date.now());
    expect(crew.getStatus().message).toContain("crashed");
    expect(crew.getStatus().message).toContain("next `nightcrew run` or dashboard start");
    expect(crew.getStatus().scheduled).toBe(1);
  });

  test("a crash under the dashboard's schedule promises the 10-minute retry", async () => {
    // Value: protects=the crash message only promises a retry in 10 minutes when a schedule will actually pick it up; fails_when=the message ignores whether the crew keeps ticking, telling `nightcrew run` users it retries in 10 minutes after the process has exited; why_new=W3 the message was the same for both modes; seam=none
    const r = await repo("a");
    createTask(db, { repoId: r.id, title: "Crashy", scope: ["src/**"], status: "queued" });
    const dataDir = join(dir, "data-file");
    writeFileSync(dataDir, "not a folder");
    const crew = new Crew({ db, engine: new ScriptedEngine({}), dataDir, publish: false });
    crew.startSchedule();
    try {
      await crew.drain();
      expect(crew.getStatus().message).toContain("tries again in 10 minutes");
    } finally {
      crew.stopSchedule();
    }
  });

  test("runs agents in parallel across repos, one per repo by default", async () => {
    const a = await repo("a");
    const b = await repo("b");
    const c = await repo("c");
    for (const r of [a, b, c])
      createTask(db, { repoId: r.id, title: `Task in ${r.name}`, scope: ["src/**"], status: "queued" });
    createTask(db, { repoId: a.id, title: "Second in a", scope: ["src/**"], status: "queued" });
    const log = { concurrent: 0, peak: 0, order: [] as string[] };
    const crew = crewWith(slowEngine(150, log));
    await crew.drain();
    expect(log.peak).toBe(3); // three repos at once
    expect(log.order.at(-1)).toBe("Second in a"); // waited for repo a's slot
    expect(crew.getStatus().state).toBe("idle");
  });

  test("respects the total agent limit", async () => {
    updateSettings(db, { maxAgents: 2 });
    for (const n of ["a", "b", "c"]) {
      const r = await repo(n);
      createTask(db, { repoId: r.id, title: n, scope: ["src/**"], status: "queued" });
    }
    const log = { concurrent: 0, peak: 0, order: [] as string[] };
    await crewWith(slowEngine(100, log)).drain();
    expect(log.peak).toBe(2);
    expect(log.order).toHaveLength(3);
  });

  test("scheduled tasks wait for their time", async () => {
    const r = await repo("a");
    const later = createTask(db, {
      repoId: r.id,
      title: "Later",
      scope: ["src/**"],
      status: "queued",
      runAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const now = createTask(db, { repoId: r.id, title: "Now", scope: ["src/**"], status: "queued" });
    const log = { concurrent: 0, peak: 0, order: [] as string[] };
    const crew = crewWith(slowEngine(10, log));
    await crew.drain();
    expect(log.order).toEqual(["Now"]);
    expect(getTask(db, later.id)?.status).toBe("queued");
    expect(getTask(db, now.id)?.status).toBe("done");
    expect(crew.getStatus().scheduled).toBe(1);
  });

  test("a dependent task waits until its dependency has finished", async () => {
    const a = await repo("a");
    const b = await repo("b");
    const first = createTask(db, { repoId: a.id, title: "First", scope: ["src/**"], status: "queued" });
    createTask(db, { repoId: b.id, title: "Second", scope: ["src/**"], status: "queued", dependsOn: [first.id] });
    const log = { concurrent: 0, peak: 0, order: [] as string[] };
    await crewWith(slowEngine(80, log)).drain();
    expect(log.peak).toBe(1);
    expect(log.order).toEqual(["First", "Second"]);
  });

  test("a dependency whose last run failed keeps its dependents waiting", async () => {
    // Value: protects=a prerequisite that failed or timed out (status done) doesn't release the tasks built on it; fails_when=nextRunnable counts status done as met whatever the run's outcome; why_new=Z5; seam=none
    const a = await repo("a");
    const first = createTask(db, { repoId: a.id, title: "First", scope: ["src/**"], status: "queued" });
    const second = createTask(db, {
      repoId: a.id,
      title: "Second",
      scope: ["src/**"],
      status: "queued",
      dependsOn: [first.id],
    });
    const order: string[] = [];
    const engine = new ScriptedEngine({
      // Changes nothing: the run fails.
      implement: (req) => {
        order.push(req.prompt.match(/## Task\n(.+)/)?.[1] ?? "?");
        return { text: "done" };
      },
      review: () => ({ structured: READY }),
    });
    const crew = crewWith(engine);
    await crew.drain();
    expect(order).toEqual(["First"]);
    expect(getTask(db, first.id)?.status).toBe("done");
    expect(getTask(db, second.id)?.status).toBe("queued");
    // Dismissing the failure archives its task; that must not make it successful.
    updateTask(db, first.id, { status: "archived" });
    await crew.drain();
    expect(order).toEqual(["First"]);
    expect(getTask(db, second.id)?.status).toBe("queued");
    expect(crew.getQueue().find((t) => t.taskId === second.id)?.kind).toBe("dependency");
  });

  test("a plan-only task does not release a code task that depends on its implementation", async () => {
    const a = await repo("a");
    updateRepo(db, a.id, {
      policies: { refactor: { autonomy: "propose", requireTests: false, visual: false, regression: false } },
    });
    const first = createTask(db, { repoId: a.id, type: "refactor", title: "Plan the refactor", status: "queued" });
    const second = createTask(db, {
      repoId: a.id,
      title: "Build on the refactor",
      status: "queued",
      dependsOn: [first.id],
    });
    const engine = new ScriptedEngine({ plan: () => ({ text: "A plan for review." }) });
    const crew = crewWith(engine);
    await crew.drain();
    expect(engine.calls.map((call) => call.phase)).toEqual(["plan"]);
    expect(getTask(db, first.id)?.status).toBe("done");
    expect(getTask(db, second.id)?.status).toBe("queued");
    expect(crew.getQueue().find((entry) => entry.taskId === second.id)?.kind).toBe("dependency");
  });

  test("in a train repo, a dependency that completed without boarding keeps its dependents waiting", async () => {
    // Value: protects=at the train level a prerequisite counts only once its work is landed or in a PR, not merely complete; fails_when=a complete run alone releases dependents in a repo that lands its own work; why_new=Z5; seam=none
    const a = await repo("a");
    updateRepo(db, a.id, { level: "train" });
    const first = createTask(db, { repoId: a.id, title: "First", scope: ["src/**"], status: "queued" });
    createTask(db, { repoId: a.id, title: "Second", scope: ["src/**"], status: "queued", dependsOn: [first.id] });
    const order: string[] = [];
    const engine = new ScriptedEngine({
      implement: (req) => {
        order.push(req.prompt.match(/## Task\n(.+)/)?.[1] ?? "?");
        writeFileSync(join(req.cwd, "src", "x.ts"), "export {};\n");
        return { text: "done" };
      },
      // The reviewer wants a person to look: no train, and no PR with publishing off.
      review: () => ({ structured: { ...READY, verdict: "needs_eyes" } }),
    });
    await crewWith(engine).drain();
    expect(order).toEqual(["First"]);
  });

  test("holds work that would pass the daily token budget (tokens used + caps of running agents)", async () => {
    // One fits (500k <= 520k). While it runs, Two can't start (500k + 500k > 520k).
    // After One finishes it has really used ~30k tokens, and 30k + 500k still passes 520k.
    updateSettings(db, { dailyTokenBudget: 520_000 });
    const a = await repo("a");
    const b = await repo("b");
    createTask(db, { repoId: a.id, title: "One", scope: ["src/**"], status: "queued", tokenBudget: 500_000 });
    createTask(db, { repoId: b.id, title: "Two", scope: ["src/**"], status: "queued", tokenBudget: 500_000 });
    const log = { concurrent: 0, peak: 0, order: [] as string[] };
    const crew = crewWith(slowEngine(10, log));
    await crew.drain();
    expect(log.order).toHaveLength(1);
    expect(crew.getStatus().message).toContain("budget");
  });

  test("a task whose budget is above the whole daily budget is skipped, not held in front of the rest", async () => {
    // Value: protects=one task that can never fit the daily budget doesn't stall the queue behind it, and the crew says which task and what to change; fails_when=pump breaks on the oversized task (holding everything forever) or launches it anyway; why_new=W1 the hold path broke on a task that could never start; seam=none
    updateSettings(db, { dailyTokenBudget: 600_000, maxAgents: 1 });
    const a = await repo("a");
    // The API refuses this, but an old task or a since-lowered budget can leave one behind.
    const big = createTask(db, {
      repoId: a.id,
      title: "Huge",
      scope: ["src/**"],
      status: "queued",
      tokenBudget: 2_000_000,
    });
    createTask(db, { repoId: a.id, title: "Small", scope: ["src/**"], status: "queued", tokenBudget: 100_000 });
    const log = { concurrent: 0, peak: 0, order: [] as string[] };
    const crew = crewWith(slowEngine(10, log));
    await crew.drain();
    expect(log.order).toEqual(["Small"]);
    expect(getTask(db, big.id)?.status).toBe("queued");
    expect(crew.getStatus().message).toBe('"Huge" needs a bigger daily budget than 600k tokens; raise one of them.');
  });

  test("paused dispatch starts nothing", async () => {
    updateSettings(db, { dispatch: false });
    const r = await repo("a");
    createTask(db, { repoId: r.id, title: "Waiting", scope: ["src/**"], status: "queued" });
    const log = { concurrent: 0, peak: 0, order: [] as string[] };
    const crew = crewWith(slowEngine(10, log));
    await crew.drain();
    expect(log.order).toEqual([]);
    expect(crew.getStatus().state).toBe("paused");
  });

  test("stopping one agent leaves the others running", async () => {
    const a = await repo("a");
    const b = await repo("b");
    const stopMe = createTask(db, { repoId: a.id, title: "Stop me", scope: ["src/**"], status: "queued" });
    const keep = createTask(db, { repoId: b.id, title: "Keep going", scope: ["src/**"], status: "queued" });
    const engine = new ScriptedEngine({
      implement: async (req) => {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 200);
          req.signal.addEventListener("abort", () => {
            clearTimeout(t);
            resolve();
          });
        });
        if (req.signal.aborted) return { ok: false, error: "Stopped: the task ran out of time or was cancelled." };
        writeFileSync(join(req.cwd, "src", "x.ts"), "export {};\n");
        return { text: "done" };
      },
      review: () => ({ structured: READY }),
    });
    const crew = crewWith(engine);
    await crew.pump();
    expect(crew.getStatus().active).toHaveLength(2);
    expect(crew.stopAgent(stopMe.id)).toBe(true);
    await crew.drain();
    expect(getTask(db, stopMe.id)?.status).toBe("done");
    expect(getTask(db, keep.id)?.status).toBe("done");
  });

  test("a rate-limited agent puts its task back and pauses dispatch", async () => {
    // Value: protects=429 requeues the task and holds new dispatch during backoff; fails_when=the 429 check or pausedUntil gate breaks and agents hammer the API; why_new=backoff path untested; seam=none
    updateSettings(db, { maxAgents: 1 });
    const a = await repo("a");
    const b = await repo("b");
    const limited = createTask(db, { repoId: a.id, title: "Limited", scope: ["src/**"], status: "queued" });
    const waiting = createTask(db, { repoId: b.id, title: "Waiting", scope: ["src/**"], status: "queued" });
    const started: string[] = [];
    const engine = new ScriptedEngine({
      implement: (req) => {
        started.push(req.prompt.match(/## Task\n(.+)/)?.[1] ?? "?");
        return { ok: false, error: "Rate limited by the API (429).", rateLimited: true };
      },
    });
    const crew = crewWith(engine);
    await crew.drain();
    expect(started).toEqual(["Limited"]);
    expect(getTask(db, limited.id)?.status).toBe("queued");
    expect(getTask(db, waiting.id)?.status).toBe("queued");
    const status = crew.getStatus();
    expect(status.state).toBe("waiting");
    expect(status.message).toContain("Rate limited");
    expect(getDispatchBackoff(db).until).toBeGreaterThan(Date.now());
    const restarted = crewWith(engine);
    await restarted.drain();
    expect(restarted.getStatus().state).toBe("waiting");
    expect(started).toEqual(["Limited"]);
    crew.stopSchedule();
  });

  test("an expired saved cooldown permits work but keeps the next backoff step across restart", async () => {
    const r = await repo("cooldown");
    createTask(db, { repoId: r.id, title: "Limited research", type: "research", status: "queued" });
    saveDispatchBackoff(db, { until: Date.now() - 1, strikes: 1 });
    const before = Date.now();
    const engine = new ScriptedEngine({ research: () => ({ ok: false, error: "Rate limited", rateLimited: true }) });
    await crewWith(engine).drain();
    expect(engine.calls).toHaveLength(1);
    expect(getDispatchBackoff(db).strikes).toBe(2);
    expect(getDispatchBackoff(db).until).toBeGreaterThanOrEqual(before + 10 * 60_000);
    expect(getDispatchBackoff(db).until).toBeLessThanOrEqual(Date.now() + 10 * 60_000);
  });

  test("a completed run clears expired backoff history", async () => {
    const r = await repo("recovered");
    createTask(db, { repoId: r.id, title: "Research", type: "research", status: "queued" });
    saveDispatchBackoff(db, { until: Date.now() - 1, strikes: 2 });
    await crewWith(new ScriptedEngine({ research: () => ({ text: "Complete." }) })).drain();
    expect(getDispatchBackoff(db)).toEqual({ until: 0, strikes: 0 });
  });

  test("a flaky failure gets exactly one more try that day", async () => {
    // Value: protects=flaky failures retry once per task per day, never loop; fails_when=retriedToday is dropped (infinite retries) or flaky never requeues; why_new=retry path untested; seam=none
    const r = await repo("a");
    const t = createTask(db, { repoId: r.id, title: "Flaky", scope: ["src/**"], status: "queued" });
    let attempts = 0;
    const engine = new ScriptedEngine({
      implement: () => {
        attempts++;
        return { ok: false, error: "connect ETIMEDOUT 140.82.112.3:443" };
      },
    });
    await crewWith(engine).drain();
    expect(attempts).toBe(2); // A failed build has no build checkpoint to reuse.
    expect(getTask(db, t.id)?.autoRetries).toBe(1);
    expect(getTask(db, t.id)?.status).toBe("done");
  });

  test("a failure that merely mentions 429 doesn't pause dispatch", async () => {
    // Value: protects=only an engine-reported rate limit pauses the crew; fails_when=Crew.finished goes back to matching "429" in the reason, so a test failure like "expected 429" halts every agent for minutes; why_new=R2 replaced text matching with a structured flag; seam=none
    updateSettings(db, { maxAgents: 1 });
    const a = await repo("a");
    const b = await repo("b");
    createTask(db, { repoId: a.id, title: "First", scope: ["src/**"], status: "queued" });
    createTask(db, { repoId: b.id, title: "Second", scope: ["src/**"], status: "queued" });
    const started: string[] = [];
    const engine = new ScriptedEngine({
      implement: (req) => {
        started.push(req.prompt.match(/## Task\n(.+)/)?.[1] ?? "?");
        return { ok: false, error: "Expected status 429 but got 200." };
      },
    });
    const crew = crewWith(engine);
    await crew.drain();
    expect(started).toEqual(["First", "Second"]);
    expect(crew.getStatus().state).not.toBe("waiting");
  });

  test("a test command that fails with a network blip in its output gets one flaky retry", async () => {
    // Value: protects=flaky classification sees the failing check's output, not just "`cmd` failed (exit 1)"; fails_when=TaskOutcome stops carrying the log or Crew passes the reason as the log; why_new=R3 classifyFailure got the reason twice; seam=none
    const r = await repo("a");
    const t = createTask(db, {
      repoId: r.id,
      title: "Network",
      scope: ["src/**"],
      status: "queued",
      // The reason quotes the command, so only the output may spell out the blip.
      testCommand: "printf 'connect ETIME%sOUT 140.82.112.3:443\\n' D; exit 1",
    });
    let attempts = 0;
    const engine = new ScriptedEngine({
      implement: (req) => {
        attempts++;
        writeFileSync(join(req.cwd, "src", "x.ts"), `export const n = ${attempts};\n`);
        return { text: "done" };
      },
    });
    await crewWith(engine).drain();
    expect(attempts).toBe(1); // The retry verifies the saved build without rebuilding.
    expect(getTask(db, t.id)?.autoRetries).toBe(1);
    expect(getTask(db, t.id)?.status).toBe("done");
  });
});

describe("mission dispatch limits", () => {
  test("priority orders independent missions, while expired deadlines and exhausted budgets hold new starts", async () => {
    const r = await repo("priorities");
    updateSettings(db, { maxAgents: 1 });
    const normal = createMission(db, { title: "Normal", objective: "Normal work" });
    const urgent = createMission(db, { title: "Urgent", objective: "Urgent work" });
    const expired = createMission(db, { title: "Expired", objective: "Expired work" });
    const limited = createMission(db, { title: "Limited", objective: "Limited work" });
    updateMission(db, urgent.id, { priority: 3 });
    updateMission(db, expired.id, { deadline: "2000-01-01T00:00:00Z" });
    updateMission(db, limited.id, { tokenBudget: 50000 });
    for (const mission of [normal, urgent, expired, limited])
      createTask(db, {
        repoId: r.id,
        title: mission.title,
        missionId: mission.id,
        status: "queued",
        scope: ["src/**"],
      });
    const log = { concurrent: 0, peak: 0, order: [] as string[] };
    const crew = crewWith(slowEngine(1, log));
    expect(crew.getQueue().find((e) => e.title === "Expired")?.reason).toContain("deadline");
    expect(crew.getQueue().find((e) => e.title === "Limited")?.reason).toContain("Mission budget");
    await crew.drain();
    expect(log.order).toEqual(["Urgent", "Normal"]);
  });

  test("restarting the dispatcher cannot reset the crash retry limit", async () => {
    const r = await repo("recover");
    const task = createTask(db, { repoId: r.id, title: "Orphan", status: "running" });
    for (let i = 0; i < 3; i++) {
      updateTask(db, task.id, { status: "running" });
      crewWith(new ScriptedEngine({})).recover();
    }
    expect(getTask(db, task.id)?.status).toBe("done");
    expect(getTask(db, task.id)?.autoRetries).toBe(3);
  });
});
