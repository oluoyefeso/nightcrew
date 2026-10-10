import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addRepo, createTask, type Db, getRepo, getRun, listTrains, openDb, updateRepo } from "@nightcrew/db";
import { ScriptedEngine } from "./engine";
import { baseWorktree, git } from "./git";
import {
  type Approved,
  boardTrain,
  canShip,
  landingFile,
  pullCar,
  setLandingHome,
  shipTask,
  undoShip,
} from "./landing";
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
  setLandingHome(join(dir, "data"));
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
    // Value: protects=confidence branches on the structured missing count; fails_when=ruleConfidence goes back to sniffing "MISSING" in prose (a brief or note containing the word tanks confidence, a reworded summary hides gaps); why_new=O2 moved the input from text to a number; seam=none
    expect(ruleConfidence({ review: READY, evidenceMissing: 0, checksPassed: true })).toBeCloseTo(0.95);
    expect(
      ruleConfidence({
        review: { ...READY, challenges: [{ challenge: "x", held: true, detail: "" }] },
        evidenceMissing: 0,
        checksPassed: true,
      }),
    ).toBeCloseTo(0.8);
    expect(ruleConfidence({ review: READY, evidenceMissing: 1, checksPassed: true })).toBe(0.45);
    expect(ruleConfidence({ review: READY, evidenceMissing: 2, checksPassed: true })).toBe(0.45);
  });
});

describe("landing against a real origin", () => {
  const ID = ["-c", "user.name=t", "-c", "user.email=t@t"];
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
  /** What the final gate approved for each task sha: its base and files. */
  const approvals = new Map<string, Approved>();
  const ap = (taskSha: string): Approved => approvals.get(taskSha) ?? { base: "", files: [] };
  /** A task branch off main with one file written. Returns its sha: landing goes by sha. */
  async function taskBranch(name: string, file: string) {
    const wt = join(dir, `wt-${name.replace(/\//g, "-")}`);
    await git(repoPath, "worktree", "add", "-q", "-b", name, wt, "main");
    writeFileSync(join(wt, file), `export const v = "${name}";\n`);
    await git(wt, "add", "-A");
    await commit(wt, name);
    const out = await sha("HEAD", wt);
    approvals.set(out, { base: await sha("main"), files: [file] });
    await git(repoPath, "worktree", "remove", "--force", wt);
    return out;
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
  /** A commit on top of `base` that NightCrew didn't make. */
  async function commitOnto(base: string, file: string) {
    const wt = join(dir, `onto-${file.replace(/\W/g, "-")}`);
    await git(repoPath, "worktree", "add", "-q", "--detach", wt, base);
    writeFileSync(join(wt, file), "not from NightCrew\n");
    await git(wt, "add", "-A");
    await commit(wt, "outside");
    const out = await sha("HEAD", wt);
    await git(repoPath, "worktree", "remove", "--force", wt);
    return out;
  }
  /** Pushes fail while fetches still work. (Simpler than a pre-receive hook in the test origin.) */
  async function rejectPushes(_origin: string, on = true) {
    if (on) await git(repoPath, "config", "remote.origin.pushurl", join(dir, "closed.git"));
    else await git(repoPath, "config", "--unset", "remote.origin.pushurl");
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
    const a = await taskBranch("crew/a", "src/a.ts");
    expect((await shipTask(repo, a, "A", true, ap(a))).ok).toBe(true);
    await otherPush(origin, "src/theirs.ts");
    const bSha = await taskBranch("crew/b", "src/b.ts");
    const b = await shipTask(repo, bSha, "B", true, ap(bSha));
    expect(b).toMatchObject({ ok: true });
    const files = await tree("dev", origin);
    for (const f of ["src/a.ts", "src/theirs.ts", "src/b.ts"]) expect(files).toContain(f);
  });

  test("a local ship branch that diverged from origin fails with a clear error instead of throwing", async () => {
    // Value: protects=unpushed local commits plus a moved origin stop the ship with words, and the pipeline's draft-PR fallback gets a result, not an exception; fails_when=ff-only failures are ignored (merging on a stale base) or the error escapes as a throw; why_new=L1 divergence and L6 thrown landing errors; seam=none
    const origin = await withOrigin();
    const repo = shipRepo();
    const a = await taskBranch("crew/a", "src/a.ts");
    expect((await shipTask(repo, a, "A", false, ap(a))).ok).toBe(true); // local only
    await otherPush(origin, "src/theirs.ts");
    const before = await sha("dev");
    const bSha = await taskBranch("crew/b", "src/b.ts");
    const b = await shipTask(repo, bSha, "B", true, ap(bSha));
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.error).toContain("aren't on origin");
    expect(await sha("dev")).toBe(before);
  });

  test("shipping a branch that's already on dev, or re-shipping after Undo, fails without moving dev", async () => {
    // Value: protects=a no-op merge is refused instead of recording someone else's sha, and rollbacks never drop an unrelated commit; fails_when=mergeInto returns HEAD after "Already up to date" or rollbacks go back to HEAD~1; why_new=L2 no-op merge and re-ship after undo; seam=none
    const repo = shipRepo();
    const a = await taskBranch("crew/a", "src/a.ts");
    const shipped = await shipTask(repo, a, "A", false, ap(a));
    if (!shipped.ok) throw new Error(shipped.error);
    const again = await shipTask(repo, a, "A", false, ap(a));
    expect(again).toEqual({ ok: false, error: "Already on dev; nothing new to merge." });
    expect(await sha("dev")).toBe(shipped.sha);

    expect((await undoShip(repo, "dev", shipped.sha, false)).ok).toBe(true);
    const undone = await sha("dev");
    const reship = await shipTask(repo, a, "A", false, ap(a));
    expect(reship.ok).toBe(false);
    expect(await sha("dev")).toBe(undone);
    expect(await tree("dev")).not.toContain("src/a.ts");
  });

  test("a pulled car whose push fails stays on the train", async () => {
    // Value: protects=pulling a car only counts when the train branch was pushed; on failure the local revert is undone; fails_when=pullCar ignores the push result and reports the car off while origin still has it; why_new=L3 push result was ignored; seam=none
    const origin = await withOrigin();
    const repo = shipRepo();
    const train = { branch: "crew/train-2026-10-10", cars: [] } as never;
    const a = await taskBranch("crew/a", "src/a.ts");
    const boarded = await boardTrain(repo, train, a, "A", true, ap(a));
    if (!boarded.ok) throw new Error(boarded.error);
    await rejectPushes(origin);
    const pulled = await pullCar(repo, train, boarded.sha, true);
    expect(pulled.ok).toBe(false);
    if (!pulled.ok) expect(pulled.error).toContain("stays on");
    expect(await sha("crew/train-2026-10-10")).toBe(boarded.sha);
  });

  test("an Undo whose push fails leaves no stray revert for the next ship", async () => {
    // Value: protects=a failed Undo resets the local revert, so the next ship doesn't silently push it; fails_when=undoShip returns on push failure with the revert still committed locally; why_new=L4 partial-failure path; seam=none
    const origin = await withOrigin();
    const repo = shipRepo();
    const a = await taskBranch("crew/a", "src/a.ts");
    const shipped = await shipTask(repo, a, "A", true, ap(a));
    if (!shipped.ok) throw new Error(shipped.error);
    await rejectPushes(origin);
    const undone = await undoShip(repo, "dev", shipped.sha, true);
    expect(undone.ok).toBe(false);
    if (!undone.ok) expect(undone.error).toContain("nothing was undone");
    expect(await sha("dev")).toBe(shipped.sha);

    await rejectPushes(origin, false);
    const b = await taskBranch("crew/b", "src/b.ts");
    expect((await shipTask(repo, b, "B", true, ap(b))).ok).toBe(true);
    const files = await tree("dev", origin);
    expect(files).toContain("src/a.ts");
    expect(files).toContain("src/b.ts");
  });

  test("dependencies are reinstalled when a merge changes a manifest", async () => {
    // Value: protects=the ship/train worktree reinstalls when package.json or a lockfile changes, not only when node_modules is missing; fails_when=testsPass goes back to the node_modules-only check and tests run against stale deps; why_new=L5 deps were never refreshed; seam=none
    const log = join(dir, "setup.log");
    const repo = shipRepo({ setupCommand: `mkdir -p node_modules && echo run >> '${log}'` });
    const runs = () => readFileSync(log, "utf8").trim().split("\n").length;
    const a = await taskBranch("crew/a", "src/a.ts");
    expect((await shipTask(repo, a, "A", false, ap(a))).ok).toBe(true);
    expect(runs()).toBe(1); // fresh worktree, no node_modules
    const b = await taskBranch("crew/b", "package.json");
    expect((await shipTask(repo, b, "B", false, ap(b))).ok).toBe(true);
    expect(runs()).toBe(2); // manifest changed
    const c = await taskBranch("crew/c", "src/c.ts");
    expect((await shipTask(repo, c, "C", false, ap(c))).ok).toBe(true);
    expect(runs()).toBe(2); // nothing to reinstall
  });

  test("a ship branch moved onto a commit NightCrew didn't make is refused, not pushed", async () => {
    // Value: protects=local-only commits on the ship branch that NightCrew didn't record stop the ship instead of riding along in its push; fails_when=branchWorktree goes back to a bare ff-only (a no-op when local is ahead) and pushes whatever local dev points at; why_new=G3 an agent could move the local ship ref; seam=none
    const origin = await withOrigin();
    const repo = shipRepo();
    const a = await taskBranch("crew/a", "src/a.ts");
    expect((await shipTask(repo, a, "A", true, ap(a))).ok).toBe(true);
    await git(repoPath, "update-ref", "refs/heads/dev", await commitOnto("dev", "evil.txt"));
    const bSha = await taskBranch("crew/b", "src/b.ts");
    const b = await shipTask(repo, bSha, "B", true, ap(bSha));
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.error).toContain("NightCrew didn't make");
    expect(await tree("dev", origin)).not.toContain("evil.txt");
    expect(await tree("dev", origin)).not.toContain("src/b.ts");
  });

  test("an interrupted train merge is undone before the next car boards", async () => {
    // Value: protects=a merge NightCrew started but never finished (crash between merge and test or rollback) is reset from the marker on the next use; fails_when=branchWorktree ignores the landing marker and the half-landed car stays on the train untested; why_new=G3 train branches can be ahead of origin, so reuse can't reset to origin; seam=none
    const repo = shipRepo();
    const train = { branch: "crew/train-2026-10-10", cars: [] } as never;
    const a = await taskBranch("crew/a", "src/a.ts");
    expect((await boardTrain(repo, train, a, "A", false, ap(a))).ok).toBe(true);
    const wt = join(repoPath, ".worktrees", "_crew-train-2026-10-10");
    // The marker lives in NightCrew's data folder, not the worktree's git dir.
    const marker = landingFile(repo, "crew/train-2026-10-10", "landing");
    expect(marker.startsWith(join(dir, "data", "landing"))).toBe(true);
    const x = await taskBranch("crew/x", "src/x.ts");
    writeFileSync(marker, `${await sha("HEAD", wt)} merge ${x}\n`);
    await git(wt, "-c", "user.name=t", "-c", "user.email=t@t", "merge", "--no-ff", "--no-edit", x);
    const b = await taskBranch("crew/b", "src/b.ts");
    expect((await boardTrain(repo, train, b, "B", false, ap(b))).ok).toBe(true);
    const files = await tree("crew/train-2026-10-10");
    expect(files).toContain("src/a.ts");
    expect(files).toContain("src/b.ts");
    expect(files).not.toContain("src/x.ts");
    expect(existsSync(marker)).toBe(false);
  });

  test("with publishing off, landing doesn't fetch or catch up with origin", async () => {
    // Value: protects=a dry run never touches the network and lands on the local branch as it is; fails_when=branchWorktree fetches or fast-forwards when publish is false; why_new=G3 publish wasn't threaded into branchWorktree; seam=none
    const origin = await withOrigin();
    const repo = shipRepo();
    const tracked = await sha("refs/remotes/origin/dev");
    await otherPush(origin, "src/theirs.ts");
    const a = await taskBranch("crew/a", "src/a.ts");
    expect((await shipTask(repo, a, "A", false, ap(a))).ok).toBe(true);
    expect(await sha("refs/remotes/origin/dev")).toBe(tracked);
    expect(await tree("dev")).not.toContain("src/theirs.ts");
  });

  test("dependencies the catch-up with origin brought in are installed", async () => {
    // Value: protects=a manifest change pulled in by the fast-forward to origin triggers a reinstall before the tests; fails_when=testsPass diffs from the pre-merge sha (after the fast-forward) and runs tests on stale deps; why_new=G4 the ff's own changes were never diffed; seam=none
    const origin = await withOrigin();
    const log = join(dir, "setup.log");
    const repo = shipRepo({ setupCommand: `mkdir -p node_modules && echo run >> '${log}'` });
    const runs = () => readFileSync(log, "utf8").trim().split("\n").length;
    const a = await taskBranch("crew/a", "src/a.ts");
    expect((await shipTask(repo, a, "A", true, ap(a))).ok).toBe(true);
    expect(runs()).toBe(1);
    await otherPush(origin, "package.json");
    const b = await taskBranch("crew/b", "src/b.ts");
    expect((await shipTask(repo, b, "B", true, ap(b))).ok).toBe(true);
    expect(runs()).toBe(2);
  });
  test("lands the task's sha, whatever planted refs with the same short names say", async () => {
    // Value: protects=ships merge the fetched sha and catch up with origin through explicit refs/remotes, so a planted refs/<branch> or refs/heads/origin/<ship> can't swap what lands; fails_when=mergeInto or branchWorktree go back to short names (refs/crew/a shadows refs/heads/crew/a; refs/heads/origin/dev shadows refs/remotes/origin/dev); why_new=cycle-3 review: landing by short branch name; seam=none
    const origin = await withOrigin();
    const repo = shipRepo();
    const a = await taskBranch("crew/a", "src/a.ts");
    const evil = await commitOnto("main", "src/evil.ts");
    await git(repoPath, "update-ref", "refs/crew/a", evil);
    await git(repoPath, "update-ref", "refs/heads/origin/dev", evil);
    expect(await shipTask(repo, "crew/a", "A", true, ap(a))).toEqual({
      ok: false,
      error: "NightCrew lands a task by its commit sha only.",
    });
    const shipped = await shipTask(repo, a, "A", true, ap(a));
    expect(shipped.ok).toBe(true);
    for (const ref of ["dev", "refs/heads/dev"]) {
      const files = await tree(ref, ref === "dev" ? origin : repoPath);
      expect(files).toContain("src/a.ts");
      expect(files).not.toContain("src/evil.ts");
    }
  });

  test("a train task's branch is pushed from your repo by sha, and boards by sha", async () => {
    // Value: protects=the task branch on origin is exactly the commit fetched into your repo and checked there, and the train merges that same sha; fails_when=the push goes back to `push origin <branch>` (a planted refs/<branch> wins the short-name lookup) or boarding merges a branch name; why_new=D12 landing by sha; seam=none
    const origin = await withOrigin();
    const repo = addRepo(db, { name: "acme", path: repoPath, defaultBranch: "main", testCommand: "true" });
    updateRepo(db, repo.id, { level: "train" });
    const t = createTask(db, { repoId: repo.id, title: "Train car", scope: ["src/**"], status: "queued" });
    await git(repoPath, "update-ref", `refs/${t.branch}`, await commitOnto("main", "src/evil.ts"));
    const out = await runTask({ ...deps(writer("src/car.ts")), publish: true }, t.id, new AbortController().signal);
    expect(out.status).toBe("complete");
    const fetched = await sha(`refs/nightcrew/tasks/${t.id}`);
    expect(await sha(`refs/heads/${t.branch}`, origin)).toBe(fetched);
    const [train] = listTrains(db);
    expect(train?.cars[0]?.state).toBe("on");
    const files = await tree(`refs/heads/${train?.branch}`);
    expect(files).toContain("src/car.ts");
    expect(files).not.toContain("src/evil.ts");
    expect((await git(repoPath, "merge-base", "--is-ancestor", fetched, `refs/heads/${train?.branch}`)).ok).toBe(true);
  });

  test("hooks never run when NightCrew commits, checks out, merges or pushes", async () => {
    // Value: protects=NightCrew's git ignores a relative core.hooksPath (husky's .husky/_) and planted hooks in your repo, its worktrees and the task's clone; fails_when=any NightCrew git call (worktree add, commit, merge, push, update-ref) loses -c core.hooksPath=/dev/null; why_new=cycle-3 review: host git ran planted hooks; seam=none
    const marker = join(dir, "hooks-ran");
    const hooks = [
      "pre-commit",
      "prepare-commit-msg",
      "commit-msg",
      "post-commit",
      "post-checkout",
      "pre-merge-commit",
      "post-merge",
      "pre-push",
      "reference-transaction",
      "post-rewrite",
    ];
    mkdirSync(join(repoPath, ".husky", "_"), { recursive: true });
    for (const h of hooks)
      writeFileSync(join(repoPath, ".husky", "_", h), `#!/bin/sh\necho ${h} >> '${marker}'\n`, { mode: 0o755 });
    await git(repoPath, "add", "-A");
    await commit(repoPath, "husky");
    await git(repoPath, "branch", "-f", "dev", "main");
    const origin = await withOrigin();
    await git(repoPath, "config", "core.hooksPath", ".husky/_");
    const repo = shipRepo();
    const t = createTask(db, { repoId: repo.id, title: "Hooked", scope: ["src/**"], status: "queued" });
    const engine = new ScriptedEngine({
      implement: async (req) => {
        // The agent points its clone at the planted hooks too.
        await git(req.cwd, "config", "core.hooksPath", ".husky/_");
        writeFileSync(join(req.cwd, "src", "hooked.ts"), "export const h = 1;\n");
        return { text: "Done." };
      },
      review: () => ({ structured: READY }),
    });
    const out = await runTask({ ...deps(engine), publish: true }, t.id, new AbortController().signal);
    expect(out.status).toBe("complete");
    expect(getRun(db, out.runId)?.run.shipSha).toBeTruthy();
    expect(await tree("dev", origin)).toContain("src/hooked.ts");
    const base = await baseWorktree(repoPath, await sha("main"), "hooks");
    await base.remove();
    expect(existsSync(marker) ? readFileSync(marker, "utf8") : "").toBe("");
  });
  test("a task whose history takes in the ship branch's tip can't undo that branch's changes", async () => {
    // Value: protects=the merge base git uses for a ship can't be moved by the agent: a task tip made a merge with dev's tip (the clone sees your repo's objects) is refused, so the merge can't revert dev changes the gate never diffed; fails_when=mergeInto merges without checking that every merge base sits at or under the pinned base; why_new=G1 probed merge-base manipulation; seam=none
    const repo = shipRepo();
    const base = await sha("main");
    // dev hardens a file after the task's base.
    const hardened = "export const x = 1;\nexport const strict = true;\n";
    const wt = join(dir, "wt-dev");
    await git(repoPath, "worktree", "add", "-q", wt, "dev");
    writeFileSync(join(wt, "src", "index.ts"), hardened);
    await git(wt, "add", "-A");
    await commit(wt, "harden");
    await git(repoPath, "worktree", "remove", "--force", wt);
    const devTip = await sha("dev");
    // The agent edits the same file from the base, then makes its tip a merge with dev's tip.
    const agent = await commitOnto(base, "src/index.ts");
    const tree = await sha(`${agent}^{tree}`);
    const evil = (
      await git(repoPath, ...ID, "commit-tree", tree, "-p", agent, "-p", devTip, "-m", "merge dev")
    ).stdout.trim();
    // The gate diffs base..evil and sees only src/index.ts, inside the ship list.
    const files = (await git(repoPath, "diff", "--name-only", base, evil)).stdout.trim().split("\n");
    expect(files).toEqual(["src/index.ts"]);
    const shipped = await shipTask(repo, evil, "Evil", false, { base, files });
    expect(shipped.ok).toBe(false);
    if (!shipped.ok) expect(shipped.error).toContain("checks didn't cover");
    expect(await sha("dev")).toBe(devTip);
    expect((await git(repoPath, "show", "dev:src/index.ts")).stdout).toBe(hardened);
  });

  test("a merge that lands files the gate didn't approve is taken back off", async () => {
    // Value: protects=after merging, the files that actually changed on the ship branch must be ones the gate approved (or ones the default branch brought in), and the re-run checks must pass, else the branch is reset; fails_when=mergeInto trusts the merge without diffing what landed, or ignores the recheck; why_new=G1 post-merge check; seam=none
    const repo = shipRepo();
    const before = await sha("dev");
    const a = await taskBranch("crew/a", "src/a.ts");
    const unapproved = await shipTask(repo, a, "A", false, { base: ap(a).base, files: ["src/other.ts"] });
    expect(unapproved.ok).toBe(false);
    if (!unapproved.ok) expect(unapproved.error).toContain("never saw (src/a.ts)");
    expect(await sha("dev")).toBe(before);
    const rechecked = await shipTask(repo, a, "A", false, { ...ap(a), recheck: () => "Scope changed." });
    expect(rechecked.ok).toBe(false);
    if (!rechecked.ok) expect(rechecked.error).toContain("Scope changed.");
    expect(await sha("dev")).toBe(before);
  });

  test("a ship branch behind the default branch still ships, with the default branch's changes", async () => {
    // Value: protects=the post-merge file check allows changes the default branch made between the ship branch and the task's base, so a lagging dev doesn't block every ship; fails_when=checkLanded requires every landed file to be in the gate's list; why_new=G1 post-merge check could refuse legitimate ships; seam=none
    const repo = shipRepo();
    writeFileSync(join(repoPath, "README.md"), "moved on\n");
    await git(repoPath, "add", "-A");
    await commit(repoPath, "main moves");
    const a = await taskBranch("crew/a", "src/a.ts");
    const shipped = await shipTask(repo, a, "A", false, ap(a));
    expect(shipped).toMatchObject({ ok: true });
    const files = await tree("dev");
    expect(files).toContain("README.md");
    expect(files).toContain("src/a.ts");
  });

  test("a setup that fails on the ship branch says so, with its output", async () => {
    // Value: protects=a failing dependency install on the integration branch is reported as a setup failure with a tail of its output, not as the task breaking the tests; fails_when=testsPass ignores the setup result and blames the task; why_new=cycle-3 review: setup failures read as test failures; seam=none
    const repo = shipRepo({ setupCommand: "echo 'registry unreachable' >&2; exit 3" });
    const a = await taskBranch("crew/a", "src/a.ts");
    const shipped = await shipTask(repo, a, "A", false, ap(a));
    expect(shipped.ok).toBe(false);
    if (!shipped.ok) {
      expect(shipped.error).toContain("Setup failed on dev");
      expect(shipped.error).toContain("registry unreachable");
    }
    expect(await tree("dev")).not.toContain("src/a.ts");
  });
});
