import { type Mission, type MissionSummary, needsDecision } from "@nightcrew/core";
import { asc, eq } from "drizzle-orm";
import { type Db, getRunSummaries } from "./index";
import { missionTokens } from "./operations";
import * as schema from "./schema";
import { listTasks } from "./tasks";

export function getMission(db: Db, id: string): Mission | null {
  return db.select().from(schema.missions).where(eq(schema.missions.id, id)).get() ?? null;
}

export type NewMission = Pick<Mission, "title" | "objective"> &
  Partial<Pick<Mission, "criteria" | "paused" | "tokenBudget" | "priority" | "deadline" | "stopAt">>;

export function createMission(db: Db, input: NewMission): Mission {
  const at = new Date().toISOString();
  const mission = {
    id: `mission_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    title: input.title.trim(),
    objective: input.objective.trim(),
    paused: input.paused ?? false,
    criteria: input.criteria ?? [],
    tokenBudget: input.tokenBudget ?? null,
    priority: input.priority ?? 0,
    deadline: input.deadline ? new Date(input.deadline).toISOString() : null,
    stopAt: input.stopAt ? new Date(input.stopAt).toISOString() : null,
    createdAt: at,
    updatedAt: at,
  };
  db.insert(schema.missions).values(mission).run();
  return mission;
}

export function updateMission(
  db: Db,
  id: string,
  patch: Partial<
    Pick<Mission, "title" | "objective" | "paused" | "criteria" | "tokenBudget" | "priority" | "deadline" | "stopAt">
  >,
) {
  db.update(schema.missions)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(schema.missions.id, id))
    .run();
  return getMission(db, id);
}

export function deleteMission(db: Db, id: string) {
  db.delete(schema.missions).where(eq(schema.missions.id, id)).run();
}

export function listMissions(db: Db): MissionSummary[] {
  const tasks = listTasks(db);
  const runs = getRunSummaries(
    db,
    tasks
      .filter((task) => task.missionId && task.status === "done")
      .flatMap((task) => (task.lastRunId ? [task.lastRunId] : [])),
  );
  return db
    .select()
    .from(schema.missions)
    .orderBy(asc(schema.missions.createdAt))
    .all()
    .map((mission) => {
      const members = tasks.filter((task) => task.missionId === mission.id);
      const counts: MissionSummary["counts"] = {
        total: members.length,
        running: 0,
        queued: 0,
        parked: 0,
        needsYou: 0,
        resolved: 0,
      };
      for (const task of members) {
        if (task.status === "running") counts.running++;
        else if (task.status === "queued") counts.queued++;
        else if (task.status === "draft" || task.status === "later") counts.parked++;
        else {
          const run = task.lastRunId ? runs.get(task.lastRunId) : null;
          if (task.status !== "archived" && (!run || needsDecision(run))) counts.needsYou++;
          else counts.resolved++;
        }
      }
      return {
        ...mission,
        counts,
        tokensUsed: missionTokens(db, mission.id),
        taskCaps: members
          .filter((task) => task.status === "queued" || task.status === "running")
          .reduce((sum, task) => sum + task.tokenBudget, 0),
        repos: [...new Set(members.map((task) => task.repoName))],
      };
    });
}
