import { beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addRepo, createTask, type Db, getRepo, getSettings, getTask, openDb, updateTask } from "@nightcrew/db";
import { Crew, ScriptedEngine } from "@nightcrew/runner";
import { Hono } from "hono";
import { mountTaskRoutes } from "./routes";

let db: Db;
let app: Hono;

beforeEach(() => {
  db = openDb(":memory:");
  const engine = new ScriptedEngine({});
  const dataDir = join(tmpdir(), "nc-routes");
  app = new Hono();
  mountTaskRoutes(app, { db, crew: new Crew({ db, engine, dataDir, publish: false }), engine, dataDir });
});

const patch = (body: unknown) =>
  app.request("/api/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("PATCH /api/settings", () => {
  // Value: protects=settings API rejects out-of-range limits, bad times and non-Slack webhooks, and accepts the edges; fails_when=a validation branch is dropped or a bound shifts; why_new=no route tests existed; seam=none
  test.each([
    [{ scheduleAt: "25:00" }, 400, "24-hour time"],
    [{ scheduleAt: "9pm" }, 400, "24-hour time"],
    [{ scheduleAt: "" }, 400, "24-hour time"],
    [{ scheduleAt: null }, 400, "24-hour time"],
    [{ maxAgents: 0 }, 400, "between 1 and 12"],
    [{ maxAgents: 13 }, 400, "between 1 and 12"],
    [{ maxAgents: 2.5 }, 400, "between 1 and 12"],
    [{ maxPerRepo: 7 }, 400, "between 1 and 6"],
    [{ slackWebhookUrl: "https://evil.example/hook" }, 400, "Slack incoming webhook"],
    [{ maxAgents: 12, maxPerRepo: 6, scheduleAt: "23:59" }, 200, null],
    [{ maxAgents: 1, maxPerRepo: 1, scheduleAt: "00:00" }, 200, null],
  ])("%p → %d", async (body, status, message) => {
    const before = getSettings(db);
    const res = await patch(body);
    expect(res.status).toBe(status);
    if (message) {
      expect(((await res.json()) as { error: string }).error).toContain(message);
      expect(getSettings(db)).toEqual(before);
    } else {
      expect(getSettings(db)).toMatchObject(body);
    }
  });
});

const send = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("running tasks and protected branches", () => {
  // Value: protects=a running task can't be re-statused or deleted under its agent, and a repo can't ship to a protected branch; fails_when=the 409 guards or protected shipBranch check are dropped; why_new=no route test covered them; seam=none
  test("changing the status of or deleting a running task is refused with 409", async () => {
    const repo = addRepo(db, { name: "acme", path: "/code/acme", defaultBranch: "main" });
    const task = createTask(db, { repoId: repo.id, title: "Busy", status: "running" });

    const edit = await send("PATCH", `/api/tasks/${task.id}`, { status: "queued" });
    expect(edit.status).toBe(409);
    expect(((await edit.json()) as { error: string }).error).toContain("Stop it first");
    expect(getTask(db, task.id)?.status).toBe("running");

    const del = await send("DELETE", `/api/tasks/${task.id}`);
    expect(del.status).toBe(409);
    expect(getTask(db, task.id)).not.toBeNull();
  });

  test.each([
    ["main", 400],
    ["production", 400],
    ["dev", 200],
  ])("PATCH repo shipBranch %s → %d", async (shipBranch, status) => {
    const repo = addRepo(db, {
      name: "acme",
      path: "/code/acme",
      defaultBranch: "main",
      protectedBranches: ["production"],
    });
    const res = await send("PATCH", `/api/repos/${repo.id}`, { shipBranch });
    expect(res.status).toBe(status);
    if (status === 400) {
      expect(((await res.json()) as { error: string }).error).toContain("is protected");
      expect(getRepo(db, repo.id)?.shipBranch).toBe(repo.shipBranch);
    } else {
      expect(getRepo(db, repo.id)?.shipBranch).toBe(shipBranch);
    }
  });
});

const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

describe("PATCH /api/settings budgets, dispatch and models", () => {
  // Value: protects=the settings API refuses a sub-100k or fractional daily budget, a non-boolean dispatch and blank models, and leaves settings as they were; fails_when=any of those checks is dropped and junk reaches the crew's limits; why_new=only schedule, agent counts and Slack were validated; seam=none
  test.each([
    [{ dailyTokenBudget: 99_999 }, 400, "at least 100k"],
    [{ dailyTokenBudget: 1_500_000.5 }, 400, "at least 100k"],
    [{ dailyTokenBudget: "lots" }, 400, "at least 100k"],
    [{ dispatch: "yes" }, 400, "true or false"],
    [{ planModel: "   " }, 400, "Name a model"],
    [{ buildModel: 5 }, 400, "Name a model"],
    [{ reviewModel: "" }, 400, "Name a model"],
    [{ dailyTokenBudget: 100_000, dispatch: false, reviewModel: "claude-opus-5-5" }, 200, null],
  ])("%p → %d", async (body, status, message) => {
    const before = getSettings(db);
    const res = await patch(body);
    expect(res.status).toBe(status);
    if (message) {
      expect(await errorOf(res)).toContain(message);
      expect(getSettings(db)).toEqual(before);
    } else {
      expect(getSettings(db)).toMatchObject(body);
    }
  });

  // Value: protects=the daily budget can't drop below any non-archived task's budget (done tasks can be queued again), and the refusal names how many tasks are in the way; fails_when=the check is dropped or narrowed back to waiting tasks, so a requeued done task is held forever; why_new=lowering the daily budget silently stranded tasks, then W1 widened it past draft/queued/later; seam=none
  test("a daily budget below a task's budget is refused", async () => {
    const repo = addRepo(db, { name: "acme", path: "/code/acme", defaultBranch: "main" });
    createTask(db, { repoId: repo.id, title: "A", status: "queued", tokenBudget: 1_000_000 });
    createTask(db, { repoId: repo.id, title: "B", status: "later", tokenBudget: 800_000 });
    createTask(db, { repoId: repo.id, title: "C", status: "done", tokenBudget: 1_200_000 });
    createTask(db, { repoId: repo.id, title: "D", status: "archived", tokenBudget: 5_000_000 });
    const before = getSettings(db);
    const res = await patch({ dailyTokenBudget: 500_000 });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe(
      "3 tasks have a budget above 500k tokens. Lower them first, or keep the daily budget at 1.2M or more.",
    );
    expect(getSettings(db)).toEqual(before);
    expect((await patch({ dailyTokenBudget: 1_000_000 })).status).toBe(400);
    expect((await patch({ dailyTokenBudget: 1_200_000 })).status).toBe(200);
  });

  test("model names are saved trimmed", async () => {
    const res = await patch({ planModel: "  claude-opus-5-5 " });
    expect(res.status).toBe(200);
    expect(getSettings(db).planModel).toBe("claude-opus-5-5");
  });
});

describe("PATCH /api/repos/:id autonomy", () => {
  const repo = () => addRepo(db, { name: "acme", path: "/code/acme", defaultBranch: "main" });

  // Value: protects=a repo can only reach Ship to dev with an unprotected ship branch and allowed paths, and only to a known level; fails_when=the level whitelist or ship guard is dropped and the crew pushes to an unguarded branch; why_new=PATCH skipped the rule promote enforces; seam=none
  test.each([
    [{ level: "god" }, 400, "Pick propose"],
    [{ level: "ship" }, 400, "ship branch"],
    [{ level: "ship", shipBranch: "dev" }, 400, "ship branch"],
    [{ level: "ship", allowShip: ["src/**"] }, 400, "ship branch"],
    [{ level: "ship", shipBranch: "main", allowShip: ["src/**"] }, 400, "is protected"],
    [{ level: "ship", shipBranch: "dev", allowShip: ["src/**"] }, 200, null],
    [{ level: "train" }, 200, null],
  ])("%p → %d", async (body, status, message) => {
    const r = repo();
    const res = await send("PATCH", `/api/repos/${r.id}`, body);
    expect(res.status).toBe(status);
    if (message) {
      expect(await errorOf(res)).toContain(message);
      expect(getRepo(db, r.id)).toEqual(r);
    } else {
      expect(getRepo(db, r.id)).toMatchObject(body);
    }
  });

  // Value: protects=a repo already shipping can't lose its ship guard by clearing its paths; fails_when=the ship rule only looks at the patch instead of the merged repo; why_new=new merged-value rule; seam=none
  test("a shipping repo keeps its allowed paths", async () => {
    const r = repo();
    expect((await send("PATCH", `/api/repos/${r.id}`, { shipBranch: "dev", allowShip: ["src/**"] })).status).toBe(200);
    expect((await send("PATCH", `/api/repos/${r.id}`, { level: "ship" })).status).toBe(200);
    const res = await send("PATCH", `/api/repos/${r.id}`, { allowShip: [] });
    expect(res.status).toBe(400);
    expect(getRepo(db, r.id)?.allowShip).toEqual(["src/**"]);
  });

  // Value: protects=an unknown repo is a 404 and an empty patch is a no-op, not a 500; fails_when=the not-found check moves after validation or drizzle gets an empty set; why_new=empty patches crashed with "No values to set"; seam=none
  test("unknown repo → 404, empty patch → unchanged", async () => {
    expect((await send("PATCH", "/api/repos/repo_missing", { level: "train" })).status).toBe(404);
    const r = repo();
    const res = await send("PATCH", `/api/repos/${r.id}`, { bogus: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(r);
  });
});

describe("task status, budgets and timing", () => {
  const repo = () => addRepo(db, { name: "acme", path: "/code/acme", defaultBranch: "main" });

  // Value: protects=new tasks can only start as draft, queued or later, on single create and in batches; fails_when=a client creates a task already running or done and the crew never picks it up or reports a run that never happened; why_new=create accepted any status; seam=none
  test.each([
    ["running", 400],
    ["done", 400],
    ["archived", 400],
    ["later", 201],
  ])("POST /api/tasks status %s → %d", async (status, code) => {
    const r = repo();
    const res = await send("POST", "/api/tasks", { repoId: r.id, title: "T", status });
    expect(res.status).toBe(code);
    if (code === 400) expect(await errorOf(res)).toContain("draft, queued or later");
  });

  // Value: protects=batch saves refuse running/done, as a batch status or on a task; fails_when=the batch path skips the create rule; why_new=batch accepted any status; seam=none
  test("POST /api/tasks/batch refuses running and done", async () => {
    const r = repo();
    const a = await send("POST", "/api/tasks/batch", { tasks: [{ repoId: r.id, title: "T" }], status: "done" });
    expect(a.status).toBe(400);
    const b = await send("POST", "/api/tasks/batch", { tasks: [{ repoId: r.id, title: "T", status: "running" }] });
    expect(b.status).toBe(400);
    const ok = await send("POST", "/api/tasks/batch", { tasks: [{ repoId: r.id, title: "T" }], status: "queued" });
    expect(ok.status).toBe(201);
  });

  // Value: protects=only the crew marks a task running or done; you can still archive it; fails_when=PATCH lets a user fake a running or finished task; why_new=PATCH accepted any status; seam=none
  test.each([
    ["running", 400],
    ["done", 400],
    ["archived", 200],
    ["later", 200],
  ])("PATCH status %s → %d", async (status, code) => {
    const t = createTask(db, { repoId: repo().id, title: "T", status: "queued" });
    const res = await send("PATCH", `/api/tasks/${t.id}`, { status });
    expect(res.status).toBe(code);
    expect(getTask(db, t.id)?.status).toBe(code === 200 ? (status as "archived") : "queued");
  });

  // Value: protects=token budgets stay between 50k and the daily budget and time limits between 1 and 600 minutes, on create, batch and edit; fails_when=a bound or one of the three paths is dropped and a task can outspend the day or run forever; why_new=budgets were never validated; seam=none
  test.each([
    [{ tokenBudget: 10_000 }, "50k"],
    [{ tokenBudget: 30_000_000 }, "20M"],
    [{ tokenBudget: 100_000.5 }, "50k"],
    [{ maxMinutes: 0 }, "600 minutes"],
    [{ maxMinutes: 601 }, "600 minutes"],
    [{ maxMinutes: 2.5 }, "600 minutes"],
  ])("%p is refused everywhere", async (limits, message) => {
    const r = repo();
    const t = createTask(db, { repoId: r.id, title: "T" });
    const create = await send("POST", "/api/tasks", { repoId: r.id, title: "New", ...limits });
    const batch = await send("POST", "/api/tasks/batch", { tasks: [{ repoId: r.id, title: "New", ...limits }] });
    const edit = await send("PATCH", `/api/tasks/${t.id}`, limits);
    for (const res of [create, batch, edit]) {
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toContain(message);
    }
    expect(getTask(db, t.id)).toMatchObject({ tokenBudget: t.tokenBudget, maxMinutes: t.maxMinutes });
  });

  // Value: protects=the token ceiling follows the current daily budget; fails_when=the ceiling is hard-coded; why_new=new rule; seam=none
  test("the token ceiling is the current daily budget", async () => {
    await patch({ dailyTokenBudget: 1_000_000 });
    const t = createTask(db, { repoId: repo().id, title: "T" });
    expect((await send("PATCH", `/api/tasks/${t.id}`, { tokenBudget: 2_000_000 })).status).toBe(400);
    const ok = await send("PATCH", `/api/tasks/${t.id}`, { tokenBudget: 500_000, maxMinutes: 600 });
    expect(ok.status).toBe(200);
    expect(getTask(db, t.id)).toMatchObject({ tokenBudget: 500_000, maxMinutes: 600 });
  });

  // Value: protects=Run now on a scheduled task clears runAt, and workflow edits stick; fails_when=runAt or workflow drop out of the PATCH whitelist again and the button silently does nothing; why_new=both fields were dropped by PATCH; seam=none
  test("PATCH saves runAt and workflow, and validates them", async () => {
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const t = createTask(db, { repoId: repo().id, title: "T", status: "queued", runAt: at });
    const runNow = await send("PATCH", `/api/tasks/${t.id}`, { runAt: null });
    expect(runNow.status).toBe(200);
    expect(getTask(db, t.id)?.runAt).toBeNull();

    expect((await send("PATCH", `/api/tasks/${t.id}`, { runAt: at, workflow: "quick" })).status).toBe(200);
    expect(getTask(db, t.id)).toMatchObject({ runAt: at, workflow: "quick" });

    expect((await send("PATCH", `/api/tasks/${t.id}`, { runAt: "tomorrow-ish" })).status).toBe(400);
    expect((await send("PATCH", `/api/tasks/${t.id}`, { workflow: "fast" })).status).toBe(400);
    expect(getTask(db, t.id)).toMatchObject({ runAt: at, workflow: "quick" });
  });

  // Value: protects=Run now or requeue can't put a task in the queue whose budget is above the daily budget (it would never start); fails_when=the PATCH queue check is dropped or checks the stored budget instead of the one in the patch; why_new=W1 such a task could be queued and sit there forever; seam=none
  test("queueing a task whose budget is above the daily budget is refused", async () => {
    // Paused, so the crew doesn't pick the task up between requests.
    await patch({ dailyTokenBudget: 1_200_000, dispatch: false });
    const r = repo();
    // The API refuses this budget, but an old task can still have one.
    const big = createTask(db, { repoId: r.id, title: "Big", status: "done", tokenBudget: 3_000_000 });

    const requeue = await send("PATCH", `/api/tasks/${big.id}`, { status: "queued" });
    expect(requeue.status).toBe(400);
    expect(await errorOf(requeue)).toBe(
      "This task's budget (3M tokens) is above the daily budget of 1.2M, so it could never start. Lower it, or raise the daily budget in Settings.",
    );
    expect(getTask(db, big.id)?.status).toBe("done");

    // Lowering the budget in the same patch is fine.
    const fixed = await send("PATCH", `/api/tasks/${big.id}`, { status: "queued", tokenBudget: 1_000_000 });
    expect(fixed.status).toBe(200);
    expect(getTask(db, big.id)).toMatchObject({ status: "queued", tokenBudget: 1_000_000 });

    // Run now on an already-queued task is checked too.
    updateTask(db, big.id, { tokenBudget: 3_000_000 });
    expect((await send("PATCH", `/api/tasks/${big.id}`, { runAt: null })).status).toBe(400);
    // Other edits still save.
    expect((await send("PATCH", `/api/tasks/${big.id}`, { title: "Renamed" })).status).toBe(200);
  });

  // Value: protects=moving a task to a missing repo is a 400 and notes on a missing task are a 404, not foreign-key 500s; fails_when=either existence check is dropped; why_new=both crashed in sqlite; seam=none
  test("unknown repo on PATCH → 400, notes on an unknown task → 404", async () => {
    const r = repo();
    const t = createTask(db, { repoId: r.id, title: "T" });
    const move = await send("PATCH", `/api/tasks/${t.id}`, { repoId: "repo_missing" });
    expect(move.status).toBe(400);
    expect(getTask(db, t.id)?.repoId).toBe(r.id);

    const note = await send("POST", "/api/tasks/task_missing/notes", { text: "hi" });
    expect(note.status).toBe(404);
    expect(await errorOf(note)).toBe("Task not found.");
  });
});
