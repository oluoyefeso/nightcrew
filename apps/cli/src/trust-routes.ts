// API for the trust ladder: trains, ship/undo, track records, routines and
// GitHub issue intake.

import { TASK_TYPES, type TaskType } from "@nightcrew/core";
import {
  createRoutine,
  createTask,
  type Db,
  deleteRoutine,
  getRepo,
  getRoutine,
  getRun,
  getTrain,
  listRepos,
  listRoutines,
  listTasks,
  listTrains,
  markUndone,
  setCarState,
  trackRecord,
  updateRepo,
  updateRoutine,
} from "@nightcrew/db";
import { pullCar, undoShip } from "@nightcrew/runner";
import type { Hono } from "hono";
import { pick, shipBlocker } from "./routes";

export function mountTrustRoutes(app: Hono, deps: { db: Db; publish: boolean }) {
  const { db } = deps;
  const body = async <T>(c: { req: { json: <J>() => Promise<J> } }) =>
    (await c.req.json<T>().catch(() => ({}))) as Partial<T>;

  app.get("/api/trains", (c) => c.json(listTrains(db, c.req.query("night") || undefined)));

  app.get("/api/repos/:id/track", (c) => c.json(trackRecord(db, c.req.param("id"))));
  app.get("/api/track", (c) =>
    c.json(listRepos(db).map((r) => ({ ...trackRecord(db, r.id), repoName: r.name, level: r.level }))),
  );

  /** Move a repo up the ladder after you've read its track record. */
  app.post("/api/repos/:id/promote", async (c) => {
    const { level } = await body<{ level: "train" | "ship" }>(c);
    const repo = getRepo(db, c.req.param("id"));
    if (!repo) return c.json({ error: "Repo not found." }, 404);
    if (level !== "train" && level !== "ship") return c.json({ error: "Promote to train or ship." }, 400);
    const blocker = level === "ship" ? shipBlocker(repo) : null;
    if (blocker) return c.json({ error: blocker }, 400);
    return c.json(updateRepo(db, repo.id, { level }));
  });

  /** Undo a ship: revert it on the ship branch, and drop the repo back to the train. */
  app.post("/api/runs/:id/unship", async (c) => {
    const detail = getRun(db, c.req.param("id"));
    const run = detail?.run;
    if (!run?.shipSha || !run.shipBranch || run.undoneAt)
      return c.json({ error: "This run wasn't shipped, or it's already undone." }, 400);
    const task = listTasks(db).find((t) => t.id === run.taskId);
    const repo = task ? getRepo(db, task.repoId) : null;
    if (!repo) return c.json({ error: "Repo not found." }, 404);
    const r = await undoShip(repo, run.shipBranch, run.shipSha, deps.publish);
    if (!r.ok) return c.json({ error: r.error }, 409);
    markUndone(db, run.id);
    if (repo.level === "ship") updateRepo(db, repo.id, { level: "train" });
    return c.json({ ok: true, revert: r.sha, demoted: repo.level === "ship" });
  });

  /** Take a task off its train. */
  app.post("/api/runs/:id/pull", async (c) => {
    const run = getRun(db, c.req.param("id"))?.run;
    if (!run?.trainId) return c.json({ error: "This run isn't on a train." }, 400);
    const train = getTrain(db, run.trainId);
    const car = train?.cars.find((x) => x.runId === run.id);
    const repo = train ? getRepo(db, train.repoId) : null;
    if (!train || !car || !repo || car.state !== "on") return c.json({ error: "It's already off the train." }, 400);
    const r = await pullCar(repo, train, car.mergeSha, deps.publish);
    if (!r.ok) return c.json({ error: r.error }, 409);
    // pullCar can wait minutes behind the repo lock while other cars board, so
    // change this one car on a fresh read instead of writing back the snapshot.
    return c.json(setCarState(db, train.id, run.id, "pulled"));
  });

  // ── Routines ──
  app.get("/api/routines", (c) => c.json(listRoutines(db)));
  app.post("/api/routines", async (c) => {
    const r = await body<{
      repoId: string;
      title: string;
      brief: string;
      type: TaskType;
      days: number[];
      scope: string[];
      criteria: string[];
    }>(c);
    if (!r.title?.trim()) return c.json({ error: "Give the routine a title." }, 400);
    if (!r.repoId || !getRepo(db, r.repoId)) return c.json({ error: "Pick a repo." }, 400);
    if (!r.days?.length) return c.json({ error: "Pick at least one day." }, 400);
    if (r.type && !TASK_TYPES.includes(r.type)) return c.json({ error: "Unknown task type." }, 400);
    const err = routineTextError(r);
    if (err) return c.json({ error: err }, 400);
    return c.json(createRoutine(db, { ...r, title: r.title, repoId: r.repoId, days: r.days }), 201);
  });
  app.patch("/api/routines/:id", async (c) => {
    const id = c.req.param("id");
    if (!getRoutine(db, id)) return c.json({ error: "Routine not found." }, 404);
    const raw = await body<NonNullable<Parameters<typeof updateRoutine>[2]>>(c);
    const r = pick(raw, ["title", "brief", "type", "days", "enabled", "scope", "criteria"]);
    if (Object.keys(r).length === 0) return c.json({ error: "Nothing to change." }, 400);
    if (r.title !== undefined && !(typeof r.title === "string" && r.title.trim()))
      return c.json({ error: "Give the routine a title." }, 400);
    if (r.type !== undefined && !TASK_TYPES.includes(r.type)) return c.json({ error: "Unknown task type." }, 400);
    if (
      r.days !== undefined &&
      !(Array.isArray(r.days) && r.days.length && r.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6))
    )
      return c.json({ error: "Pick at least one day." }, 400);
    if (r.enabled !== undefined && typeof r.enabled !== "boolean")
      return c.json({ error: "Turn the routine on or off (true or false)." }, 400);
    const err = routineTextError(r);
    if (err) return c.json({ error: err }, 400);
    return c.json(updateRoutine(db, id, r));
  });
  app.delete("/api/routines/:id", (c) => {
    deleteRoutine(db, c.req.param("id"));
    return c.json({ ok: true });
  });

  /** Pull open GitHub issues labelled "crew" into Later. */
  app.post("/api/intake/github", async (c) => {
    const known = new Set(
      listTasks(db)
        .map((t) => t.sourceRef)
        .filter(Boolean),
    );
    let added = 0;
    const errors: string[] = [];
    for (const repo of listRepos(db)) {
      const proc = Bun.spawn(
        [
          "gh",
          "issue",
          "list",
          "--label",
          "crew",
          "--state",
          "open",
          "--limit",
          "50",
          "--json",
          "number,title,body,url",
        ],
        {
          cwd: repo.path,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) {
        if (!/no git remotes|not a git repository|could not determine/i.test(err))
          errors.push(`${repo.name}: ${err.trim().split("\n")[0]}`);
        continue;
      }
      for (const issue of JSON.parse(out || "[]") as { number: number; title: string; body: string; url: string }[]) {
        if (known.has(issue.url)) continue;
        createTask(db, {
          repoId: repo.id,
          title: issue.title,
          brief: `${issue.body ?? ""}\n\nFrom ${issue.url}. The PR will close the issue.`.trim(),
          type: /\b(bug|fix|broken|crash|error)\b/i.test(`${issue.title} ${issue.body}`) ? "bugfix" : "implementation",
          status: "later",
          source: "github",
          sourceRef: issue.url,
        });
        added++;
      }
    }
    return c.json({ added, errors });
  });
}

/** The brief is text, scope and criteria are lists of text, on create and edit alike. */
function routineTextError(r: { brief?: unknown; scope?: unknown; criteria?: unknown }): string | null {
  const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
  if (r.brief !== undefined && typeof r.brief !== "string") return "Write the brief as text.";
  if (r.scope !== undefined && !strings(r.scope)) return "Scope is a list of file globs, like src/**.";
  if (r.criteria !== undefined && !strings(r.criteria)) return "Criteria are a list of sentences.";
  return null;
}
