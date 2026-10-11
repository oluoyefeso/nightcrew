import type { AuditEntry, Checkpoint, Delivery, MissionAcceptance, PolicyTemplate } from "@nightcrew/core";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import type { Db } from "./index";
import * as schema from "./schema";

export function auditEvent(db: Db, actor: AuditEntry["actor"], action: string, subjectId: string, detail = "") {
  db.insert(schema.audit).values({ at: new Date().toISOString(), actor, action, subjectId, detail }).run();
}
export function listAudit(db: Db, before?: number): AuditEntry[] {
  return db
    .select()
    .from(schema.audit)
    .where(before ? lt(schema.audit.id, before) : undefined)
    .orderBy(desc(schema.audit.id))
    .limit(100)
    .all() as AuditEntry[];
}
export function getCheckpoint(db: Db, taskId: string): Checkpoint | null {
  return (
    (db.select().from(schema.checkpoints).where(eq(schema.checkpoints.taskId, taskId)).get() as Checkpoint) ?? null
  );
}
export function saveCheckpoint(db: Db, checkpoint: Checkpoint) {
  db.insert(schema.checkpoints)
    .values(checkpoint)
    .onConflictDoUpdate({ target: schema.checkpoints.taskId, set: checkpoint })
    .run();
}
export function listTemplates(db: Db): PolicyTemplate[] {
  return db.select().from(schema.policyTemplates).orderBy(desc(schema.policyTemplates.updatedAt)).all();
}
export function saveTemplate(db: Db, input: Pick<PolicyTemplate, "name" | "policies">): PolicyTemplate {
  const row = { ...input, id: `policy_${crypto.randomUUID()}`, updatedAt: new Date().toISOString() };
  db.insert(schema.policyTemplates).values(row).run();
  auditEvent(db, "you", "policy.template.created", row.id);
  return row;
}
export function missionTokens(db: Db, missionId: string): number {
  return (
    db
      .select({ n: sql<number>`coalesce(sum(${schema.runs.tokensIn} + ${schema.runs.tokensOut}), 0)` })
      .from(schema.runs)
      .where(and(eq(schema.runs.missionId, missionId), eq(schema.runs.source, "local")))
      .get()?.n ?? 0
  );
}
export function listAcceptances(db: Db, missionId: string): MissionAcceptance[] {
  return db
    .select()
    .from(schema.missionAcceptances)
    .where(eq(schema.missionAcceptances.missionId, missionId))
    .orderBy(desc(schema.missionAcceptances.at))
    .limit(20)
    .all() as MissionAcceptance[];
}
export function saveAcceptance(db: Db, row: MissionAcceptance) {
  db.insert(schema.missionAcceptances).values(row).run();
  auditEvent(db, "you", `mission.acceptance.${row.status}`, row.missionId, row.id);
}
export function listDeliveries(db: Db, repoId?: string): Delivery[] {
  return db
    .select()
    .from(schema.deliveries)
    .where(repoId ? eq(schema.deliveries.repoId, repoId) : undefined)
    .orderBy(desc(schema.deliveries.createdAt))
    .limit(100)
    .all() as Delivery[];
}
export function getDelivery(db: Db, id: string): Delivery | null {
  return (db.select().from(schema.deliveries).where(eq(schema.deliveries.id, id)).get() as Delivery) ?? null;
}
export function saveDelivery(db: Db, row: Delivery) {
  db.insert(schema.deliveries).values(row).onConflictDoUpdate({ target: schema.deliveries.id, set: row }).run();
}
export function recoverDeliveries(db: Db) {
  db.update(schema.deliveries)
    .set({
      status: "interrupted",
      log: "NightCrew stopped during this action. Inspect the external outcome before retrying.",
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.deliveries.status, "running"))
    .run();
}

export function interruptRun(db: Db, id: string, reason: string) {
  db.update(schema.runs)
    .set({ status: "failed", phase: null, endedAt: new Date().toISOString(), reason })
    .where(and(eq(schema.runs.id, id), eq(schema.runs.status, "running")))
    .run();
}

/** Idempotency decisions use the full commit history, independently of dashboard pagination. */
export function deliveriesForCommit(db: Db, repoId: string, sha: string): Delivery[] {
  return db
    .select()
    .from(schema.deliveries)
    .where(and(eq(schema.deliveries.repoId, repoId), eq(schema.deliveries.sha, sha)))
    .orderBy(desc(schema.deliveries.createdAt))
    .all() as Delivery[];
}
