import { type GoalConductor, type GoalResult, nightIdFor } from "@nightcrew/core";
import { eq, sql } from "drizzle-orm";
import type { Db } from "./index";
import * as schema from "./schema";

export function getConductor(db: Db, missionId: string): GoalConductor | null {
  return (
    db.select().from(schema.goalConductors).where(eq(schema.goalConductors.missionId, missionId)).get()?.body ?? null
  );
}
export function listConductors(db: Db): GoalConductor[] {
  return db
    .select()
    .from(schema.goalConductors)
    .all()
    .map((row) => row.body);
}
export function saveConductor(db: Db, body: GoalConductor) {
  body = { ...body, updatedAt: new Date().toISOString() };
  db.insert(schema.goalConductors)
    .values({ missionId: body.missionId, body })
    .onConflictDoUpdate({ target: schema.goalConductors.missionId, set: { body } })
    .run();
  return body;
}
export function saveGoalResult(db: Db, body: GoalResult) {
  db.insert(schema.goalResults).values({ id: body.id, missionId: body.missionId, body }).run();
}
export function getGoalResult(db: Db, id: string): GoalResult | null {
  return db.select().from(schema.goalResults).where(eq(schema.goalResults.id, id)).get()?.body ?? null;
}
export function conductorTokens(db: Db, filter: { missionId: string } | { dayId: string }): number {
  return (
    db
      .select({ n: sql<number>`coalesce(sum(${schema.goalUsage.charged}), 0)` })
      .from(schema.goalUsage)
      .where(
        "missionId" in filter
          ? eq(schema.goalUsage.missionId, filter.missionId)
          : eq(schema.goalUsage.dayId, filter.dayId),
      )
      .get()?.n ?? 0
  );
}
export function reserveGoalCall(db: Db, missionId: string, phase: string, reserved: number): string {
  const id = `goal_call_${crypto.randomUUID()}`;
  db.insert(schema.goalUsage)
    .values({
      id,
      missionId,
      phase,
      reserved,
      charged: reserved,
      status: "running",
      dayId: nightIdFor(new Date().toISOString()),
    })
    .run();
  return id;
}
export function finishGoalCall(
  db: Db,
  id: string,
  usage: { tokensIn: number; tokensOut: number; costUsd: number; reported: boolean },
) {
  const row = db.select().from(schema.goalUsage).where(eq(schema.goalUsage.id, id)).get();
  if (!row) return;
  const valid = [usage.tokensIn, usage.tokensOut, usage.costUsd].every((n) => Number.isFinite(n) && n >= 0);
  const tokensIn = Math.max(row.tokensIn, valid ? Math.ceil(usage.tokensIn) : 0);
  const tokensOut = Math.max(row.tokensOut, valid ? Math.ceil(usage.tokensOut) : 0);
  const reported = valid && usage.reported && usage.tokensIn >= row.tokensIn && usage.tokensOut >= row.tokensOut;
  db.update(schema.goalUsage)
    .set({
      tokensIn,
      tokensOut,
      costUsd: valid ? usage.costUsd : 0,
      charged: reported ? tokensIn + tokensOut : Math.max(row.reserved, tokensIn + tokensOut),
      status: reported ? "reported" : "unknown",
    })
    .where(eq(schema.goalUsage.id, id))
    .run();
}
export function observeGoalCall(db: Db, id: string, tokensIn: number, tokensOut: number) {
  if (![tokensIn, tokensOut].every((n) => Number.isSafeInteger(n) && n >= 0)) return;
  const row = db.select().from(schema.goalUsage).where(eq(schema.goalUsage.id, id)).get();
  if (!row) return;
  tokensIn = Math.max(row.tokensIn, tokensIn);
  tokensOut = Math.max(row.tokensOut, tokensOut);
  db.update(schema.goalUsage)
    .set({ tokensIn, tokensOut, charged: Math.max(row.reserved, tokensIn + tokensOut) })
    .where(eq(schema.goalUsage.id, id))
    .run();
}
export function recoverConductors(db: Db) {
  db.update(schema.goalUsage).set({ status: "interrupted" }).where(eq(schema.goalUsage.status, "running")).run();
  for (const state of listConductors(db)) {
    if (state.state === "planning" || state.state === "verifying")
      saveConductor(db, {
        ...state,
        state: "needs_you",
        code: "interrupted",
        detail: "Coordination was interrupted. Reserved usage is retained; continue when ready.",
      });
  }
}
export function getTaskHandoff(db: Db, taskId: string) {
  return db.select().from(schema.taskHandoffs).where(eq(schema.taskHandoffs.taskId, taskId)).get() ?? null;
}
export function saveTaskHandoff(db: Db, taskId: string, fingerprint: string, base: string) {
  db.insert(schema.taskHandoffs).values({ taskId, fingerprint, base }).run();
}
