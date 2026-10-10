import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addRepo, createTask, type Db, getTask, openDb, updateSettings } from "@nightcrew/db";
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
    crew.stopSchedule();
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
    expect(attempts).toBe(2);
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
    expect(attempts).toBe(2);
    expect(getTask(db, t.id)?.status).toBe("done");
  });
});
