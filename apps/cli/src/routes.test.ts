import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addRepo,
  createTask,
  type Db,
  getRepo,
  getSettings,
  getTask,
  listRepos,
  openDb,
  updateTask,
} from "@nightcrew/db";
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
  test("an optional webhook can be cleared without losing other settings", async () => {
    expect((await patch({ slackWebhookUrl: "https://hooks.slack.com/services/example", maxAgents: 2 })).status).toBe(
      200,
    );
    const cleared = await patch({ slackWebhookUrl: null });
    expect(cleared.status).toBe(200);
    expect(getSettings(db)).toMatchObject({ slackWebhookUrl: null, maxAgents: 2 });
  });

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
  test("preflight is read-only and validates composer dependency indexes", async () => {
    const repo = addRepo(db, { name: "demo", path: "/demo/repo", defaultBranch: "main" });
    const tasks = [
      { repoId: repo.id, title: "First", type: "ui" },
      { repoId: repo.id, title: "Second", dependsOnIndex: [0] },
    ];
    const before = db.$client.query("SELECT count(*) AS n FROM tasks").get();
    const response = await send("POST", "/api/preflight", { tasks });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const result = (await response.json()) as {
      tasks: { signals: { code: string }[] }[];
      budget: { reserved: number };
    };
    expect(result.tasks[0]?.signals.some((s) => s.code === "preview")).toBe(true);
    expect(result.tasks[1]?.signals.some((s) => s.code === "dependency")).toBe(true);
    expect(result.budget.reserved).toBe(0);
    expect(db.$client.query("SELECT count(*) AS n FROM tasks").get()).toEqual(before);
    for (const input of [
      null,
      { tasks: [null] },
      { tasks: [{ ...tasks[0], scope: "src/**" }] },
      { tasks: [{ ...tasks[0], dependsOnIndex: [1] }] },
      { tasks: [{ ...tasks[0], tokenBudget: -1 }] },
    ]) {
      expect((await send("POST", "/api/preflight", input)).status).toBe(400);
    }
    expect(
      (await send("POST", "/api/tasks/batch", { tasks: [{ ...tasks[0], dependsOnIndex: [1] }], when: "later" })).status,
    ).toBe(400);
    expect(db.$client.query("SELECT count(*) AS n FROM tasks").get()).toEqual(before);
  });
  test("task routes persist and malformed policies are rejected without changing them", async () => {
    const repo = addRepo(db, { name: "acme", path: "/code/acme", defaultBranch: "main" });
    const policies = {
      refactor: { autonomy: "draft_pr" as const, requireTests: true, visual: false, regression: false },
    };
    expect((await send("PATCH", `/api/repos/${repo.id}`, { policies })).status).toBe(200);
    expect(getRepo(db, repo.id)?.policies).toEqual(policies);
    for (const bad of [
      null,
      [],
      { unknown: policies.refactor },
      { refactor: { ...policies.refactor, requireTests: "yes" } },
    ]) {
      expect((await send("PATCH", `/api/repos/${repo.id}`, { policies: bad })).status).toBe(400);
      expect(getRepo(db, repo.id)?.policies).toEqual(policies);
    }
    expect((await send("PATCH", `/api/repos/${repo.id}`, { policies: {} })).status).toBe(200);
    expect(getRepo(db, repo.id)?.policies).toEqual({});
  });

  test("a running task cannot change the type or repo that determines its route", async () => {
    const repo = addRepo(db, { name: "acme", path: "/code/acme", defaultBranch: "main" });
    const other = addRepo(db, { name: "other", path: "/code/other", defaultBranch: "main" });
    const task = createTask(db, { repoId: repo.id, title: "Busy", status: "running" });
    for (const change of [{ type: "research" }, { repoId: other.id }]) {
      expect((await send("PATCH", `/api/tasks/${task.id}`, change)).status).toBe(409);
      expect(getTask(db, task.id)).toEqual(task);
    }
    expect((await send("PATCH", `/api/tasks/${task.id}`, { scope: ["src/**"] })).status).toBe(200);
  });

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

describe("POST /api/repos", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const repoWith = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "nc-repo-add-"));
    dirs.push(dir);
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    for (const args of [
      ["init", "-q", "-b", "main"],
      ["add", "-A"],
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"],
    ])
      Bun.spawnSync(["git", ...args], { cwd: dir });
    return dir;
  };

  // Value: protects=a repo using git-lfs is refused with the reason before it's saved, and a plain repo still adds; fails_when=POST /api/repos stops calling repoSupport or saves the repo anyway; why_new=H2 (D15) refuses lfs, git-crypt and sparse repos; seam=none
  test("a git-lfs repo → 400 with the reason, a plain repo → 201", async () => {
    const lfs = repoWith({ ".gitattributes": "*.bin filter=lfs diff=lfs merge=lfs -text\n", "a.txt": "a\n" });
    const res = await send("POST", "/api/repos", { path: lfs });
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toStartWith("NightCrew can't work in this repo yet: it uses ");
    expect(error).toContain("lfs");
    expect(error).toEndWith(". Support is coming; see docs/security.md.");
    expect(listRepos(db)).toHaveLength(0);

    const plain = repoWith({ "a.txt": "a\n" });
    expect((await send("POST", "/api/repos", { path: plain })).status).toBe(201);
    expect(listRepos(db)).toHaveLength(1);
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

  test("a composer batch links dependencies by index, parks questions as drafts, and an answer clears the question", async () => {
    // Value: protects=composer drafts keep their order of work (dependsOnIndex → the created ids), a draft with a question waits as a draft, when=later/schedule park or time the rest, and answering keeps the Q&A as a note; fails_when=dependsOnIndex maps to the wrong task or is dropped (a dependent runs first), a question task gets queued, or the answer isn't saved or the question isn't cleared; why_new=batch tests cover status and limits only, PATCH answer had no test; seam=none; no_claim=what the composer drafts (no LLM; the batch body is written by hand)
    await patch({ dispatch: false });
    const r = repo();
    const later = await send("POST", "/api/tasks/batch", {
      when: "later",
      tasks: [
        { repoId: r.id, title: "Add the API" },
        { repoId: r.id, title: "Use it in the UI", dependsOnIndex: [0] },
        { repoId: r.id, title: "Pick a chart", question: "Bar or line?", dependsOnIndex: [1] },
      ],
    });
    expect(later.status).toBe(201);
    const [api, ui, chart] = (await later.json()) as { id: string; status: string; dependsOn: string[] }[];
    expect([api?.status, ui?.status, chart?.status]).toEqual(["later", "later", "draft"]);
    expect(ui?.dependsOn).toEqual([api?.id as string]);
    expect(chart?.dependsOn).toEqual([ui?.id as string]);

    const scheduled = await send("POST", "/api/tasks/batch", {
      when: "schedule",
      tasks: [{ repoId: r.id, title: "Overnight cleanup" }],
    });
    const [night] = (await scheduled.json()) as { status: string; runAt: string | null }[];
    expect(night?.status).toBe("queued");
    const [h = -1, m = -1] = getSettings(db).scheduleAt.split(":").map(Number);
    const at = new Date(night?.runAt ?? "");
    expect([at.getHours(), at.getMinutes()]).toEqual([h, m]);
    expect(at.getTime()).toBeGreaterThan(Date.now());

    const refused = await send("PATCH", `/api/tasks/${chart?.id}`, { answer: "Line.", status: "running" });
    expect(refused.status).toBe(400);
    expect(getTask(db, chart?.id as string)?.question).toBe("Bar or line?");
    const before = await (await app.request(`/api/tasks/${chart?.id}`)).json();
    expect((before as { notes: unknown[] }).notes).toEqual([]);

    const answered = await send("PATCH", `/api/tasks/${chart?.id}`, { answer: "  Line.  " });
    expect(answered.status).toBe(200);
    expect(getTask(db, chart?.id as string)?.question).toBeNull();
    const notes = await (await app.request(`/api/tasks/${chart?.id}`)).json();
    expect((notes as { notes: { body: string }[] }).notes.map((n) => n.body)).toEqual(["Q: Bar or line?\nA: Line."]);
  });
});

describe("GET /api/runs/:id/files/*", () => {
  const dirs: string[] = [];
  let data: string;
  let runDir: string;
  beforeEach(() => {
    data = mkdtempSync(join(tmpdir(), "nc-files-"));
    dirs.push(data);
    runDir = join(data, "runs", "run_abc");
    mkdirSync(join(runDir, "shots"), { recursive: true });
    const engine = new ScriptedEngine({});
    app = new Hono();
    mountTaskRoutes(app, { db, crew: new Crew({ db, engine, dataDir: data, publish: false }), engine, dataDir: data });
  });
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const get = (rel: string) => app.request(`/api/runs/run_abc/files/${rel}`);
  const locked = (res: Response) => {
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
  };

  test("images are images; HTML, SVG and the rest are plain-text downloads", async () => {
    // Value: protects=an agent-written HTML or SVG file can't run script on the dashboard origin; fails_when=the route guesses an active type, drops nosniff/CSP, or serves non-images inline; why_new=X2, run files were served with extension-guessed types; seam=none
    writeFileSync(join(runDir, "shots", "a.png"), "png");
    writeFileSync(join(runDir, "x.html"), "<script>alert(1)</script>");
    writeFileSync(join(runDir, "x.svg"), "<svg onload=alert(1)>");
    writeFileSync(join(runDir, "notes.md"), "# hi");
    const png = await get("shots/a.png");
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(png.headers.get("content-disposition")).toBeNull();
    locked(png);
    for (const rel of ["x.html", "x.svg", "notes.md"]) {
      const res = await get(rel);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(res.headers.get("content-disposition")).toBe("attachment");
      locked(res);
    }
  });

  test("symlinks and paths out of the run folder are refused", async () => {
    // Value: protects=an agent can't plant a symlink to read files outside its run folder (or run a linked HTML); fails_when=the route follows symlinks or stops checking the real path; why_new=X2; seam=none
    const secret = join(data, "secret.txt");
    writeFileSync(secret, "token");
    symlinkSync(secret, join(runDir, "leak.txt"));
    symlinkSync(join(data), join(runDir, "up"));
    for (const rel of ["leak.txt", "up/secret.txt", "..%2Fsecret.txt", "missing.png", "shots"]) {
      const res = await get(rel);
      expect(res.status).toBe(404);
      locked(res);
    }
  });
});
