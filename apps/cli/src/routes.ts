// API for repos, tasks, the composer, the crew and its live event stream.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { nextStart, type Settings, TASK_TYPES, type TaskStatus, type TaskType } from "@nightcrew/core";
import {
  addNote,
  addRepo,
  createTask,
  type Db,
  deleteTask,
  getRepo,
  getRun,
  getSettings,
  getTask,
  listNotes,
  listRepos,
  listRunEvents,
  listTasks,
  type NewTask,
  removeRepo,
  reorderTasks,
  type TaskPatch,
  updateRepo,
  updateSettings,
  updateTask,
} from "@nightcrew/db";
import {
  type AgentEngine,
  type Crew,
  detectPreview,
  detectSetupCommand,
  detectTestCommand,
  draftTasks,
  inspectRepo,
} from "@nightcrew/runner";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";

const STATUSES: TaskStatus[] = ["draft", "queued", "later", "running", "done", "archived"];

export function mountTaskRoutes(app: Hono, deps: { db: Db; crew: Crew; engine: AgentEngine; dataDir: string }) {
  const { db, crew } = deps;
  const body = async <T>(c: { req: { json: <J>() => Promise<J> } }) =>
    (await c.req.json<T>().catch(() => ({}))) as Partial<T>;

  // ── Repos ──
  app.get("/api/repos", (c) => c.json(listRepos(db)));

  app.post("/api/repos", async (c) => {
    const { path } = await body<{ path: string }>(c);
    if (!path?.trim()) return c.json({ error: "Give the folder path of a git repository." }, 400);
    const expanded = path.trim().replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
    if (!existsSync(expanded)) return c.json({ error: `${expanded} doesn't exist.` }, 400);
    try {
      const info = await inspectRepo(expanded);
      const preview = detectPreview(info.path);
      const repo = addRepo(db, {
        name: info.name,
        path: info.path,
        defaultBranch: info.defaultBranch,
        testCommand: detectTestCommand(info.path),
        setupCommand: detectSetupCommand(info.path),
        previewCommand: preview?.command ?? null,
        previewUrl: preview?.url ?? null,
      });
      return c.json(repo, 201);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  app.patch("/api/repos/:id", async (c) => {
    const patch = await body<Parameters<typeof updateRepo>[2]>(c);
    const current = getRepo(db, c.req.param("id"));
    if (patch.shipBranch && current?.protectedBranches.includes(patch.shipBranch)) {
      return c.json({ error: `${patch.shipBranch} is protected. Pick a branch like dev or staging.` }, 400);
    }
    const repo = updateRepo(
      db,
      c.req.param("id"),
      pick(patch, [
        "name",
        "defaultBranch",
        "protectedBranches",
        "testCommand",
        "level",
        "setupCommand",
        "previewCommand",
        "previewUrl",
        "previewPaths",
        "shipBranch",
        "allowShip",
        "alwaysAsk",
      ]),
    );
    return repo ? c.json(repo) : c.json({ error: "Repo not found." }, 404);
  });

  app.delete("/api/repos/:id", (c) => {
    removeRepo(db, c.req.param("id"));
    return c.json({ ok: true });
  });

  // ── Tasks ──
  app.get("/api/tasks", (c) => {
    const statuses = (c.req.query("status") ?? "")
      .split(",")
      .filter((s): s is TaskStatus => (STATUSES as string[]).includes(s));
    return c.json(listTasks(db, statuses));
  });

  app.get("/api/tasks/:id", (c) => {
    const task = getTask(db, c.req.param("id"));
    if (!task) return c.json({ error: "Task not found." }, 404);
    const runs = runsForTask(db, task.id);
    return c.json({ task, notes: listNotes(db, task.id), runs });
  });

  app.post("/api/tasks", async (c) => {
    const input = await body<NewTask>(c);
    const err = validateTask(db, input);
    if (err) return c.json({ error: err }, 400);
    const created = createTask(db, { ...(input as NewTask), source: input.source ?? "manual" });
    void crew.pump();
    return c.json(created, 201);
  });

  /** Save a batch of composer drafts; dependsOn holds indexes within the batch. */
  app.post("/api/tasks/batch", async (c) => {
    const { tasks, status, when } = await body<{
      tasks: (NewTask & { dependsOnIndex?: number[] })[];
      status: TaskStatus;
      /** now (default): dispatch as soon as an agent is free. schedule: at the schedule time. later: park. */
      when: "now" | "schedule" | "later";
    }>(c);
    if (!Array.isArray(tasks) || tasks.length === 0) return c.json({ error: "No tasks to save." }, 400);
    for (const t of tasks) {
      const err = validateTask(db, t);
      if (err) return c.json({ error: err }, 400);
    }
    const created: string[] = [];
    for (const t of tasks) {
      const dependsOn = (t.dependsOnIndex ?? []).map((i) => created[i]).filter((x): x is string => Boolean(x));
      const s = t.question ? "draft" : when === "later" ? "later" : (status ?? "queued");
      const runAt = when === "schedule" ? nextStart(getSettings(db).scheduleAt).toISOString() : null;
      created.push(createTask(db, { ...t, dependsOn, status: s, runAt, source: "composer" }).id);
    }
    void crew.pump();
    return c.json(
      created.map((id) => getTask(db, id)),
      201,
    );
  });

  app.patch("/api/tasks/:id", async (c) => {
    const patch = await body<TaskPatch & { answer?: string }>(c);
    const id = c.req.param("id");
    const current = getTask(db, id);
    if (!current) return c.json({ error: "Task not found." }, 404);
    if (current.status === "running" && patch.status && patch.status !== "running") {
      return c.json({ error: "An agent is working on this task right now. Stop it first." }, 409);
    }
    // Answering the composer's question: keep it as a note and clear the flag.
    if (patch.answer?.trim() && current.question) {
      addNote(db, id, "you", `Q: ${current.question}\nA: ${patch.answer.trim()}`);
      patch.question = null;
    }
    const clean = pick(patch, [
      "title",
      "brief",
      "type",
      "scope",
      "criteria",
      "status",
      "dependsOn",
      "tokenBudget",
      "maxMinutes",
      "model",
      "testCommand",
      "question",
      "repoId",
    ]);
    if (clean.type && !TASK_TYPES.includes(clean.type as TaskType)) return c.json({ error: "Unknown task type." }, 400);
    if (clean.status && !STATUSES.includes(clean.status)) return c.json({ error: "Unknown status." }, 400);
    const updated = updateTask(db, id, clean);
    void crew.pump();
    return c.json(updated);
  });

  app.delete("/api/tasks/:id", (c) => {
    const t = getTask(db, c.req.param("id"));
    if (t?.status === "running") return c.json({ error: "Stop the crew before deleting a running task." }, 409);
    deleteTask(db, c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/api/tasks/reorder", async (c) => {
    const { ids } = await body<{ ids: string[] }>(c);
    if (!Array.isArray(ids)) return c.json({ error: "Send the task ids in their new order." }, 400);
    reorderTasks(db, ids);
    return c.json({ ok: true });
  });

  app.post("/api/tasks/:id/notes", async (c) => {
    const { text } = await body<{ text: string }>(c);
    if (!text?.trim()) return c.json({ error: "Write a note first." }, 400);
    addNote(db, c.req.param("id"), "you", text.trim());
    return c.json(listNotes(db, c.req.param("id")));
  });

  // ── Composer ──
  app.post("/api/compose", async (c) => {
    const { text, repoId } = await body<{ text: string; repoId?: string }>(c);
    if (!text?.trim()) return c.json({ error: "Describe what the crew should do." }, 400);
    try {
      const out = await draftTasks(deps.engine, {
        text,
        repos: listRepos(db),
        defaultRepoId: repoId,
        model: getSettings(db).buildModel,
      });
      return c.json(out);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  // ── Crew ──
  app.get("/api/crew", (c) => c.json(crew.getStatus()));
  /** Pause dispatch: running agents finish, nothing new starts. */
  app.post("/api/crew/pause", (c) => {
    updateSettings(db, { dispatch: false });
    return c.json(crew.getStatus());
  });
  app.post("/api/crew/resume", async (c) => {
    updateSettings(db, { dispatch: true });
    await crew.pump();
    return c.json(crew.getStatus());
  });
  /** Stop one agent (its work so far stays on its branch). */
  app.post("/api/crew/stop/:taskId", (c) => {
    if (!crew.stopAgent(c.req.param("taskId"))) return c.json({ error: "No agent is working on that task." }, 404);
    return c.json(crew.getStatus());
  });
  app.post("/api/crew/stop-all", (c) => {
    crew.stopAll();
    return c.json(crew.getStatus());
  });

  /** Screenshots and other files a run produced. */
  app.get("/api/runs/:id/files/*", (c) => {
    const id = c.req.param("id");
    const rel = decodeURIComponent(c.req.path.split(`/api/runs/${id}/files/`)[1] ?? "");
    if (!/^run_[a-z0-9]+$/.test(id) || !rel || rel.includes("..") || rel.startsWith("/"))
      return c.json({ error: "Not found." }, 404);
    const file = join(deps.dataDir, "runs", id, rel);
    if (!existsSync(file)) return c.json({ error: "Not found." }, 404);
    return new Response(Bun.file(file), { headers: { "cache-control": "public, max-age=31536000, immutable" } });
  });

  app.get("/api/runs/:id/events", (c) => {
    const after = Number(c.req.query("after") ?? 0) || 0;
    return c.json(listRunEvents(db, c.req.param("id"), after));
  });

  /** One stream for the whole dashboard: crew status and run events. */
  app.get("/api/stream", (c) =>
    streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "status", data: JSON.stringify(crew.getStatus()) });
      const unsubscribe = crew.subscribe((e) => {
        const data = e.type === "status" ? e.status : e.type === "report" ? e.outcome : e.event;
        void stream.writeSSE({ event: e.type, data: JSON.stringify(data) });
      });
      const ping = setInterval(() => void stream.writeSSE({ event: "ping", data: "" }), 20_000);
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(ping);
      unsubscribe();
    }),
  );

  // ── Settings ──
  app.get("/api/settings", (c) => c.json(getSettings(db)));
  app.patch("/api/settings", async (c) => {
    const patch = await body<Settings>(c);
    if (patch.scheduleAt && !/^([01]\d|2[0-3]):[0-5]\d$/.test(patch.scheduleAt))
      return c.json({ error: "Use a 24-hour time like 22:00." }, 400);
    if (
      patch.maxAgents !== undefined &&
      !(Number.isInteger(patch.maxAgents) && patch.maxAgents >= 1 && patch.maxAgents <= 12)
    )
      return c.json({ error: "Agents at once must be between 1 and 12." }, 400);
    if (
      patch.maxPerRepo !== undefined &&
      !(Number.isInteger(patch.maxPerRepo) && patch.maxPerRepo >= 1 && patch.maxPerRepo <= 6)
    )
      return c.json({ error: "Agents per repo must be between 1 and 6." }, 400);
    if (patch.slackWebhookUrl && !/^https:\/\/hooks\.slack\.com\//.test(patch.slackWebhookUrl))
      return c.json({ error: "Paste a Slack incoming webhook URL (https://hooks.slack.com/…)." }, 400);
    const next = updateSettings(db, patch);
    void crew.pump();
    return c.json(next);
  });
}

function validateTask(db: Db, t: Partial<NewTask>): string | null {
  if (!t.title?.trim()) return "Every task needs a title.";
  if (!t.repoId || !getRepo(db, t.repoId)) return "Pick a repo for the task.";
  if (t.type && !TASK_TYPES.includes(t.type)) return "Unknown task type.";
  return null;
}

function runsForTask(db: Db, taskId: string) {
  const task = getTask(db, taskId);
  if (!task?.lastRunId) return [];
  return getRun(db, task.lastRunId)?.attempts ?? [];
}

function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}
