import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Repo, TrainCar } from "@nightcrew/core";
import {
  addCar,
  addRepo,
  createRoutine,
  createTrain,
  type Db,
  getRepo,
  getRoutine,
  getTrain,
  openDb,
  setRunTrain,
  updateRepo,
  upsertRuns,
} from "@nightcrew/db";
import { Hono } from "hono";
// The lock pullCar waits on; holding it lets a test board a car mid-pull.
import { withRepoLock } from "../../../packages/runner/src/git";
import { mountTrustRoutes } from "./trust-routes";

let db: Db;
let app: Hono;
const dirs: string[] = [];

beforeEach(() => {
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
  // Value: protects=promote refuses Ship to dev until a ship branch and allowed paths are set, and leaves the level alone; fails_when=the ship guard in promote is dropped; why_new=promote had no route test; seam=none
  test("to ship without a ship branch or allowed paths → 400, level unchanged", async () => {
    const repo = addRepo(db, { name: "acme", path: "/code/acme", defaultBranch: "main" });
    updateRepo(db, repo.id, { level: "train" });
    const res = await send("POST", `/api/repos/${repo.id}/promote`, { level: "ship" });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain("ship branch");
    expect(getRepo(db, repo.id)?.level).toBe("train");

    updateRepo(db, repo.id, { shipBranch: "dev", allowShip: ["src/**"] });
    const ok = await send("POST", `/api/repos/${repo.id}/promote`, { level: "ship" });
    expect(ok.status).toBe(200);
    expect(getRepo(db, repo.id)?.level).toBe("ship");
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
