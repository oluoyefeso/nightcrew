import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addRepo, createTask, type Db, getRepo, getRun, listTrains, openDb, updateRepo } from "@nightcrew/db";
import { ScriptedEngine } from "./engine";
import { git } from "./git";
import { boardTrain, canShip, pullCar, shipTask, undoShip } from "./landing";
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
    expect(ruleConfidence({ review: READY, evidenceMissing: 0, checksPassed: true })).toBeCloseTo(0.95);
    expect(
      ruleConfidence({
        review: { ...READY, challenges: [{ challenge: "x", held: true, detail: "" }] },
        evidenceMissing: 0,
        checksPassed: true,
      }),
    ).toBeCloseTo(0.8);
    expect(ruleConfidence({ review: READY, evidenceMissing: 1, checksPassed: true })).toBe(0.45);
  });
  test("rule confidence reads the missing-evidence count, not the rendered text", () => {
    // Value: protects=confidence branches on the structured missing count; fails_when=ruleConfidence goes back to sniffing "MISSING" in prose (a brief or note containing the word tanks confidence, a reworded summary hides gaps); why_new=O2 moved the input from text to a number; seam=none
    expect(ruleConfidence({ review: READY, evidenceMissing: 0, checksPassed: true })).toBeCloseTo(0.95);
    expect(ruleConfidence({ review: READY, evidenceMissing: 2, checksPassed: true })).toBe(0.45);
  });
});

describe("landing against a real origin", () => {
  const commit = (cwd: string, msg: string) =>
    git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", msg);
  const sha = async (ref: string, cwd = repoPath) => (await git(cwd, "rev-parse", ref)).stdout.trim();
  const tree = async (ref: string, cwd = repoPath) => (await git(cwd, "ls-tree", "-r", "--name-only", ref)).stdout;

  async function withOrigin() {
    const origin = join(dir, "origin.git");
    await git(dir, "init", "-q", "--bare", "-b", "main", origin);
    await git(repoPath, "remote", "add", "origin", origin);
    await git(repoPath, "push", "-q", "origin", "main", "dev");
    return origin;
  }
  /** A task branch off main with one file written. */
  async function taskBranch(name: string, file: string) {
    const wt = join(dir, `wt-${name.replace(/\//g, "-")}`);
    await git(repoPath, "worktree", "add", "-q", "-b", name, wt, "main");
    writeFileSync(join(wt, file), `export const v = "${name}";\n`);
    await git(wt, "add", "-A");
    await commit(wt, name);
    await git(repoPath, "worktree", "remove", "--force", wt);
  }
  /** Someone else pushes a commit to the origin's dev. */
  async function otherPush(origin: string, file: string) {
    const other = join(dir, `other-${file.replace(/\W/g, "-")}`);
    await git(dir, "clone", "-q", "-b", "dev", origin, other);
    writeFileSync(join(other, file), "theirs\n");
    await git(other, "add", "-A");
    await commit(other, "theirs");
    await git(other, "push", "-q", "origin", "dev");
  }
  function rejectPushes(origin: string, on = true) {
    const hook = join(origin, "hooks", "pre-receive");
    writeFileSync(hook, on ? "#!/bin/sh\necho 'pushes are closed' >&2\nexit 1\n" : "#!/bin/sh\nexit 0\n");
    chmodSync(hook, 0o755);
  }
  function shipRepo(over: { setupCommand?: string } = {}) {
    const r = addRepo(db, { name: "acme", path: repoPath, defaultBranch: "main", ...over });
    updateRepo(db, r.id, { level: "ship", shipBranch: "dev", allowShip: ["src/**"] });
    const fresh = getRepo(db, r.id);
    if (!fresh) throw new Error("setup");
    return fresh;
  }

  test("ships on top of what someone else pushed to dev", async () => {
    // Value: protects=the ship branch is fast-forwarded to origin before merging, so a ship never pushes onto a stale base; fails_when=branchWorktree stops fast-forwarding and the push is rejected (or work lands on an old dev); why_new=L1 the ship worktree never caught up with origin; seam=none
    const origin = await withOrigin();
    const repo = shipRepo();
    await taskBranch("crew/a", "src/a.ts");
    expect((await shipTask(repo, "crew/a", "A", true)).ok).toBe(true);
    await otherPush(origin, "src/theirs.ts");
    await taskBranch("crew/b", "src/b.ts");
    const b = await shipTask(repo, "crew/b", "B", true);
    expect(b).toMatchObject({ ok: true });
    const files = await tree("dev", origin);
    for (const f of ["src/a.ts", "src/theirs.ts", "src/b.ts"]) expect(files).toContain(f);
  });

  test("a local ship branch that diverged from origin fails with a clear error instead of throwing", async () => {
    // Value: protects=unpushed local commits plus a moved origin stop the ship with words, and the pipeline's draft-PR fallback gets a result, not an exception; fails_when=ff-only failures are ignored (merging on a stale base) or the error escapes as a throw; why_new=L1 divergence and L6 thrown landing errors; seam=none
    const origin = await withOrigin();
    const repo = shipRepo();
    await taskBranch("crew/a", "src/a.ts");
    expect((await shipTask(repo, "crew/a", "A", false)).ok).toBe(true); // local only
    await otherPush(origin, "src/theirs.ts");
    const before = await sha("dev");
    await taskBranch("crew/b", "src/b.ts");
    const b = await shipTask(repo, "crew/b", "B", true);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.error).toContain("aren't on origin");
    expect(await sha("dev")).toBe(before);
  });

  test("shipping a branch that's already on dev, or re-shipping after Undo, fails without moving dev", async () => {
    // Value: protects=a no-op merge is refused instead of recording someone else's sha, and rollbacks never drop an unrelated commit; fails_when=mergeInto returns HEAD after "Already up to date" or rollbacks go back to HEAD~1; why_new=L2 no-op merge and re-ship after undo; seam=none
    const repo = shipRepo();
    await taskBranch("crew/a", "src/a.ts");
    const shipped = await shipTask(repo, "crew/a", "A", false);
    if (!shipped.ok) throw new Error(shipped.error);
    const again = await shipTask(repo, "crew/a", "A", false);
    expect(again).toEqual({ ok: false, error: "Already on dev; nothing new to merge." });
    expect(await sha("dev")).toBe(shipped.sha);

    expect((await undoShip(repo, "dev", shipped.sha, false)).ok).toBe(true);
    const undone = await sha("dev");
    const reship = await shipTask(repo, "crew/a", "A", false);
    expect(reship.ok).toBe(false);
    expect(await sha("dev")).toBe(undone);
    expect(await tree("dev")).not.toContain("src/a.ts");
  });

  test("a pulled car whose push fails stays on the train", async () => {
    // Value: protects=pulling a car only counts when the train branch was pushed; on failure the local revert is undone; fails_when=pullCar ignores the push result and reports the car off while origin still has it; why_new=L3 push result was ignored; seam=none
    const origin = await withOrigin();
    const repo = shipRepo();
    const train = { branch: "crew/train-2026-10-10", cars: [] } as never;
    await taskBranch("crew/a", "src/a.ts");
    const boarded = await boardTrain(repo, train, "crew/a", "A");
    if (!boarded.ok) throw new Error(boarded.error);
    rejectPushes(origin);
    const pulled = await pullCar(repo, train, boarded.sha, true);
    expect(pulled.ok).toBe(false);
    if (!pulled.ok) expect(pulled.error).toContain("stays on");
    expect(await sha("crew/train-2026-10-10")).toBe(boarded.sha);
  });

  test("an Undo whose push fails leaves no stray revert for the next ship", async () => {
    // Value: protects=a failed Undo resets the local revert, so the next ship doesn't silently push it; fails_when=undoShip returns on push failure with the revert still committed locally; why_new=L4 partial-failure path; seam=none
    const origin = await withOrigin();
    const repo = shipRepo();
    await taskBranch("crew/a", "src/a.ts");
    const shipped = await shipTask(repo, "crew/a", "A", true);
    if (!shipped.ok) throw new Error(shipped.error);
    rejectPushes(origin);
    const undone = await undoShip(repo, "dev", shipped.sha, true);
    expect(undone.ok).toBe(false);
    if (!undone.ok) expect(undone.error).toContain("nothing was undone");
    expect(await sha("dev")).toBe(shipped.sha);

    rejectPushes(origin, false);
    await taskBranch("crew/b", "src/b.ts");
    expect((await shipTask(repo, "crew/b", "B", true)).ok).toBe(true);
    const files = await tree("dev", origin);
    expect(files).toContain("src/a.ts");
    expect(files).toContain("src/b.ts");
  });

  test("dependencies are reinstalled when a merge changes a manifest", async () => {
    // Value: protects=the ship/train worktree reinstalls when package.json or a lockfile changes, not only when node_modules is missing; fails_when=testsPass goes back to the node_modules-only check and tests run against stale deps; why_new=L5 deps were never refreshed; seam=none
    const log = join(dir, "setup.log");
    const repo = shipRepo({ setupCommand: `mkdir -p node_modules && echo run >> '${log}'` });
    const runs = () => readFileSync(log, "utf8").trim().split("\n").length;
    await taskBranch("crew/a", "src/a.ts");
    expect((await shipTask(repo, "crew/a", "A", false)).ok).toBe(true);
    expect(runs()).toBe(1); // fresh worktree, no node_modules
    await taskBranch("crew/b", "package.json");
    expect((await shipTask(repo, "crew/b", "B", false)).ok).toBe(true);
    expect(runs()).toBe(2); // manifest changed
    await taskBranch("crew/c", "src/c.ts");
    expect((await shipTask(repo, "crew/c", "C", false)).ok).toBe(true);
    expect(runs()).toBe(2); // nothing to reinstall
  });
});
