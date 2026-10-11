import type { Mission } from "@nightcrew/core";
import {
  createMission,
  type Db,
  deleteMission,
  getMission,
  getRunSummaries,
  listMissions,
  listTasks,
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
    const input = value as Pick<Mission, "title" | "objective">;
    return c.json(createMission(db, input), 201);
  });
  app.patch("/api/missions/:id", async (c) => {
    const id = c.req.param("id");
    if (!getMission(db, id)) return c.json({ error: "Mission not found." }, 404);
    const value: unknown = await c.req.json().catch(() => null);
    const error = validate(value, false);
    if (error) return c.json({ error }, 400);
    const input = value as Partial<Pick<Mission, "title" | "objective" | "paused">>;
    const patch = {
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.objective !== undefined ? { objective: input.objective.trim() } : {}),
      ...(input.paused !== undefined ? { paused: input.paused } : {}),
    };
    const result = updateMission(db, id, patch);
    void crew.pump();
    return c.json(result);
  });
  app.delete("/api/missions/:id", (c) => {
    const id = c.req.param("id");
    if (!getMission(db, id)) return c.json({ error: "Mission not found." }, 404);
    if (listTasks(db).some((task) => task.missionId === id))
      return c.json({ error: "Move or remove its tasks before deleting this mission." }, 409);
    deleteMission(db, id);
    return c.json({ ok: true });
  });
}

function validate(value: unknown, creating: boolean): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Provide a mission.";
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["title", "objective", ...(creating ? [] : ["paused"])].includes(key)))
    return "Unknown mission field.";
  for (const field of ["title", "objective"]) {
    if (creating || field in input) {
      const text = input[field];
      if (typeof text !== "string" || !text.trim() || text.length > (field === "title" ? 200 : 10000))
        return `Give the mission a ${field === "title" ? "title (up to 200 characters)" : "clear objective (up to 10,000 characters)"}.`;
    }
  }
  if ("paused" in input && typeof input.paused !== "boolean") return "Paused must be true or false.";
  return null;
}
