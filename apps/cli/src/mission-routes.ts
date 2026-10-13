import type { Mission } from "@nightcrew/core";
import {
  auditEvent,
  createMission,
  type Db,
  deleteMission,
  getMission,
  getRunSummaries,
  latestOperationJob,
  listMissions,
  listTasks,
  type NewMission,
  updateMission,
} from "@nightcrew/db";
import type { Crew } from "@nightcrew/runner";
import type { Hono } from "hono";

export function mountMissionRoutes(app: Hono, { db, crew }: { db: Db; crew: Crew }) {
  app.get("/api/missions", (c) => {
    c.header("cache-control", "no-store");
    return c.json(listMissions(db));
  });
  app.get("/api/missions/:id", (c) => {
    const mission = listMissions(db).find((m) => m.id === c.req.param("id"));
    if (!mission) return c.json({ error: "Mission not found." }, 404);
    const queue = new Map(crew.getQueue().map((entry) => [entry.taskId, entry]));
    const tasks = listTasks(db).filter((task) => task.missionId === mission.id);
    const runs = getRunSummaries(
      db,
      tasks.flatMap((task) => (task.lastRunId ? [task.lastRunId] : [])),
    );
    c.header("cache-control", "no-store");
    return c.json({
      mission,
      tasks: tasks.map((task) => ({
        task,
        run: task.lastRunId ? (runs.get(task.lastRunId) ?? null) : null,
        departure: queue.get(task.id) ?? null,
      })),
    });
  });
  app.post("/api/missions", async (c) => {
    const value: unknown = await c.req.json().catch(() => null);
    const error = validate(value, true);
    if (error) return c.json({ error }, 400);
    const input = value as NewMission;
    return c.json(createMission(db, input), 201);
  });
  app.patch("/api/missions/:id", async (c) => {
    const id = c.req.param("id");
    if (!getMission(db, id)) return c.json({ error: "Mission not found." }, 404);
    const value: unknown = await c.req.json().catch(() => null);
    const error = validate(value, false);
    if (error) return c.json({ error }, 400);
    const input = value as Partial<
      Pick<Mission, "title" | "objective" | "paused" | "criteria" | "tokenBudget" | "priority" | "deadline" | "stopAt">
    >;
    const patch = {
      ...(input.criteria !== undefined ? { criteria: input.criteria } : {}),
      ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.deadline !== undefined
        ? { deadline: input.deadline ? new Date(input.deadline).toISOString() : null }
        : {}),
      ...(input.stopAt !== undefined ? { stopAt: input.stopAt ? new Date(input.stopAt).toISOString() : null } : {}),
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.objective !== undefined ? { objective: input.objective.trim() } : {}),
      ...(input.paused !== undefined ? { paused: input.paused } : {}),
    };
    const result = updateMission(db, id, patch);
    auditEvent(db, "you", "mission.updated", id, Object.keys(patch).join(", "));
    void crew.pump();
    return c.json(result);
  });
  app.delete("/api/missions/:id", (c) => {
    const id = c.req.param("id");
    if (!getMission(db, id)) return c.json({ error: "Mission not found." }, 404);
    if (["running", "stopping"].includes(latestOperationJob(db, "mission", id)?.status ?? ""))
      return c.json({ error: "Stop mission verification and wait for cleanup before deleting it." }, 409);
    if (listTasks(db).some((task) => task.missionId === id))
      return c.json({ error: "Move or remove its tasks before deleting this mission." }, 409);
    deleteMission(db, id);
    return c.json({ ok: true });
  });
}

function validate(value: unknown, creating: boolean): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Provide a mission.";
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) =>
        !["title", "objective", "paused", "criteria", "tokenBudget", "priority", "deadline", "stopAt"].includes(key),
    )
  )
    return "Unknown mission field.";
  for (const field of ["title", "objective"]) {
    if (creating || field in input) {
      const text = input[field];
      if (typeof text !== "string" || !text.trim() || text.length > (field === "title" ? 200 : 10000))
        return `Give the mission a ${field === "title" ? "title (up to 200 characters)" : "clear objective (up to 10,000 characters)"}.`;
    }
  }
  if ("paused" in input && typeof input.paused !== "boolean") return "Paused must be true or false.";
  if (
    "criteria" in input &&
    (!Array.isArray(input.criteria) ||
      input.criteria.length > 30 ||
      input.criteria.some((c) => typeof c !== "string" || !c.trim() || c.length > 1000) ||
      new Set(input.criteria).size !== input.criteria.length)
  )
    return "Use up to 30 distinct acceptance criteria (1,000 characters each).";
  if (
    "tokenBudget" in input &&
    input.tokenBudget !== null &&
    (!Number.isSafeInteger(input.tokenBudget) || Number(input.tokenBudget) < 50000)
  )
    return "Mission budget must be at least 50,000 tokens, or null for no separate limit.";
  if (
    "priority" in input &&
    (!Number.isInteger(input.priority) || Number(input.priority) < 0 || Number(input.priority) > 3)
  )
    return "Priority must be between 0 and 3.";
  if (
    "deadline" in input &&
    input.deadline !== null &&
    (typeof input.deadline !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T/.test(input.deadline) ||
      Number.isNaN(Date.parse(input.deadline)))
  )
    return "Use an ISO start deadline or null.";
  if (
    "stopAt" in input &&
    input.stopAt !== null &&
    (typeof input.stopAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.stopAt) ||
      !Number.isFinite(Date.parse(input.stopAt)))
  )
    return "Use an ISO stop time with a timezone, or null.";
  return null;
}
