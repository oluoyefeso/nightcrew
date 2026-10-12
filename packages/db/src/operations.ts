import type {
  AuditEntry,
  Checkpoint,
  Delivery,
  MissionAcceptance,
  OperationAttention,
  OperationJob,
  PolicyTemplate,
  RepositoryCheck,
} from "@nightcrew/core";
import { and, desc, eq, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
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

export function getTemplate(db: Db, id: string): PolicyTemplate | null {
  return db.select().from(schema.policyTemplates).where(eq(schema.policyTemplates.id, id)).get() ?? null;
}

/** Updating the library never edits a repository's copied routes. */
export function updateTemplate(
  db: Db,
  id: string,
  expectedUpdatedAt: string,
  input: Pick<PolicyTemplate, "name" | "policies">,
): PolicyTemplate | null {
  return db.transaction(() => {
    const current = getTemplate(db, id);
    if (!current || current.updatedAt !== expectedUpdatedAt) return null;
    const row = {
      ...input,
      id,
      updatedAt: new Date(Math.max(Date.now(), Date.parse(current.updatedAt) + 1)).toISOString(),
    };
    const result = db
      .update(schema.policyTemplates)
      .set(row)
      .where(and(eq(schema.policyTemplates.id, id), eq(schema.policyTemplates.updatedAt, expectedUpdatedAt)))
      .returning({ id: schema.policyTemplates.id })
      .get();
    if (!result) return null;
    auditEvent(db, "you", "policy.template.updated", id);
    return row;
  });
}

export function deleteTemplate(db: Db, id: string, expectedUpdatedAt: string): boolean {
  return db.transaction(() => {
    const result = db
      .delete(schema.policyTemplates)
      .where(and(eq(schema.policyTemplates.id, id), eq(schema.policyTemplates.updatedAt, expectedUpdatedAt)))
      .returning({ id: schema.policyTemplates.id })
      .get();
    if (!result) return false;
    auditEvent(db, "you", "policy.template.deleted", id);
    return true;
  });
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
    .orderBy(desc(schema.missionAcceptances.at), desc(sql`rowid`))
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
    .orderBy(desc(schema.deliveries.createdAt), desc(sql`rowid`))
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
    .orderBy(desc(schema.deliveries.createdAt), desc(sql`rowid`))
    .all() as Delivery[];
}

export function saveOperationJob(db: Db, row: OperationJob) {
  db.insert(schema.operationJobs).values(row).onConflictDoUpdate({ target: schema.operationJobs.id, set: row }).run();
}
export function getOperationJob(db: Db, id: string): OperationJob | null {
  return (db.select().from(schema.operationJobs).where(eq(schema.operationJobs.id, id)).get() as OperationJob) ?? null;
}
export function latestOperationJob(db: Db, kind: OperationJob["kind"], subjectId: string): OperationJob | null {
  return (
    (db
      .select()
      .from(schema.operationJobs)
      .where(and(eq(schema.operationJobs.kind, kind), eq(schema.operationJobs.subjectId, subjectId)))
      .orderBy(desc(schema.operationJobs.createdAt), desc(sql`rowid`))
      .get() as OperationJob) ?? null
  );
}
export function listOperationJobs(db: Db): OperationJob[] {
  const active = db
    .select()
    .from(schema.operationJobs)
    .where(inArray(schema.operationJobs.status, ["running", "stopping"]))
    .orderBy(desc(schema.operationJobs.createdAt))
    .all();
  const recent = db
    .select()
    .from(schema.operationJobs)
    .where(notInArray(schema.operationJobs.status, ["running", "stopping"]))
    .orderBy(desc(schema.operationJobs.createdAt))
    .limit(30)
    .all();
  return [...active, ...recent] as OperationJob[];
}
export function recoverOperationJobs(db: Db) {
  db.update(schema.operationJobs)
    .set({
      status: "interrupted",
      phase: "finished",
      updatedAt: new Date().toISOString(),
      detail:
        "The runner stopped before recording an outcome. Inspect the result before starting again; this action was not replayed.",
    })
    .where(inArray(schema.operationJobs.status, ["running", "stopping"]))
    .run();
}

export function saveRepositoryCheck(db: Db, row: RepositoryCheck) {
  db.insert(schema.repositoryChecks).values(row).run();
  auditEvent(db, "you", `repository.check.${row.status}`, row.repoId, row.id);
}
export function latestRepositoryCheck(db: Db, repoId: string): RepositoryCheck | null {
  return (
    (db
      .select()
      .from(schema.repositoryChecks)
      .where(eq(schema.repositoryChecks.repoId, repoId))
      .orderBy(desc(schema.repositoryChecks.at), desc(sql`rowid`))
      .get() as RepositoryCheck) ?? null
  );
}

export function getAcceptance(db: Db, id: string): MissionAcceptance | null {
  return (
    (db
      .select()
      .from(schema.missionAcceptances)
      .where(eq(schema.missionAcceptances.id, id))
      .get() as MissionAcceptance) ?? null
  );
}
export function getRepositoryCheck(db: Db, id: string): RepositoryCheck | null {
  return (
    (db.select().from(schema.repositoryChecks).where(eq(schema.repositoryChecks.id, id)).get() as RepositoryCheck) ??
    null
  );
}

export interface AttentionFilter {
  before?: string;
  kind?: OperationJob["kind"];
  status?: "failed" | "interrupted";
}
export function operationAttention(db: Db, filter: AttentionFilter = {}): OperationAttention {
  const table = schema.operationJobs;
  const where = and(
    inArray(table.status, ["failed", "interrupted"]),
    isNull(table.reviewedAt),
    filter.kind ? eq(table.kind, filter.kind) : undefined,
    filter.status ? eq(table.status, filter.status) : undefined,
  );
  const cursor = filter.before ? getOperationJob(db, filter.before) : null;
  const rows = db
    .select()
    .from(table)
    .where(
      and(
        where,
        cursor
          ? or(
              lt(table.createdAt, cursor.createdAt),
              and(eq(table.createdAt, cursor.createdAt), lt(table.id, cursor.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(table.createdAt), desc(table.id))
    .limit(31)
    .all() as OperationJob[];
  const jobs = rows.slice(0, 30);
  const total = db.select({ count: sql<number>`count(*)` }).from(table).where(where).get()!.count;
  return { jobs, total, nextCursor: rows.length > 30 ? jobs.at(-1)!.id : null };
}

/** A review acknowledgement never changes the result, job status or delivery retry gates. */
export function reviewOperation(db: Db, id: string, expectedUpdatedAt: string): OperationJob | null {
  return db.transaction(() => {
    const current = getOperationJob(db, id);
    if (!current || !["failed", "interrupted"].includes(current.status) || current.updatedAt !== expectedUpdatedAt)
      return null;
    if (current.reviewedAt) return current;
    const reviewedAt = new Date().toISOString();
    db.update(schema.operationJobs).set({ reviewedAt }).where(eq(schema.operationJobs.id, id)).run();
    auditEvent(db, "you", "operation.reviewed", id);
    return getOperationJob(db, id);
  });
}
