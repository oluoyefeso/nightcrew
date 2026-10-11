import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addRepo,
  createTask,
  type Db,
  getRepo,
  getRun,
  listRunEvents,
  listTrains,
  markUndone,
  openDb,
  setCarState,
  updateRepo,
} from "@nightcrew/db";
import { ScriptedEngine } from "./engine";
import { baseWorktree, git } from "./git";
import {
  type Approved,
  boardTrain,
  canShip,
  landingFile,
  publishTrain,
  pullCar,
  setLandingHome,
  shipTask,
  undoShip,
} from "./landing";
import { gateBase, runTask } from "./pipeline";
import type { ReviewOutput } from "./prompts";
import { JevReflexes, ruleConfidence, ruleWorkflow } from "./reflexes";
import { startFreshHint, taskRef, wipRef, workspaceDir } from "./workspace";

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

    // Value: protects=Ship to dev waits for you on a non-ready verdict, missing evidence, a non-ship level, no ship branch or an empty ship list; fails_when=one of those canShip reasons is dropped and unreviewed work merges itself; why_new=only paths, always-ask, confidence and protected rows existed; seam=none; no_claim=the pure gate only (pipeline wiring covered by the ship-to-dev runTask tests)
    const blocked: [Omit<Partial<Parameters<typeof canShip>[0]>, "repo"> & { repo?: object }, string][] = [
      [{ verdict: "needs_eyes" }, "Skeptic wants a person"],
      [{ verdict: null }, "Skeptic wants a person"],
      [{ evidenceMissing: ["screenshots"] }, "evidence is missing"],
      [{ repo: { level: "train" } }, "isn't at the Ship to dev level"],
      [{ repo: { shipBranch: null } }, "No ship branch"],
      [{ repo: { allowShip: [] } }, "No paths are allowed to ship"],
    ];
    for (const [over, reason] of blocked) {
      const check = canShip({
        files: ["src/a.ts"],
        ...ok,
        ...over,
        repo: { ...(repo as object), ...over.repo } as never,
      });
      expect(check.ok).toBe(false);
      expect(check.reasons.join(" ")).toContain(reason);
    }
    // No confidence score (no reflexes) and exactly the 80% bar both pass.
    expect(canShip({ repo, files: ["src/a.ts"], ...ok, confidence: null }).ok).toBe(true);
    expect(canShip({ repo, files: ["src/a.ts"], ...ok, confidence: 0.8 }).ok).toBe(true);
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

  test("the train's push and its one PR list the cars on it and the ones taken off", async () => {
    // Value: protects=publishTrain pushes the train to origin and opens one draft PR whose body ticks only cars still on and names pulled/broken ones as taken off;
    // fails_when=pulled cars are listed as on, the PR goes up before the push, or a failed push is swallowed instead of thrown; why_new=publishTrain had no test (crew.test.ts stubs it);
    // seam=none; no_claim=GitHub acceptance of the PR (fake gh first on PATH records the create call; bare local origin stands in for GitHub)
    const origin = await withOrigin();
    const repo = shipRepo();
    const branch = "crew/train-2026-10-10";
    const a = await taskBranch("crew/a", "src/a.ts");
    const b = await taskBranch("crew/b", "src/b.ts");
    const onA = await boardTrain(repo, { branch, cars: [] } as never, a, "Add A", true, ap(a));
    if (!onA.ok) throw new Error(onA.error);
    const onB = await boardTrain(repo, { branch, cars: [] } as never, b, "Add B", true, ap(b));
    if (!onB.ok) throw new Error(onB.error);
    expect(await pullCar(repo, { branch, cars: [] } as never, onB.sha, false)).toEqual({ ok: true });
    expect((await git(origin, "rev-parse", "--verify", "--quiet", branch)).ok).toBe(false);

    const out = join(dir, "gh-out");
    const bin = join(dir, "bin");
    mkdirSync(out);
    mkdirSync(bin);
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh
echo "$*" >> '${out}/calls'
case "$2" in
  list) echo '[]' ;;
  create)
    while [ $# -gt 0 ]; do
      case "$1" in
        --body-file) cp "$2" '${out}/body.md' ;;
        --title) printf '%s' "$2" > '${out}/title' ;;
        --head) printf '%s' "$2" > '${out}/head' ;;
      esac
      shift
    done
    echo https://github.com/o/acme/pull/9 ;;
  *) exit 2 ;;
esac
`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      const train = {
        nightId: "2026-10-10",
        branch,
        cars: [
          { title: "Add A", state: "on", mergeSha: onA.sha },
          { title: "Add B", state: "pulled", mergeSha: onB.sha },
          { title: "Add C", state: "broke", mergeSha: "" },
        ],
      } as never;
      const pr = await publishTrain(repo, train);
      expect(pr).toMatchObject({ prUrl: "https://github.com/o/acme/pull/9", prNumber: 9 });
      expect(pr?.warning).toBeUndefined();
      // Pushed before the PR: origin's train has A and not the pulled B.
      const files = await tree(branch, origin);
      expect(files).toContain("src/a.ts");
      expect(files).not.toContain("src/b.ts");
      expect(readFileSync(join(out, "head"), "utf8")).toBe(branch);
      expect(readFileSync(join(out, "title"), "utf8")).toBe("Daily train 2026-10-10: 1 task");
      const body = readFileSync(join(out, "body.md"), "utf8");
      expect(body).toContain("Today's train for acme: 1 task, tested together.");
      expect(body).toContain("- [x] Add A");
      expect(body).not.toContain("- [x] Add B");
      expect(body).not.toContain("- [x] Add C");
      expect(body).toContain("Taken off the train:\n- Add B (pulled by you)\n- Add C (broke the tests)");

      // A train with nothing on it publishes nothing.
      const calls = readFileSync(join(out, "calls"), "utf8");
      expect(
        await publishTrain(repo, {
          nightId: "2026-10-10",
          branch,
          cars: [{ title: "Add B", state: "pulled" }],
        } as never),
      ).toBeNull();
      expect(readFileSync(join(out, "calls"), "utf8")).toBe(calls);

      // A push that fails throws, and no PR call is made.
      await rejectPushes(origin);
      await expect(publishTrain(repo, train)).rejects.toThrow("Couldn't push the train");
      expect(readFileSync(join(out, "calls"), "utf8")).toBe(calls);
    } finally {
      process.env.PATH = path;
    }
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
    if (!unapproved.ok) expect(unapproved.error).toContain("outside what the task's checks covered (src/a.ts)");
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

  test("what one landing's tests leave in the ship checkout is gone before the next one's tests run", async () => {
    // Value: protects=untracked files a landing's test run leaves in the long-lived integration checkout (build output, stray files) can't change the next task's test result, while installed dependencies stay; fails_when=branchWorktree only resets tracked files between landings; why_new=Z4; seam=none
    const r = addRepo(db, {
      name: "acme",
      path: repoPath,
      defaultBranch: "main",
      testCommand: "test ! -e stray.txt && touch stray.txt",
    });
    updateRepo(db, r.id, { level: "ship", shipBranch: "dev", allowShip: ["src/**"] });
    const repo = getRepo(db, r.id);
    if (!repo) throw new Error("setup");
    const a = await taskBranch("crew/a", "src/a.ts");
    expect(await shipTask(repo, a, "A", false, ap(a))).toMatchObject({ ok: true });
    const checkout = join(repoPath, ".worktrees", "_dev");
    expect(existsSync(join(checkout, "stray.txt"))).toBe(true);
    mkdirSync(join(checkout, "node_modules", "dep"), { recursive: true });
    const b = await taskBranch("crew/b", "src/b.ts");
    expect(await shipTask(repo, b, "B", false, ap(b))).toMatchObject({ ok: true });
    expect(existsSync(join(checkout, "node_modules", "dep"))).toBe(true);
  });

  test("a second Undo or Pull that waited on the lock says it's already done", async () => {
    // Value: protects=two Undo (or Pull) clicks for one landing: the second, re-checked inside the repo lock, says it's already undone instead of failing with a confusing revert error; fails_when=undoShip/pullCar revert again without looking for their own revert on the branch; why_new=Z6; seam=none
    const repo = shipRepo();
    const a = await taskBranch("crew/a", "src/a.ts");
    const shipped = await shipTask(repo, a, "A", false, ap(a));
    if (!shipped.ok) throw new Error(shipped.error);
    const undos = await Promise.all([
      undoShip(repo, "dev", shipped.sha, false),
      undoShip(repo, "dev", shipped.sha, false),
    ]);
    expect(undos[0].ok).toBe(true);
    expect(undos[1]).toEqual({ ok: false, error: "That ship is already undone." });
    const dev = await sha("dev");

    const train = { id: "t", repoId: repo.id, nightId: "n", branch: "crew/train-n", cars: [] } as never;
    const b = await taskBranch("crew/b", "src/b.ts");
    const boarded = await boardTrain(repo, train, b, "B", false, ap(b));
    if (!boarded.ok) throw new Error(boarded.error);
    const pulls = await Promise.all([
      pullCar(repo, train, boarded.sha, false),
      pullCar(repo, train, boarded.sha, false),
    ]);
    expect(pulls[0].ok).toBe(true);
    expect(pulls[1]).toEqual({ ok: false, error: "It's already off the train." });
    expect(await tree("crew/train-n")).not.toContain("src/b.ts");
    expect(await sha("dev")).toBe(dev);
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

describe("running a task again after it landed", () => {
  const sha = async (ref: string) => (await git(repoPath, "rev-parse", ref)).stdout.trim();
  const tree = async (ref: string) => (await git(repoPath, "ls-tree", "-r", "--name-only", ref)).stdout;
  const ID = ["-c", "user.name=t", "-c", "user.email=t@t"];
  /** One run that writes these files in the task's clone. */
  const writes = (...files: string[]) =>
    new ScriptedEngine({
      implement: (req) => {
        for (const f of files) {
          mkdirSync(join(req.cwd, f, ".."), { recursive: true });
          writeFileSync(join(req.cwd, f), `export const v = "${f}";\n`);
        }
        return { text: "Done." };
      },
      review: () => ({ structured: READY }),
    });
  const run = (engine: ScriptedEngine, taskId: string) => runTask(deps(engine), taskId, new AbortController().signal);
  const texts = (runId: string) => listRunEvents(db, runId).map((e) => e.text);
  function shipRepo() {
    const r = addRepo(db, { name: "acme", path: repoPath, defaultBranch: "main" });
    updateRepo(db, r.id, { level: "ship", shipBranch: "dev", allowShip: ["src/**"] });
    return r;
  }
  function trainRepo() {
    const r = addRepo(db, { name: "acme", path: repoPath, defaultBranch: "main" });
    updateRepo(db, r.id, { level: "train" });
    return r;
  }
  const fresh = (id: string) => {
    const r = getRepo(db, id);
    if (!r) throw new Error("setup");
    return r;
  };

  test("a shipped task sent back ships again: the gate sees the whole task, only the new work lands", async () => {
    // Value: protects=a re-run of a task already on the ship branch merges on top of its own landed tip, while scope and canShip check the task's whole change against main; fails_when=the merge-base rule refuses the task's own ship, or the gate checks only the delta; why_new=D16 ship send back; seam=none
    const repo = shipRepo();
    const t = createTask(db, { repoId: repo.id, title: "Ship twice", scope: ["src/**"], status: "queued" });
    const first = await run(writes("src/a.ts"), t.id);
    expect(getRun(db, first.runId)?.run.shipSha).toBeTruthy();
    const second = await run(writes("src/b.ts"), t.id);
    const shipped = getRun(db, second.runId)?.run;
    expect(shipped?.shipSha).toBeTruthy();
    expect(shipped?.changedFiles).toBe(2);
    expect(
      (await git(repoPath, "diff", "--name-only", `${shipped?.shipSha}^1`, `${shipped?.shipSha}`)).stdout.trim(),
    ).toBe("src/b.ts");
  });

  test("a re-run after Undo is refused with how to start fresh, and dev stays put", async () => {
    // Value: protects=after Undo reverted a task's ship, a re-run that builds on the undone tip is refused instead of landing only its new commits (which would leave the earlier work reverted while reporting a ship); fails_when=the merge-base rule accepts an ancestor of the branch whatever NightCrew's records say; why_new=D16 bug (b) after undoShip; seam=none
    const repo = shipRepo();
    const t = createTask(db, { repoId: repo.id, title: "Undone", scope: ["src/**"], status: "queued" });
    const first = await run(writes("src/a.ts"), t.id);
    const shipSha = getRun(db, first.runId)?.run.shipSha as string;
    expect((await undoShip(fresh(repo.id), "dev", shipSha, false)).ok).toBe(true);
    markUndone(db, first.runId);
    const dev = await sha("dev");
    const engine = writes("src/b.ts");
    const second = await run(engine, t.id);
    expect(getRun(db, second.runId)?.run.shipSha).toBeNull();
    expect(second.status).toBe("failed");
    expect(second.reason).toContain(
      "This task's earlier work was taken off dev (pulled or undone), and this run would build on it. Start the task fresh: delete the task's workspace at",
    );
    expect(engine.calls).toEqual([]);
    expect(await sha("dev")).toBe(dev);
  });

  test("a re-run after its car was pulled is refused, and the train stays put", async () => {
    // Value: protects=after a car is pulled, a re-run of that task doesn't board the train with only its new commits; fails_when=pulled cars still count as landed, or ancestry alone decides; why_new=D16 bug (b) after pullCar; seam=none
    const repo = trainRepo();
    const t = createTask(db, { repoId: repo.id, title: "Pulled", scope: ["src/**"], status: "queued" });
    const first = await run(writes("src/a.ts"), t.id);
    const [train] = listTrains(db);
    const car = train?.cars[0];
    if (!train || !car) throw new Error("not boarded");
    expect((await pullCar(fresh(repo.id), train, car.mergeSha, false)).ok).toBe(true);
    setCarState(db, train.id, first.runId, "pulled");
    const lane = await sha(train.branch);
    const second = await run(writes("src/b.ts"), t.id);
    expect(second.status).toBe("failed");
    expect(second.reason).toContain(`This task's earlier work was taken off ${train.branch} (pulled or undone)`);
    expect(await sha(train.branch)).toBe(lane);
  });

  /** Two runs of one task on today's train, then the first car pulled. Returns what the probes need. */
  async function olderCarPulled() {
    const repo = trainRepo();
    const t = createTask(db, { repoId: repo.id, title: "Two cars", scope: ["src/**"], status: "queued" });
    const first = await run(writes("src/a.ts"), t.id);
    const second = await run(writes("src/b.ts"), t.id);
    const [train] = listTrains(db);
    const car1 = train?.cars.find((c) => c.runId === first.runId);
    const car2 = train?.cars.find((c) => c.runId === second.runId);
    if (!train || car1?.state !== "on" || car2?.state !== "on") throw new Error("not boarded");
    expect((await pullCar(fresh(repo.id), train, car1.mergeSha, false)).ok).toBe(true);
    setCarState(db, train.id, first.runId, "pulled");
    const t1 = await sha(`${car1.mergeSha}^2`);
    const t2 = await sha(`${car2.mergeSha}^2`);
    return { repo, t, train, car1, t1, t2 };
  }
  /** A commit on top of `parent` that adds `file`, as a task's next run would. */
  async function next(parent: string, file: string) {
    const wt = join(dir, `wt-next-${file.replace(/\W/g, "-")}`);
    await git(repoPath, "worktree", "add", "-q", "--detach", wt, parent);
    mkdirSync(join(wt, file, ".."), { recursive: true });
    writeFileSync(join(wt, file), "next\n");
    await git(wt, "add", "-A");
    await git(wt, ...ID, "commit", "-qm", "next");
    const out = (await git(wt, "rev-parse", "HEAD")).stdout.trim();
    await git(repoPath, "worktree", "remove", "--force", wt);
    return out;
  }

  test("pulling an older car while a later car of the task is on: a re-run is refused before any agent runs", async () => {
    // Value: protects=a re-run on top of a later car that's still on never lands with the pulled car's work silently left reverted; fails_when=the start of a run doesn't check pulled landings, or the merge base being a landed tip is trusted before takenOff; why_new=Z1 probe (a); seam=none
    const { t, train } = await olderCarPulled();
    const lane = await sha(train.branch);
    const engine = writes("src/c.ts");
    const third = await run(engine, t.id);
    expect(third.status).toBe("failed");
    expect(third.reason).toContain(
      `This task's earlier work was taken off ${train.branch} (pulled or undone), and this run would build on it. Start the task fresh: delete the task's workspace at`,
    );
    expect(engine.calls).toEqual([]);
    expect(await sha(train.branch)).toBe(lane);
    expect(await tree(train.branch)).not.toContain("src/c.ts");
  });

  test("the train refuses a merge on top of a later car when an older car of the task was pulled", async () => {
    // Value: protects=even past the start check, landing checks taken-off tips before trusting a landed tip as the merge base, with the records read inside the repo lock; fails_when=mergeInto skips a merge base found in landed before looking at takenOff; why_new=Z1 probe (a) at the landing; seam=none
    const { repo, train, car1, t1, t2 } = await olderCarPulled();
    const lane = await sha(train.branch);
    const tip = await next(t2, "src/c.ts");
    const base = await gateBase(repoPath, "main", tip);
    const boarded = await boardTrain(fresh(repo.id), train, tip, "Again", false, {
      base,
      files: ["src/a.ts", "src/b.ts", "src/c.ts"],
      earlier: () => ({ landed: [t2], takenOff: [{ tip: t1, merge: car1.mergeSha, branch: train.branch }] }),
    });
    expect(boarded.ok).toBe(false);
    if (!boarded.ok) expect(boarded.error).toContain(`taken off ${train.branch} (pulled or undone)`);
    expect(await sha(train.branch)).toBe(lane);
  });

  test("after the train with a pulled car is merged into main, a re-run is refused, and a fresh start lands", async () => {
    // Value: protects=once the revert reaches main, the gate base moves onto the pulled tip and the ancestor check passes, so taken-off tips are checked first; and a task started fresh from a main that holds the revert isn't refused forever; fails_when=takenOff is only looked at after the ancestor check, or the revert on main doesn't exempt a fresh start; why_new=Z1 probe (b); seam=none
    const repo = trainRepo();
    const t = createTask(db, { repoId: repo.id, title: "Merged train", scope: ["src/**"], status: "queued" });
    const first = await run(writes("src/a.ts"), t.id);
    const [train] = listTrains(db);
    const car = train?.cars[0];
    if (!train || car?.state !== "on") throw new Error("not boarded");
    expect((await pullCar(fresh(repo.id), train, car.mergeSha, false)).ok).toBe(true);
    setCarState(db, train.id, first.runId, "pulled");
    await git(repoPath, ...ID, "merge", "-q", "--no-ff", "-m", "Merge the train", train.branch);
    const t1 = await sha(`${car.mergeSha}^2`);
    const lane = await sha(train.branch);

    // At the landing: the gate base is the pulled tip itself.
    const tip = await next(t1, "src/b.ts");
    const base = await gateBase(repoPath, "main", tip);
    expect(base).toBe(t1);
    const boarded = await boardTrain(fresh(repo.id), train, tip, "Again", false, {
      base,
      files: ["src/b.ts"],
      earlier: () => ({ landed: [], takenOff: [{ tip: t1, merge: car.mergeSha, branch: train.branch }] }),
    });
    expect(boarded.ok).toBe(false);
    if (!boarded.ok) expect(boarded.error).toContain("taken off");
    expect(await sha(train.branch)).toBe(lane);

    // At the start of a run.
    const second = await run(writes("src/b.ts"), t.id);
    expect(second.status).toBe("failed");
    const branch = getRun(db, first.runId)?.run.branch as string;
    const clone = workspaceDir(join(dir, "data"), repo.id, t.id);
    expect(second.reason).toContain(
      `Start the task fresh: ${startFreshHint(t.id, { clone, branch })}, then run it again.`,
    );
    expect(await sha(train.branch)).toBe(lane);

    // Started fresh as the refusal says: it builds on main, which holds the revert, and lands.
    rmSync(clone, { recursive: true, force: true });
    await git(repoPath, "update-ref", "-d", wipRef(t.id));
    await git(repoPath, "update-ref", "-d", taskRef(t.id));
    await git(repoPath, "branch", "-D", branch);
    const third = await run(writes("src/b.ts"), t.id);
    expect(third.status).toBe("complete");
    expect(texts(third.runId).some((x) => x.startsWith("On today's train"))).toBe(true);
  });

  test("a car pulled from an earlier day's train stops the next day's re-run", async () => {
    // Value: protects=taken-off landings are read from every train of the repo, not just today's, so a re-run the next day doesn't quietly land the work you pulled; fails_when=earlierLandings reads only the current train's cars; why_new=Z1 next-day train; seam=none
    const repo = trainRepo();
    const t = createTask(db, { repoId: repo.id, title: "Yesterday", scope: ["src/**"], status: "queued" });
    const first = await run(writes("src/a.ts"), t.id);
    const [train] = listTrains(db);
    const car = train?.cars[0];
    if (!train || car?.state !== "on") throw new Error("not boarded");
    expect((await pullCar(fresh(repo.id), train, car.mergeSha, false)).ok).toBe(true);
    setCarState(db, train.id, first.runId, "pulled");
    // That train was yesterday's.
    const old = "crew/train-2020-01-01";
    await git(
      repoPath,
      "worktree",
      "remove",
      "--force",
      join(repoPath, ".worktrees", `_${train.branch.replace(/[^\w.-]+/g, "-")}`),
    );
    await git(repoPath, "branch", "-m", train.branch, old);
    db.$client.run("UPDATE trains SET night_id = ?, branch = ? WHERE id = ?", ["2020-01-01", old, train.id]);

    const second = await run(writes("src/b.ts"), t.id);
    expect(second.status).toBe("failed");
    expect(second.reason).toContain(`taken off ${old} (pulled or undone)`);
    const today = listTrains(db).find((x) => x.id !== train.id);
    expect(today?.cars.some((c) => c.state === "on") ?? false).toBe(false);
  });

  test("a train task promoted to ship waits for you when its earlier run touched an always-ask file", async () => {
    // Value: protects=after a repo moves from train to ship, a re-run is judged on the task's whole change, so a migration from the boarded first run still needs you; fails_when=the gate base is re-pinned to the earlier tip and canShip sees only the new delta, shipping the migration to dev; why_new=D16 bug (a), probe-confirmed; seam=none
    const repo = trainRepo();
    const t = createTask(db, {
      repoId: repo.id,
      title: "Migrate",
      scope: ["src/**", "migrations/**"],
      status: "queued",
    });
    await run(writes("migrations/1.sql", "src/a.ts"), t.id);
    const [train] = listTrains(db);
    if (train?.cars[0]?.state !== "on") throw new Error("not boarded");
    updateRepo(db, repo.id, {
      level: "ship",
      shipBranch: "dev",
      allowShip: ["src/**", "migrations/**"],
      alwaysAsk: ["migrations/**"],
    });
    const second = await run(writes("src/b.ts"), t.id);
    expect(getRun(db, second.runId)?.run.shipSha).toBeNull();
    expect(texts(second.runId).find((x) => x.startsWith("Waiting for you instead of shipping"))).toContain(
      "always wait for you: migrations/1.sql",
    );
    expect(await tree("dev")).not.toContain("migrations/1.sql");
  });

  test("after you merge the first run into main, the next run's gate starts from there", async () => {
    // Value: protects=a merge commit of the task's earlier work into main moves the gate base to that work, so the next run is checked on its new change and boards a train cut from main; fails_when=the base stays at the old fork point or the train refuses a merge base that main now contains; why_new=D16 human merge; seam=none
    const repo = addRepo(db, { name: "acme", path: repoPath, defaultBranch: "main" });
    const t = createTask(db, { repoId: repo.id, title: "Merged", scope: ["src/**"], status: "queued" });
    await run(writes("src/a.ts"), t.id);
    await git(repoPath, ...ID, "merge", "-q", "--no-ff", "-m", "Merge the task", `refs/nightcrew/tasks/${t.id}`);
    updateRepo(db, repo.id, { level: "train" });
    const second = await run(writes("src/b.ts"), t.id);
    expect(getRun(db, second.runId)?.run.changedFiles).toBe(1);
    expect(texts(second.runId).some((x) => x.startsWith("On today's train"))).toBe(true);
  });

  test("after you squash-merge the first run into main, the next run lands cleanly", async () => {
    // Value: protects=a squash merge leaves the gate base at the old fork point, so the next run is checked on the whole task, and its identical earlier changes merge cleanly onto a train cut from main; fails_when=the squash's copy of the work conflicts or is refused as unchecked; why_new=D16 squash merge; seam=none
    const repo = addRepo(db, { name: "acme", path: repoPath, defaultBranch: "main" });
    const t = createTask(db, { repoId: repo.id, title: "Squashed", scope: ["src/**"], status: "queued" });
    await run(writes("src/a.ts"), t.id);
    await git(repoPath, "merge", "-q", "--squash", `refs/nightcrew/tasks/${t.id}`);
    await git(repoPath, ...ID, "commit", "-qm", "Squashed task");
    updateRepo(db, repo.id, { level: "train" });
    const second = await run(writes("src/b.ts"), t.id);
    expect(getRun(db, second.runId)?.run.changedFiles).toBe(2);
    const [train] = listTrains(db);
    const car = train?.cars.find((c) => c.runId === second.runId);
    expect(car?.state).toBe("on");
    expect((await git(repoPath, "diff", "--name-only", `${car?.mergeSha}^1`, `${car?.mergeSha}`)).stdout.trim()).toBe(
      "src/b.ts",
    );
  });

  test("a directory the ship branch renamed doesn't turn a clean merge into a refusal", async () => {
    // Value: protects=the lane merge runs without rename detection, so a task's new file in a folder dev renamed lands where the gate saw it instead of conflicting or moving; fails_when=mergeInto drops -X no-renames / merge.directoryRenames=false; why_new=D16 item 9; seam=none
    const repo = fresh(shipRepo().id);
    const wt = join(dir, "wt-dev");
    await git(repoPath, "worktree", "add", "-q", wt, "dev");
    await git(wt, "mv", "src", "lib");
    await git(wt, ...ID, "commit", "-qm", "rename src");
    await git(repoPath, "worktree", "remove", "--force", wt);
    const base = await sha("main");
    const task = join(dir, "wt-task");
    await git(repoPath, "worktree", "add", "-q", "--detach", task, base);
    writeFileSync(join(task, "src", "feature.ts"), "x\n");
    await git(task, "add", "-A");
    await git(task, ...ID, "commit", "-qm", "feature");
    const tip = (await git(task, "rev-parse", "HEAD")).stdout.trim();
    await git(repoPath, "worktree", "remove", "--force", task);
    const shipped = await shipTask(repo, tip, "Feature", false, { base, files: ["src/feature.ts"] });
    expect(shipped).toMatchObject({ ok: true });
    const files = await tree("dev");
    expect(files).toContain("src/feature.ts");
    expect(files).toContain("lib/index.ts");
  });
});
