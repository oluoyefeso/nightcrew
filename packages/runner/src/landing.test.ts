import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addRepo, createTask, type Db, getRepo, getRun, listTrains, openDb, updateRepo } from "@nightcrew/db";
import { ScriptedEngine } from "./engine";
import { git } from "./git";
import { canShip, undoShip } from "./landing";
import { runTask } from "./pipeline";
import type { ReviewOutput } from "./prompts";
import { JevReflexes, ruleConfidence, ruleWorkflow } from "./reflexes";

let dir: string;
let repoPath: string;
let db: Db;

const READY: ReviewOutput = {
  verdict: "ready",
  summary: "ok",
  criteria: [],
  concerns: [],
  challenges: [{ challenge: "edge", held: false, detail: "fine" }],
  report: "ok",
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "nc-land-"));
  repoPath = join(dir, "acme");
  mkdirSync(join(repoPath, "src"), { recursive: true });
  writeFileSync(join(repoPath, "src", "index.ts"), "export const x = 1;\n");
  await git(repoPath, "init", "-q", "-b", "main");
  await git(repoPath, "add", "-A");
  await git(repoPath, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  await git(repoPath, "branch", "dev");
  db = openDb(":memory:");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const writer = (file: string) =>
  new ScriptedEngine({
    implement: (req) => {
      writeFileSync(join(req.cwd, file), `export const v = "${file}";\n`);
      return { text: `Wrote ${file}.` };
    },
    review: () => ({ structured: READY }),
  });

const deps = (engine: ScriptedEngine) => ({
  db,
  engine,
  dataDir: join(dir, "data"),
  models: { plan: "m", build: "m", review: "m" },
  publish: false,
});

describe("workflow routing", () => {
  test("a small, scoped task skips the planning phase", async () => {
    const repo = addRepo(db, { name: "acme", path: repoPath, defaultBranch: "main" });
    const task = createTask(db, {
      repoId: repo.id,
      title: "Tiny",
      scope: ["src/**"],
      criteria: ["works"],
      status: "queued",
    });
    const engine = writer("src/a.ts");
    await runTask(deps(engine), task.id, new AbortController().signal);
    expect(engine.calls.map((c) => c.phase)).toEqual(["implement", "review"]);
  });
  test("rules: refactors and open-ended tasks get a plan", () => {
    const base = { scope: ["src/**"], brief: "short", criteria: ["a"] };
    expect(ruleWorkflow({ ...base, type: "implementation" } as never)).toBe("quick");
    expect(ruleWorkflow({ ...base, type: "refactor" } as never)).toBe("planned");
    expect(ruleWorkflow({ ...base, scope: [], type: "implementation" } as never)).toBe("planned");
  });
});

describe("nightly train", () => {
  test("ready tasks board one integration branch, tested together", async () => {
    const repo = addRepo(db, {
      name: "acme",
      path: repoPath,
      defaultBranch: "main",
      testCommand: "test -f src/index.ts",
    });
    updateRepo(db, repo.id, { level: "train" });
    const a = createTask(db, { repoId: repo.id, title: "First", scope: ["src/**"], status: "queued" });
    const b = createTask(db, { repoId: repo.id, title: "Second", scope: ["src/**"], status: "queued" });
    const ra = await runTask(deps(writer("src/a.ts")), a.id, new AbortController().signal);
    const rb = await runTask(deps(writer("src/b.ts")), b.id, new AbortController().signal);

    const [train] = listTrains(db);
    expect(train?.cars.map((c) => [c.title, c.state])).toEqual([
      ["First", "on"],
      ["Second", "on"],
    ]);
    expect(getRun(db, ra.runId)?.run.trainId).toBe(train?.id);
    expect(getRun(db, rb.runId)?.run.prUrl).toBeNull(); // no per-task PRs on the train
    const files = (await git(repoPath, "ls-tree", "-r", "--name-only", train?.branch ?? "")).stdout;
    expect(files).toContain("src/a.ts");
    expect(files).toContain("src/b.ts");
  });

  test("a task that breaks the train's tests comes off it", async () => {
    const repo = addRepo(db, {
      name: "acme",
      path: repoPath,
      defaultBranch: "main",
      testCommand: "test ! -f src/bad.ts",
    });
    updateRepo(db, repo.id, { level: "train" });
    // Passes its own checks (test command only runs on the train here) by writing a file the train rejects.
    const t = createTask(db, {
      repoId: repo.id,
      title: "Bad",
      scope: ["src/**"],
      status: "queued",
      testCommand: "true",
    });
    await runTask(deps(writer("src/bad.ts")), t.id, new AbortController().signal);
    const [train] = listTrains(db);
    expect(train?.cars[0]?.state).toBe("broke");
    expect((await git(repoPath, "ls-tree", "-r", "--name-only", train?.branch ?? "")).stdout).not.toContain(
      "src/bad.ts",
    );
  });
});

describe("ship to dev", () => {
  test("ships when every changed file is in the ship list, and Undo reverts it", async () => {
    const repo = addRepo(db, { name: "acme", path: repoPath, defaultBranch: "main" });
    updateRepo(db, repo.id, { level: "ship", shipBranch: "dev", allowShip: ["src/**"] });
    const t = createTask(db, { repoId: repo.id, title: "Shippable", scope: ["src/**"], status: "queued" });
    const out = await runTask(deps(writer("src/ship.ts")), t.id, new AbortController().signal);
    const run = getRun(db, out.runId)?.run;
    expect(run?.shipSha).toBeTruthy();
    expect(run?.bucket).toBe("shipped");
    expect((await git(repoPath, "ls-tree", "-r", "--name-only", "dev")).stdout).toContain("src/ship.ts");

    const fresh = getRepo(db, repo.id);
    if (!fresh || !run?.shipSha) throw new Error("setup");
    const undone = await undoShip(fresh, "dev", run.shipSha, false);
    expect(undone.ok).toBe(true);
    expect((await git(repoPath, "ls-tree", "-r", "--name-only", "dev")).stdout).not.toContain("src/ship.ts");
  });

  test("waits for you when a file is outside the ship list or marked always-ask", () => {
    const repo = {
      level: "ship",
      shipBranch: "dev",
      protectedBranches: ["main"],
      allowShip: ["src/**"],
      alwaysAsk: ["src/auth/**"],
    } as never;
    const ok = { verdict: "ready", evidenceMissing: [], confidence: 0.9 };
    expect(canShip({ repo, files: ["src/a.ts"], ...ok }).ok).toBe(true);
    expect(canShip({ repo, files: ["README.md"], ...ok }).reasons[0]).toContain("outside the ship list");
    expect(canShip({ repo, files: ["src/auth/x.ts"], ...ok }).reasons[0]).toContain("always wait for you");
    expect(canShip({ repo, files: ["src/a.ts"], ...ok, confidence: 0.5 }).ok).toBe(false);
    expect(
      canShip({ repo: { ...(repo as object), shipBranch: "main" } as never, files: ["src/a.ts"], ...ok }).reasons[0],
    ).toContain("protected");
  });

  test("falls back to a draft PR path when the gate says no", async () => {
    const repo = addRepo(db, { name: "acme", path: repoPath, defaultBranch: "main" });
    updateRepo(db, repo.id, { level: "ship", shipBranch: "dev", allowShip: ["docs/**"] });
    const t = createTask(db, { repoId: repo.id, title: "Not shippable", scope: ["src/**"], status: "queued" });
    const out = await runTask(deps(writer("src/x.ts")), t.id, new AbortController().signal);
    const run = getRun(db, out.runId)?.run;
    expect(run?.shipSha).toBeNull();
    expect(run?.verdict).toBe("ready");
    expect((await git(repoPath, "ls-tree", "-r", "--name-only", "dev")).stdout).not.toContain("src/x.ts");
  });
});

describe("reflexes", () => {
  test("Jev request and response shapes", async () => {
    let sent: { url: string; body: unknown; auth: string | null } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      sent = { url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("authorization") };
      return new Response(
        JSON.stringify({
          answers: {
            workflow: { type: "choice", choice: "quick", confidence: 0.9, probabilities: { quick: 0.9, planned: 0.1 } },
          },
        }),
      );
    }) as unknown as typeof fetch;
    const jev = new JevReflexes("sk-test", { fetch: fakeFetch });
    const a = await jev.ask("state", {
      workflow: { type: "choice", instructions: "x", criteria: { quick: "a", planned: "b" } },
    });
    expect(sent).toMatchObject({
      url: "https://api.typesafe.ai/v1/systemone",
      auth: "Bearer sk-test",
      body: { model: "jev-latest", state: "state" },
    });
    expect(a?.workflow).toMatchObject({ choice: "quick" });
  });
  test("rule confidence drops with held challenges and concerns", () => {
    expect(ruleConfidence({ review: READY, evidence: "", checksPassed: true })).toBeCloseTo(0.95);
    expect(
      ruleConfidence({
        review: { ...READY, challenges: [{ challenge: "x", held: true, detail: "" }] },
        evidence: "",
        checksPassed: true,
      }),
    ).toBeCloseTo(0.8);
    expect(ruleConfidence({ review: READY, evidence: "- MISSING: screenshots", checksPassed: true })).toBe(0.45);
  });
});
