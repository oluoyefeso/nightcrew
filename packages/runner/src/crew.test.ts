import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addRepo, createTask, type Db, getTask, openDb, updateSettings } from "@nightcrew/db";
import { Crew } from "./crew";
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
      return { text: "done", costUsd: 0.5 };
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

  test("holds work that would pass the daily budget (actual spend + caps of running agents)", async () => {
    // One fits (500 <= 520). While it runs, Two can't start (500 + 500 > 520).
    // After One finishes it has really spent 60¢, and 60 + 500 still passes 520.
    updateSettings(db, { dailyBudgetCents: 520 });
    const a = await repo("a");
    const b = await repo("b");
    createTask(db, { repoId: a.id, title: "One", scope: ["src/**"], status: "queued", budgetCents: 500 });
    createTask(db, { repoId: b.id, title: "Two", scope: ["src/**"], status: "queued", budgetCents: 500 });
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
});
