import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TrainCar } from "@nightcrew/core";
import {
  addCar,
  addRepo,
  createTask,
  createTrain,
  type Db,
  getRun,
  getSettings,
  getTask,
  getTrain,
  listNotes,
  listTasks,
  openDb,
  type RunRow,
  setRunTrain,
  updateSettings,
  updateTask,
  upsertRuns,
} from "@nightcrew/db";
import { Crew, ScriptedEngine, setLandingHome } from "@nightcrew/runner";
import { mergeArgs } from "./github";
import { createApp, tildePath } from "./server";

let db: Db;
let app: ReturnType<typeof createApp>;
const KEY = "k".repeat(64);
let locked: ReturnType<typeof createApp>;

beforeEach(() => {
  db = openDb(":memory:");
  const engine = new ScriptedEngine({});
  const dataDir = join(tmpdir(), "nc-server");
  const crew = new Crew({ db, engine, dataDir, publish: false });
  app = createApp({ db, cwd: dataDir, crew, engine, dataDir, publish: false });
  locked = createApp({ db, cwd: dataDir, crew, engine, dataDir, publish: false, token: KEY });
});

const error = async (res: Response) => ((await res.json()) as { error: string }).error;

describe("local API guard", () => {
  // Value: protects=a website can't create tasks with a CORS-simple text/plain POST; fails_when=the Origin or content-type check is dropped from the /api middleware; why_new=the API had no CSRF guard; seam=none
  test("a cross-site text/plain POST is refused and creates nothing", async () => {
    const repo = addRepo(db, { name: "acme", path: "/code/acme", defaultBranch: "main" });
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "text/plain" },
      body: JSON.stringify({ repoId: repo.id, title: "pwn" }),
    });
    expect(res.status).toBe(403);
    expect(listTasks(db)).toHaveLength(0);

    // Same body without an Origin still fails on content-type.
    const plain = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ repoId: repo.id, title: "pwn" }),
    });
    expect(plain.status).toBe(415);
    expect(listTasks(db)).toHaveLength(0);
  });

  // Value: protects=a DNS-rebound page can't read the API under a foreign Host; fails_when=the Host check is removed or loosened; why_new=Host was never checked; seam=none
  test("a foreign Host is refused, localhost on any port is fine", async () => {
    const evil = await app.request("/api/repos", { headers: { host: "evil.example:3721" } });
    expect(evil.status).toBe(403);
    expect(await error(evil)).toContain("localhost");
    for (const host of ["localhost:3721", "127.0.0.1:5173", "[::1]:3721"]) {
      expect((await app.request("/api/repos", { headers: { host } })).status).toBe(200);
    }
  });

  // Value: protects=the dashboard (and the Vite dev proxy) can still create tasks; fails_when=the guard rejects same-host JSON writes; why_new=new middleware could over-block; seam=none
  test("a same-origin JSON POST still works", async () => {
    const repo = addRepo(db, { name: "acme", path: "/code/acme", defaultBranch: "main" });
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { host: "localhost:5173", origin: "http://localhost:5173", "content-type": "application/json" },
      body: JSON.stringify({ repoId: repo.id, title: "Fix login" }),
    });
    expect(res.status).toBe(201);
    expect(listTasks(db)).toHaveLength(1);
  });

  // Value: protects=body-less dashboard buttons (pause, stop all, sync) keep working; fails_when=the content-type rule demands a body; why_new=new middleware could over-block; seam=none
  test("a body-less dashboard POST still works", async () => {
    const res = await app.request("/api/crew/pause", {
      method: "POST",
      headers: { host: "localhost:3721", origin: "http://localhost:3721", "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(getSettings(db).dispatch).toBe(false);

    const bare = await app.request("/api/crew/resume", { method: "POST" });
    expect(bare.status).toBe(200);
  });

  // Value: protects=a thrown error returns JSON like every other route; fails_when=onError is removed and Hono falls back to text; why_new=errors returned plain text; seam=none
  test("a thrown error returns JSON 500", async () => {
    app.get("/api/boom", () => {
      throw new Error("Something broke.");
    });
    const res = await app.request("/api/boom");
    expect(res.status).toBe(500);
    expect(await error(res)).toBe("Something broke.");
  });
});

describe("GET /api/info", () => {
  test("the Station requires the launch key and returns an empty usable snapshot", async () => {
    expect((await locked.request("/api/station")).status).toBe(401);
    const result = await locked.request("/api/station", { headers: { "x-nightcrew-token": KEY } });
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(await result.json()).toEqual({ decisions: [], recent: [], latestNightId: null, queue: [] });
  });

  // Value: protects=Settings shows where task clones really live; fails_when=/api/info drops dataDir/workDir or workDir stops ending in /work; why_new=H6, the clone path was hard-coded copy; seam=none
  test("returns the data dir and the clone folder", async () => {
    const res = await app.request("/api/info", { headers: { host: "localhost:3721" } });
    expect(res.status).toBe(200);
    const info = (await res.json()) as { dataDir: string; workDir: string };
    expect(info.dataDir).toBe(join(tmpdir(), "nc-server"));
    expect(info.workDir).toBe(tildePath(join(tmpdir(), "nc-server", "work")));
    expect((await locked.request("/api/info", { headers: { host: "localhost:3721" } })).status).toBe(401);
  });

  // Value: protects=$HOME shows as ~ and look-alike prefixes don't; fails_when=tildePath matches /Users/me2 for home /Users/me or drops the separator check; why_new=H6; seam=none
  test("tildePath abbreviates only paths under home", () => {
    expect(tildePath("/Users/me/.nightcrew/work", "/Users/me")).toBe("~/.nightcrew/work");
    expect(tildePath("/Users/me", "/Users/me")).toBe("~");
    expect(tildePath("/Users/me2/x", "/Users/me")).toBe("/Users/me2/x");
    expect(tildePath("/srv/nc/work", "/Users/me")).toBe("/srv/nc/work");
  });
});

describe("per-launch key", () => {
  const host = "localhost:3721";

  test("the API refuses a caller without the key", async () => {
    // Value: protects=a local process or another localhost page can't read or drive the API without the printed link; fails_when=the token check is dropped from the /api middleware; why_new=D10 adds the per-launch key; seam=none
    const res = await locked.request("/api/crew", { headers: { host } });
    expect(res.status).toBe(401);
    expect(await error(res)).toBe("Open NightCrew from the link it printed in your terminal.");
    const wrong = await locked.request("/api/crew", { headers: { host, "x-nightcrew-token": "nope" } });
    expect(wrong.status).toBe(401);
  });

  test("only the header opens the API: not a cookie, not ?t=", async () => {
    // Value: protects=the key can't be replayed from a cookie (sent to every localhost port) or a URL; fails_when=hasKey reads cookies or the query string again; why_new=X1, the session cookie leaked to other local servers; seam=none
    const byHeader = await locked.request("/api/crew", { headers: { host, "x-nightcrew-token": KEY } });
    expect(byHeader.status).toBe(200);
    const byCookie = await locked.request("/api/crew", { headers: { host, cookie: `nc_session_3721=${KEY}` } });
    expect(byCookie.status).toBe(401);
    const byQuery = await locked.request(`http://${host}/api/crew?t=${KEY}`);
    expect(byQuery.status).toBe(401);
  });

  test("the page shell loads without the key and never sets a cookie", async () => {
    // Value: protects=the app shell (no data) loads so it can read ?t= itself, and no cookie or redirect carries the key; fails_when=the server goes back to trading ?t= for a cookie; why_new=X1 moves the key to a header; seam=none
    for (const path of ["/", `/?t=${KEY}`, "/assets/app.js"]) {
      const res = await locked.request(`http://${host}${path}`);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(302);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  test("a write from another localhost port is refused, even body-less", async () => {
    // Value: protects=a page on localhost:5173 (or any other port) can't fire body-less POSTs like stop-all at the dashboard; fails_when=the Origin check goes back to any-localhost; why_new=the Origin check ignored the port; seam=none
    const res = await locked.request("/api/crew/pause", {
      method: "POST",
      headers: { host, origin: "http://localhost:5173", "x-nightcrew-token": KEY },
    });
    expect(res.status).toBe(403);
    expect(getSettings(db).dispatch).toBe(true);
    const same = await locked.request("/api/crew/pause", {
      method: "POST",
      headers: { host, origin: `http://${host}`, "x-nightcrew-token": KEY },
    });
    expect(same.status).toBe(200);
  });

  test("without a token option the app answers as before", async () => {
    // Value: protects=tests and dev (NIGHTCREW_DEV, --dev) work without a key; fails_when=the token check runs when no token was given; why_new=D10 made the key optional; seam=none
    expect((await app.request("/api/crew", { headers: { host } })).status).toBe(200);
  });
});

describe("merge pins the checked commit", () => {
  test("mergeArgs adds --match-head-commit when there is a sha", () => {
    // Value: protects=GitHub refuses the merge when the PR head moved after the crew's gate; fails_when=the sha is dropped from the gh args; why_new=X4, merges weren't pinned; seam=none
    expect(mergeArgs("https://github.com/o/r/pull/1", "a".repeat(40))).toEqual([
      "pr",
      "merge",
      "https://github.com/o/r/pull/1",
      "--squash",
      "--match-head-commit",
      "a".repeat(40),
    ]);
    expect(mergeArgs("https://github.com/o/r/pull/1", null)).toEqual([
      "pr",
      "merge",
      "https://github.com/o/r/pull/1",
      "--squash",
    ]);
  });

  test("a crew run with no recorded commit isn't merged", async () => {
    // Value: protects=merge never goes out unpinned for a crew run; fails_when=the triage route merges when the gated sha can't be read; why_new=X4; seam=none
    const repo = addRepo(db, { name: "acme", path: join(tmpdir(), "nc-no-such-repo"), defaultBranch: "main" });
    const task = createTask(db, { repoId: repo.id, title: "A" });
    upsertRuns(db, [{ run: runRow(task.id, { prUrl: "https://github.com/o/r/pull/1", prNumber: 1 }), artifacts: [] }]);
    const res = await triage("run_a", { action: "merge" });
    expect(res.status).toBe(409);
    expect(await error(res)).toContain("commit NightCrew checked");
    expect(getRun(db, "run_a")?.run.triage).toBeNull();
  });
});

describe("send back takes the task off its train", () => {
  const dirs: string[] = [];
  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), "nc-server-home-"));
    dirs.push(home);
    setLandingHome(home);
    updateSettings(db, { dispatch: false }); // a requeued task must not start in a test
  });
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const git = (cwd: string, ...args: string[]) => {
    const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
    if (p.exitCode !== 0) throw new Error(p.stderr.toString());
    return p.stdout.toString().trim();
  };

  function onTrain(path: string, mergeSha: string) {
    const repo = addRepo(db, { name: "acme", path, defaultBranch: "main" });
    const task = createTask(db, { repoId: repo.id, title: "A" });
    updateTask(db, task.id, { status: "done" });
    const train = createTrain(db, { repoId: repo.id, nightId: "2026-10-10", branch: "crew/train" });
    const car: TrainCar = { runId: "run_a", taskId: task.id, title: "A", mergeSha, state: "on" };
    upsertRuns(db, [{ run: runRow(task.id), artifacts: [] }]);
    setRunTrain(db, car.runId, train.id);
    addCar(db, train.id, car);
    return { task, trainId: train.id, car };
  }

  test("a car that can't come off refuses the send back", async () => {
    // Value: protects=a rejected task never stays on the train while also being requeued; fails_when=send_back requeues without pulling, or ignores a failed pull; why_new=X5, send back left the car on; seam=none
    const dir = mkdtempSync(join(tmpdir(), "nc-sendback-"));
    dirs.push(dir); // not a git repo, so the pull fails
    const { task, trainId, car } = onTrain(dir, "c".repeat(40));
    const res = await triage("run_a", { action: "send_back", note: "try again" });
    expect(res.status).toBe(409);
    expect(await error(res)).toContain("wasn't sent back");
    expect(getTrain(db, trainId)?.cars).toEqual([car]);
    expect(getTask(db, task.id)?.status).toBe("done");
    expect(getRun(db, "run_a")?.run.triage).toBeNull();
  });

  test("a car that comes off is pulled, then the task is requeued with the note", async () => {
    // Value: protects=send back on a train run reverts it off the train before requeueing; fails_when=the triage route skips pullCar or doesn't mark the car pulled; why_new=X5; seam=none
    const dir = mkdtempSync(join(tmpdir(), "nc-sendback-"));
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

    const { task, trainId, car } = onTrain(dir, mergeSha);
    const res = await triage("run_a", { action: "send_back", note: "use the helper" });
    expect(res.status).toBe(200);
    expect(getTrain(db, trainId)?.cars).toEqual([{ ...car, state: "pulled" }]);
    expect(getTask(db, task.id)?.status).toBe("queued");
    expect(listNotes(db, task.id).map((n) => n.body)).toEqual(["use the helper"]);
    expect(Bun.spawnSync(["git", "cat-file", "-e", "crew/train:b.txt"], { cwd: dir }).exitCode).not.toBe(0);
  });
});

describe("morning triage feeds back into the task", () => {
  // Value: protects=Run again requeues now, Close archives, Undo marks done, and a task an agent is running is left alone; bad actions and runs are refused; fails_when=an action maps to the wrong status, runAt isn't cleared (a scheduled task waits), or triage re-statuses a running task under its agent; why_new=only merge and send_back had route tests; seam=none; no_claim=merge's GitHub call (not exercised; no gh)
  beforeEach(() => updateSettings(db, { dispatch: false })); // a requeued task must not start in a test

  test.each([
    ["again", "done", "queued"],
    ["close", "done", "archived"],
    ["undo", "archived", "done"],
    ["again", "running", "running"],
    ["close", "running", "running"],
  ] as const)("%s on a %s task → %s", async (action, from, to) => {
    const repo = addRepo(db, { name: "acme", path: "/code/acme", defaultBranch: "main" });
    const task = createTask(db, { repoId: repo.id, title: "A" });
    updateTask(db, task.id, { status: from, runAt: new Date(Date.now() + 3_600_000).toISOString() });
    upsertRuns(db, [{ run: runRow(task.id), artifacts: [] }]);
    const res = await triage("run_a", { action });
    expect(res.status).toBe(200);
    // Undo takes the earlier decision back rather than recording one.
    expect(getRun(db, "run_a")?.run.triage).toBe(action === "undo" ? null : action);
    expect(getTask(db, task.id)?.status).toBe(to);
    if (action === "again" && from !== "running") expect(getTask(db, task.id)?.runAt).toBeNull();
  });

  test("an unknown action is a 400 and an unknown run a 404, and neither records anything", async () => {
    const repo = addRepo(db, { name: "acme", path: "/code/acme", defaultBranch: "main" });
    const task = createTask(db, { repoId: repo.id, title: "A" });
    updateTask(db, task.id, { status: "done" });
    upsertRuns(db, [{ run: runRow(task.id), artifacts: [] }]);
    const bad = await triage("run_a", { action: "ship_it" });
    expect(bad.status).toBe(400);
    expect(await error(bad)).toContain("Unknown action");
    expect((await triage("run_missing", { action: "close" })).status).toBe(404);
    const noPr = await triage("run_a", { action: "merge" });
    expect(noPr.status).toBe(400);
    expect(await error(noPr)).toContain("no pull request");
    expect(getRun(db, "run_a")?.run.triage).toBeNull();
    expect(getTask(db, task.id)?.status).toBe("done");
  });
});

function runRow(taskId: string, over: Partial<RunRow> = {}): RunRow {
  return {
    id: "run_a",
    nightId: "2026-10-10",
    sessionId: "s",
    taskId,
    title: "A",
    repo: "acme",
    status: "complete",
    source: "local",
    ...over,
  };
}

const triage = (id: string, body: unknown) =>
  app.request(`/api/runs/${id}/triage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
