// Trains, routines, shipping and each repo's track record.

import type { Routine, TaskType, Train, TrainCar } from "@nightcrew/core";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "./index";
import * as schema from "./schema";

const now = () => new Date().toISOString();
const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

// ── Trains ──────────────────────────────────────────────────────────────────

export function getOpenTrain(db: Db, repoId: string, nightId: string): Train | null {
  const r = db
    .select({ train: schema.trains, repoName: schema.repos.name })
    .from(schema.trains)
    .innerJoin(schema.repos, eq(schema.repos.id, schema.trains.repoId))
    .where(and(eq(schema.trains.repoId, repoId), eq(schema.trains.nightId, nightId)))
    .get();
  return r ? toTrain(r) : null;
}

export function createTrain(db: Db, input: { repoId: string; nightId: string; branch: string }): Train {
  const id = newId("train");
  db.insert(schema.trains)
    .values({ id, ...input, status: "open", cars: [], createdAt: now() })
    .run();
  return getTrain(db, id) as Train;
}

export function getTrain(db: Db, id: string): Train | null {
  const r = db
    .select({ train: schema.trains, repoName: schema.repos.name })
    .from(schema.trains)
    .innerJoin(schema.repos, eq(schema.repos.id, schema.trains.repoId))
    .where(eq(schema.trains.id, id))
    .get();
  return r ? toTrain(r) : null;
}

export function listTrains(db: Db, nightId?: string): Train[] {
  const q = db
    .select({ train: schema.trains, repoName: schema.repos.name })
    .from(schema.trains)
    .innerJoin(schema.repos, eq(schema.repos.id, schema.trains.repoId));
  const rows = nightId
    ? q.where(eq(schema.trains.nightId, nightId)).all()
    : q.orderBy(desc(schema.trains.createdAt)).all();
  return rows.map(toTrain);
}

export function updateTrain(db: Db, id: string, patch: Partial<Pick<Train, "status" | "prUrl" | "prNumber" | "cars">>) {
  db.update(schema.trains).set(patch).where(eq(schema.trains.id, id)).run();
  return getTrain(db, id);
}

export function addCar(db: Db, trainId: string, car: TrainCar) {
  const t = getTrain(db, trainId);
  if (!t) return null;
  return updateTrain(db, trainId, { cars: [...t.cars.filter((c) => c.runId !== car.runId), car] });
}

/** Change one car's state on a fresh read, so cars that boarded meanwhile stay on. */
export function setCarState(db: Db, trainId: string, runId: string, state: TrainCar["state"]) {
  return db.transaction(() => {
    const t = getTrain(db, trainId);
    if (!t) return null;
    return updateTrain(db, trainId, { cars: t.cars.map((c) => (c.runId === runId ? { ...c, state } : c)) });
  });
}

function toTrain(r: { train: typeof schema.trains.$inferSelect; repoName: string }): Train {
  return { ...r.train, repoName: r.repoName, status: r.train.status as Train["status"] };
}

// ── Run outcomes ────────────────────────────────────────────────────────────

export function markShipped(db: Db, runId: string, sha: string, branch: string) {
  db.update(schema.runs)
    .set({ shipSha: sha, shipBranch: branch, undoneAt: null })
    .where(eq(schema.runs.id, runId))
    .run();
}

export function markUndone(db: Db, runId: string) {
  db.update(schema.runs).set({ undoneAt: now() }).where(eq(schema.runs.id, runId)).run();
}

export function setRunTrain(db: Db, runId: string, trainId: string | null) {
  db.update(schema.runs).set({ trainId }).where(eq(schema.runs.id, runId)).run();
}

// ── Track record ────────────────────────────────────────────────────────────

export interface TrackRecord {
  repoId: string;
  /** Recent finished runs, newest first, with what you did with them. */
  recent: number;
  mergedAsIs: number;
  sentBack: number;
  undone: number;
  /** The next level up, if the record earns it. */
  suggestion: { level: "train" | "ship"; reason: string } | null;
}

const WINDOW = 10;

/** How the crew has done in a repo lately, and whether it has earned more trust. */
export function trackRecord(db: Db, repoId: string): TrackRecord {
  const repo = db.select().from(schema.repos).where(eq(schema.repos.id, repoId)).get();
  const runs = db
    .select({
      id: schema.runs.id,
      prState: schema.runs.prState,
      shipSha: schema.runs.shipSha,
      undoneAt: schema.runs.undoneAt,
    })
    .from(schema.runs)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.runs.taskId))
    .where(and(eq(schema.tasks.repoId, repoId), eq(schema.runs.status, "complete")))
    .orderBy(desc(schema.runs.startedAt))
    .limit(WINDOW)
    .all();
  const ids = runs.map((r) => r.id);
  const triage = ids.length ? db.select().from(schema.triage).where(inArray(schema.triage.runId, ids)).all() : [];
  const sentBackIds = new Set(triage.filter((t) => t.action === "send_back").map((t) => t.runId));
  const mergedIds = new Set(triage.filter((t) => t.action === "merge").map((t) => t.runId));
  let mergedAsIs = 0;
  let undone = 0;
  for (const r of runs) {
    if (r.undoneAt) undone++;
    else if (!sentBackIds.has(r.id) && (mergedIds.has(r.id) || r.prState === "merged" || r.shipSha)) mergedAsIs++;
  }
  const level = repo?.level ?? "draft_pr";
  let suggestion: TrackRecord["suggestion"] = null;
  const clean = sentBackIds.size === 0 && undone === 0;
  if (level === "draft_pr" && mergedAsIs >= 5 && clean) {
    suggestion = { level: "train", reason: `${mergedAsIs} of the last ${runs.length} tasks merged without changes.` };
  } else if (level === "train" && mergedAsIs >= 8 && clean) {
    suggestion = {
      level: "ship",
      reason: `${mergedAsIs} of the last ${runs.length} tasks merged without changes and nothing was sent back.`,
    };
  }
  return { repoId, recent: runs.length, mergedAsIs, sentBack: sentBackIds.size, undone, suggestion };
}

// ── Routines ────────────────────────────────────────────────────────────────

export function listRoutines(db: Db): Routine[] {
  return db
    .select({ r: schema.routines, repoName: schema.repos.name })
    .from(schema.routines)
    .innerJoin(schema.repos, eq(schema.repos.id, schema.routines.repoId))
    .all()
    .map(({ r, repoName }) => ({ ...r, repoName, type: r.type as TaskType }));
}

export function createRoutine(
  db: Db,
  input: {
    repoId: string;
    title: string;
    brief?: string;
    type?: TaskType;
    scope?: string[];
    criteria?: string[];
    days: number[];
  },
): Routine {
  const id = newId("routine");
  db.insert(schema.routines)
    .values({
      id,
      repoId: input.repoId,
      title: input.title.trim(),
      brief: input.brief ?? "",
      type: input.type ?? "implementation",
      scope: input.scope ?? [],
      criteria: input.criteria ?? [],
      days: [...new Set(input.days)].filter((d) => d >= 0 && d <= 6).sort(),
      enabled: true,
      lastNight: null,
      createdAt: now(),
    })
    .run();
  return listRoutines(db).find((r) => r.id === id) as Routine;
}

export function getRoutine(db: Db, id: string): Routine | null {
  return listRoutines(db).find((r) => r.id === id) ?? null;
}

export function updateRoutine(
  db: Db,
  id: string,
  patch: Partial<Pick<Routine, "title" | "brief" | "type" | "days" | "enabled" | "scope" | "criteria" | "lastNight">>,
) {
  const set = { ...patch };
  if (set.title !== undefined) set.title = set.title.trim();
  if (set.days) set.days = [...new Set(set.days)].filter((d) => d >= 0 && d <= 6).sort();
  // Drizzle refuses an update with nothing to set.
  if (Object.values(set).some((v) => v !== undefined))
    db.update(schema.routines).set(set).where(eq(schema.routines.id, id)).run();
  return getRoutine(db, id);
}

export function deleteRoutine(db: Db, id: string) {
  db.delete(schema.routines).where(eq(schema.routines.id, id)).run();
}
