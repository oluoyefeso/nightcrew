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
    // Held by another live process (this test's parent stands in for the dashboard).
    writeFileSync(lockFile, JSON.stringify({ pid: process.ppid, startedAt: "x" }));
    expect(takeCrewLock(data)).toEqual({ ok: false, pid: process.ppid });
    // Its owner is gone: stale, so it's ours.
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    writeFileSync(lockFile, JSON.stringify({ pid: dead.pid, startedAt: "x" }));
    const mine = takeCrewLock(data);
    expect(mine.ok).toBe(true);
    expect(JSON.parse(readFileSync(lockFile, "utf8")).pid).toBe(process.pid);
    if (mine.ok) mine.release();
    expect(existsSync(lockFile)).toBe(false);
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
