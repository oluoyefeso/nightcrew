import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Repo, TrainCar } from "@nightcrew/core";
import {
  addCar,
  addRepo,
  createRoutine,
  createTask,
  createTrain,
  type Db,
  getRepo,
  getRoutine,
  getRun,
  getTrain,
  listRoutines,
  listTasks,
  markShipped,
  openDb,
  setRunTrain,
  updateRepo,
  upsertRuns,
} from "@nightcrew/db";
// withRepoLock: the lock pullCar waits on; holding it lets a test board a car mid-pull.
import { setLandingHome, withRepoLock } from "@nightcrew/runner";
import { Hono } from "hono";
import { mountTrustRoutes } from "./trust-routes";

let db: Db;
let app: Hono;
const dirs: string[] = [];

beforeEach(() => {
  // Landing markers go to a temp dir, never the developer's ~/.nightcrew/landing.
  const home = mkdtempSync(join(tmpdir(), "nc-trust-home-"));
  dirs.push(home);
  setLandingHome(home);
  db = openDb(":memory:");
  app = new Hono();
  mountTrustRoutes(app, { db, publish: false });
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const send = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json", host: "localhost:3721" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

describe("promote", () => {
  // Value: protects=promote refuses Ship to dev until a ship branch and allowed paths are set, leaves the level alone, and tells the trust-panel user to go to Settings; fails_when=the ship guard in promote is dropped or its message loses where to fix it; why_new=promote had no route test, then W4 restored the Settings pointer; seam=none
  test("to ship without a ship branch or allowed paths → 400, level unchanged", async () => {
    const repo = addRepo(db, { name: "acme", path: "/code/acme", defaultBranch: "main" });
    updateRepo(db, repo.id, { level: "train" });
    const res = await send("POST", `/api/repos/${repo.id}/promote`, { level: "ship" });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe(
      "Set a ship branch and the paths allowed to ship in Settings before promoting to Ship to dev.",
    );
    expect(getRepo(db, repo.id)?.level).toBe("train");

    updateRepo(db, repo.id, { shipBranch: "dev", allowShip: ["src/**"] });
    const ok = await send("POST", `/api/repos/${repo.id}/promote`, { level: "ship" });
    expect(ok.status).toBe(200);
    expect(getRepo(db, repo.id)?.level).toBe("ship");
  });

  // Value: protects=promote and Settings share one ship rule, so promote refuses shipping to the default branch; fails_when=promote checks only the repo's own protected list again; why_new=the two routes had drifted; seam=none
  test("to ship with the default branch as ship branch → 400", async () => {
    const repo = addRepo(db, { name: "acme", path: "/code/acme", defaultBranch: "trunk" });
    updateRepo(db, repo.id, { level: "train", shipBranch: "trunk", allowShip: ["src/**"] });
    const res = await send("POST", `/api/repos/${repo.id}/promote`, { level: "ship" });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("trunk is protected. Pick a branch like dev or staging in Settings.");
    expect(getRepo(db, repo.id)?.level).toBe("train");
  });
});

describe("PATCH /api/routines/:id", () => {
  const routine = () => {
    const repo = addRepo(db, { name: "acme", path: "/code/acme", defaultBranch: "main" });
    return createRoutine(db, { repoId: repo.id, title: "Bump deps", days: [1] });
  };

  // Value: protects=routine edits only touch editable fields and are validated like create; fails_when=the raw body reaches updateRoutine again (repoId, lastNight or junk keys get written, or an empty patch 500s); why_new=PATCH passed the body through unchecked; seam=none
  test.each([
    [{ type: "chores" }, 400, "Unknown task type"],
    [{ days: [] }, 400, "at least one day"],
    [{ days: [9] }, 400, "at least one day"],
    [{ title: "  " }, 400, "title"],
    [{ enabled: "no" }, 400, "true or false"],
    [{}, 400, "Nothing to change"],
    [{ repoId: "repo_other", lastNight: "2026-10-10" }, 400, "Nothing to change"],
    [{ brief: 42 }, 400, "brief as text"],
    [{ scope: "src/**" }, 400, "list of file globs"],
    [{ scope: ["src/**", 3] }, 400, "list of file globs"],
    [{ criteria: "Tests pass" }, 400, "list of sentences"],
    [{ criteria: [null] }, 400, "list of sentences"],
  ])("%p → %d", async (body, status, message) => {
    const r = routine();
    const res = await send("PATCH", `/api/routines/${r.id}`, body);
    expect(res.status).toBe(status);
    expect(await errorOf(res)).toContain(message);
    expect(getRoutine(db, r.id)).toEqual(r);
  });

  test("valid edits are saved, and an unknown routine is a 404", async () => {
    const r = routine();
    const res = await send("PATCH", `/api/routines/${r.id}`, {
      title: "Bump deps weekly",
      type: "refactor",
      days: [5, 1, 1],
      enabled: false,
      scope: ["package.json"],
      criteria: ["Tests pass"],
    });
    expect(res.status).toBe(200);
    expect(getRoutine(db, r.id)).toMatchObject({
      title: "Bump deps weekly",
      type: "refactor",
      days: [1, 5],
      enabled: false,
      scope: ["package.json"],
      criteria: ["Tests pass"],
    });
    expect((await send("PATCH", "/api/routines/routine_missing", { enabled: true })).status).toBe(404);
  });
});

describe("POST /api/routines", () => {
  // Value: protects=new routines get the same brief, scope and criteria type checks as edits; fails_when=create skips them and a string scope reaches the tasks a routine spawns; why_new=only PATCH-style fields were checked on create; seam=none
  test.each([
    [{ brief: ["x"] }, "brief as text"],
    [{ scope: "src/**" }, "list of file globs"],
    [{ criteria: [1] }, "list of sentences"],
  ])("%p → 400", async (extra, message) => {
    const repo = addRepo(db, { name: "acme", path: "/code/acme", defaultBranch: "main" });
    const res = await send("POST", "/api/routines", { repoId: repo.id, title: "Bump deps", days: [1], ...extra });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain(message);
    expect(listRoutines(db)).toEqual([]);
  });
});

describe("undoing a ship", () => {
  // Value: protects=Undo ship reverts the merge on the ship branch, marks the run undone and drops the repo to the train, once; a failed revert changes nothing; fails_when=unship skips markUndone or the demotion, marks undone when the revert fails, or a second Undo reverts again; why_new=the unship route had no test; seam=none; no_claim=pushing the revert to origin (publish off; local git only)
  const git = (cwd: string, ...args: string[]) => {
    const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
    if (p.exitCode !== 0) throw new Error(p.stderr.toString());
    return p.stdout.toString().trim();
  };

  function shipped(path: string, shipSha: string) {
    const repo = addRepo(db, { name: "acme", path, defaultBranch: "main" });
    updateRepo(db, repo.id, { level: "ship", shipBranch: "dev", allowShip: ["**"] });
    const task = createTask(db, { repoId: repo.id, title: "A" });
    const run = {
      id: "run_s",
      nightId: "2026-10-10",
      sessionId: "s",
      taskId: task.id,
      title: "A",
      repo: "acme",
      status: "complete",
      source: "local",
    };
    upsertRuns(db, [{ run, artifacts: [] }]);
    markShipped(db, run.id, shipSha, "dev");
    return repo;
  }

  test("reverts it on the ship branch, marks it undone and demotes the repo; a second Undo is refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nc-unship-"));
    dirs.push(dir);
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.txt"), "a\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "init");
    git(dir, "checkout", "-qb", "feature");
    writeFileSync(join(dir, "b.txt"), "b\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "task a");
    git(dir, "checkout", "-qb", "dev", "main");
    git(dir, "merge", "-q", "--no-ff", "-m", "Ship: A (NightCrew)", "feature");
    const shipSha = git(dir, "rev-parse", "HEAD");
    git(dir, "checkout", "-q", "main");
    const repo = shipped(dir, shipSha);

    const res = await send("POST", "/api/runs/run_s/unship");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; revert: string; demoted: boolean };
    expect(body).toMatchObject({ ok: true, demoted: true });
    expect(git(dir, "rev-parse", "dev")).toBe(body.revert);
    expect(Bun.spawnSync(["git", "cat-file", "-e", "dev:b.txt"], { cwd: dir }).exitCode).not.toBe(0);
    expect(getRun(db, "run_s")?.run.undoneAt).toBeTruthy();
    expect(getRepo(db, repo.id)?.level).toBe("train");

    const again = await send("POST", "/api/runs/run_s/unship");
    expect(again.status).toBe(400);
    expect(await errorOf(again)).toContain("already undone");
    expect(git(dir, "rev-parse", "dev")).toBe(body.revert);
  });

  test("a revert that fails leaves the run shipped and the repo at Ship to dev", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nc-unship-"));
    dirs.push(dir); // not a git repo, so the ship branch can't be checked out
    const repo = shipped(dir, "c".repeat(40));
    const res = await send("POST", "/api/runs/run_s/unship");
    expect(res.status).toBe(409);
    expect(getRun(db, "run_s")?.run.undoneAt).toBeNull();
    expect(getRepo(db, repo.id)?.level).toBe("ship");
    expect((await send("POST", "/api/runs/run_missing/unship")).status).toBe(400);
  });
});

describe("pulling a car off the train", () => {
  const git = (cwd: string, ...args: string[]) => {
    const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
    if (p.exitCode !== 0) throw new Error(p.stderr.toString());
    return p.stdout.toString().trim();
  };

  /** A repo whose train branch carries one merged task, plus the train and its run in the db. */
  function onTrain(path: string, mergeSha: string): { repo: Repo; trainId: string; car: TrainCar } {
    const repo = addRepo(db, { name: "acme", path, defaultBranch: "main" });
    const train = createTrain(db, { repoId: repo.id, nightId: "2026-10-10", branch: "crew/train" });
    const car: TrainCar = { runId: "run_a", taskId: "task_a", title: "A", mergeSha, state: "on" };
    upsertRuns(db, [
      {
        run: {
          id: car.runId,
          nightId: "2026-10-10",
          sessionId: "s",
          taskId: car.taskId,
          title: "A",
          repo: "acme",
          status: "complete",
          source: "local",
        },
        artifacts: [],
      },
    ]);
    setRunTrain(db, car.runId, train.id);
    addCar(db, train.id, car);
    return { repo, trainId: train.id, car };
  }

  // Value: protects=a car that boards while a pull waits on the repo lock stays on the train; fails_when=the pull route writes back the cars it read before awaiting pullCar; why_new=the stale snapshot erased cars that boarded meanwhile; seam=none
  test("cars that board during a pull are kept", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nc-pull-"));
    dirs.push(dir);
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.txt"), "a\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "init");
    git(dir, "checkout", "-qb", "feature");
    writeFileSync(join(dir, "b.txt"), "b\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "task a");
    git(dir, "checkout", "-qb", "crew/train", "main");
    git(dir, "merge", "-q", "--no-ff", "-m", "Merge task a", "feature");
    const mergeSha = git(dir, "rev-parse", "HEAD");
    git(dir, "checkout", "-q", "main");

    const { repo, trainId, car } = onTrain(dir, mergeSha);
    let release = () => {};
    const held = withRepoLock(repo.path, () => new Promise<void>((r) => (release = r)));

    let settled = false;
    const pending = Promise.resolve(send("POST", `/api/runs/${car.runId}/pull`)).then((res) => {
      settled = true;
      return res;
    });
    await Bun.sleep(30);
    expect(settled).toBe(false); // still waiting behind the lock
    const boarded: TrainCar = { runId: "run_b", taskId: "task_b", title: "B", mergeSha: "b".repeat(40), state: "on" };
    addCar(db, trainId, boarded);
    release();
    await held;

    const res = await pending;
    expect(res.status).toBe(200);
    expect(getTrain(db, trainId)?.cars).toEqual([{ ...car, state: "pulled" }, boarded]);
  });

  // Value: protects=a failed pull leaves the car on the train; fails_when=the car is marked pulled before or regardless of pullCar's result; why_new=pull route had no test; seam=none
  test("a pull that fails leaves the car on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nc-pull-"));
    dirs.push(dir); // not a git repo, so pullCar can't check out the train
    const { trainId, car } = onTrain(dir, "c".repeat(40));
    const res = await send("POST", `/api/runs/${car.runId}/pull`);
    expect(res.status).toBe(409);
    expect(getTrain(db, trainId)?.cars).toEqual([car]);
  });
});

describe("POST /api/intake/github", () => {
  /**
   * POST the intake in a fresh bun whose PATH starts with `bin`: Bun.spawn
   * without an env finds programs on the PATH the process started with, so a
   * fake gh can't be slipped in from inside this process.
   */
  async function intake(bin: string, dbFile: string) {
    const code = `
      const { openDb } = await import("@nightcrew/db");
      const { Hono } = await import("hono");
      const { mountTrustRoutes } = await import(process.env.NC_ROUTES);
      const app = new Hono();
      mountTrustRoutes(app, { db: openDb(process.env.NC_DB), publish: false });
      const r = await app.request("/api/intake/github", { method: "POST", headers: { host: "localhost:3721" } });
      console.log(JSON.stringify({ status: r.status, body: await r.json() }));`;
    const proc = Bun.spawn([process.execPath, "-e", code], {
      cwd: import.meta.dir,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        NC_ROUTES: join(import.meta.dir, "trust-routes.ts"),
        NC_DB: dbFile,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exit !== 0) throw new Error(err);
    return JSON.parse(out.trim().split("\n").pop() ?? "") as {
      status: number;
      body: { added: number; errors: string[] };
    };
  }

  // Value: protects=open crew-labelled issues land in Later once each (by URL), bug-like ones typed bugfix, and a repo with no GitHub remote isn't reported as an error;
  // fails_when=the URL dedupe is dropped (a second import duplicates tasks), the bug match changes, or gh's "no git remotes" shows up in errors; why_new=the route had no test;
  // seam=none; no_claim=GitHub's issue list (a fake gh first on a child bun's PATH answers per repo folder; the route runs in that child against a temp db file)
  test("imports each open crew issue once into Later, bugs as bugfix; remote-less repos aren't errors", async () => {
    const root = mkdtempSync(join(tmpdir(), "nc-intake-"));
    dirs.push(root);
    for (const name of ["acme", "local", "locked"]) mkdirSync(join(root, name));
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh
case "$(basename "$PWD")" in
  acme) cat <<'JSON'
[{"number":3,"title":"Login button is broken","body":"Steps to reproduce.","url":"https://github.com/o/acme/issues/3"},
 {"number":4,"title":"Add dark mode","body":"","url":"https://github.com/o/acme/issues/4"},
 {"number":1,"title":"Already here","body":"","url":"https://github.com/o/acme/issues/1"}]
JSON
  ;;
  local) echo "no git remotes found" >&2; exit 1 ;;
  *) echo "HTTP 401: Bad credentials (https://api.github.com/graphql)" >&2; exit 1 ;;
esac
`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    const dbFile = join(root, "nightcrew.db");
    const fileDb = openDb(dbFile);
    const acme = addRepo(fileDb, { name: "acme", path: join(root, "acme"), defaultBranch: "main" });
    addRepo(fileDb, { name: "local", path: join(root, "local"), defaultBranch: "main" });
    addRepo(fileDb, { name: "locked", path: join(root, "locked"), defaultBranch: "main" });
    createTask(fileDb, {
      repoId: acme.id,
      title: "Already here",
      status: "queued",
      source: "github",
      sourceRef: "https://github.com/o/acme/issues/1",
    });

    expect(await intake(bin, dbFile)).toEqual({
      status: 200,
      body: { added: 2, errors: ["locked: HTTP 401: Bad credentials (https://api.github.com/graphql)"] },
    });
    const imported = listTasks(fileDb)
      .filter((t) => t.title !== "Already here")
      .map((t) => [t.title, t.type, t.status, t.source, t.sourceRef, t.repoId])
      .sort();
    expect(imported).toEqual([
      ["Add dark mode", "implementation", "later", "github", "https://github.com/o/acme/issues/4", acme.id],
      ["Login button is broken", "bugfix", "later", "github", "https://github.com/o/acme/issues/3", acme.id],
    ]);
    expect(listTasks(fileDb).find((t) => t.title === "Login button is broken")?.brief).toContain(
      "From https://github.com/o/acme/issues/3. The PR will close the issue.",
    );

    expect((await intake(bin, dbFile)).body.added).toBe(0);
    expect(listTasks(fileDb)).toHaveLength(3);
  }, 20_000);
});
