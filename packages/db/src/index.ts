/// <reference path="./sql.d.ts" />
import { Database } from "bun:sqlite";
import {
  type Artifact,
  type ArtifactKind,
  classify,
  type Night,
  type NightReport,
  needsDecision,
  type PrState,
  type Run,
  type RunDetail,
  type RunSource,
  type RunStatus,
  type StationReport,
  type TriageAction,
} from "@nightcrew/core";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import init from "../migrations/0000_init.sql" with { type: "text" };
import tasksMigration from "../migrations/0001_tasks.sql" with { type: "text" };
import previewMigration from "../migrations/0002_preview.sql" with { type: "text" };
import trustMigration from "../migrations/0003_trust.sql" with { type: "text" };
import scheduleMigration from "../migrations/0004_schedule.sql" with { type: "text" };
import tokensMigration from "../migrations/0005_tokens.sql" with { type: "text" };
import policiesMigration from "../migrations/0006_task_policies.sql" with { type: "text" };
import missionsMigration from "../migrations/0007_missions.sql" with { type: "text" };
import operationsMigration from "../migrations/0008_conductor_operations.sql" with { type: "text" };
import progressMigration from "../migrations/0009_operation_progress.sql" with { type: "text" };
import readinessMigration from "../migrations/0010_repository_readiness.sql" with { type: "text" };
import planningMigration from "../migrations/0011_mission_planning.sql" with { type: "text" };
import attentionMigration from "../migrations/0012_operation_attention.sql" with { type: "text" };
import missionStopMigration from "../migrations/0013_mission_stop.sql" with { type: "text" };
import connectionsMigration from "../migrations/0014_model_connections.sql" with { type: "text" };
import conductorMigration from "../migrations/0015_goal_conductor.sql" with { type: "text" };
import { auditEvent } from "./operations";
import * as schema from "./schema";
import { listTasks } from "./tasks";

export * from "./conductor";
export * from "./connections";
export * from "./dispatch";
export * from "./missions";
export * from "./operations";
export * from "./tasks";
export * from "./trust";
export { schema };

// Migrations are embedded so the compiled binary carries them. Append new
// drizzle-kit output here in order.
const MIGRATIONS: [name: string, sql: string][] = [
  ["0000_init", init],
  ["0001_tasks", tasksMigration],
  ["0002_preview", previewMigration],
  ["0003_trust", trustMigration],
  ["0004_schedule", scheduleMigration],
  ["0005_tokens", tokensMigration],
  ["0006_task_policies", policiesMigration],
  ["0007_missions", missionsMigration],
  ["0008_conductor_operations", operationsMigration],
  ["0009_operation_progress", progressMigration],
  ["0010_repository_readiness", readinessMigration],
  ["0011_mission_planning", planningMigration],
  ["0012_operation_attention", attentionMigration],
  ["0013_mission_stop", missionStopMigration],
  ["0014_model_connections", connectionsMigration],
  ["0015_goal_conductor", conductorMigration],
];

export type Db = BunSQLiteDatabase<typeof schema> & { $client: Database };

export function openDb(path: string): Db {
  const client = new Database(path, { create: true });
  client.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  migrate(client);
  return drizzle({ client, schema }) as Db;
}

function migrate(client: Database) {
  client.exec("CREATE TABLE IF NOT EXISTS __migrations (name TEXT PRIMARY KEY, at TEXT NOT NULL)");
  const done = new Set(
    client
      .query<{ name: string }, []>("SELECT name FROM __migrations")
      .all()
      .map((r) => r.name),
  );
  for (const [name, body] of MIGRATIONS) {
    if (done.has(name)) continue;
    client.transaction(() => {
      for (const stmt of body.split("--> statement-breakpoint")) {
        if (stmt.trim()) client.exec(stmt);
      }
      client.query("INSERT INTO __migrations (name, at) VALUES (?, ?)").run(name, new Date().toISOString());
    })();
  }
}

export type RunRow = typeof schema.runs.$inferInsert;
export type ArtifactRow = typeof schema.artifacts.$inferInsert;

/**
 * Insert or refresh imported runs. Triage decisions are left untouched, and so
 * are the `keep` fields of a run that's already stored (say, a PR state this
 * import couldn't refresh).
 */
export function upsertRuns(
  db: Db,
  rows: { run: RunRow; artifacts: Omit<ArtifactRow, "runId">[]; keep?: (keyof RunRow)[] }[],
) {
  db.transaction((tx) => {
    for (const { run, artifacts, keep } of rows) {
      if (run.missionId === undefined && run.source === "local") {
        const existing = tx
          .select({ missionId: schema.runs.missionId })
          .from(schema.runs)
          .where(eq(schema.runs.id, run.id))
          .get();
        run.missionId = existing
          ? existing.missionId
          : (tx
              .select({ missionId: schema.tasks.missionId })
              .from(schema.tasks)
              .where(eq(schema.tasks.id, run.taskId))
              .get()?.missionId ?? null);
      }
      const set: Partial<RunRow> = { ...run, id: undefined };
      for (const k of keep ?? []) delete set[k];
      tx.insert(schema.runs).values(run).onConflictDoUpdate({ target: schema.runs.id, set }).run();
      for (const a of artifacts) {
        tx.insert(schema.artifacts)
          .values({ ...a, runId: run.id })
          .onConflictDoUpdate({
            target: [schema.artifacts.runId, schema.artifacts.kind],
            set: { name: a.name, content: a.content },
          })
          .run();
      }
    }
  });
}

export function recordTriage(db: Db, runId: string, action: TriageAction, note: string | null) {
  db.insert(schema.triage).values({ runId, action, note, at: new Date().toISOString() }).run();
  auditEvent(db, "you", `run.${action}`, runId);
}

export function listNights(db: Db): Night[] {
  return db
    .select({
      id: schema.runs.nightId,
      startedAt: sql<string>`min(${schema.runs.startedAt})`,
      endedAt: sql<string>`max(coalesce(${schema.runs.endedAt}, ${schema.runs.startedAt}))`,
      runCount: sql<number>`count(distinct ${schema.runs.taskId})`,
      costCents: sql<number>`sum(${schema.runs.costCents})`,
    })
    .from(schema.runs)
    .groupBy(schema.runs.nightId)
    .orderBy(desc(schema.runs.nightId))
    .all();
}

export function getReport(db: Db, nightId?: string): NightReport | null {
  const nights = listNights(db);
  const idx = nightId ? nights.findIndex((n) => n.id === nightId) : 0;
  const night = nights[idx];
  if (!night) return null;

  const rows = db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.nightId, night.id))
    .orderBy(asc(schema.runs.startedAt))
    .all();

  // One entry per task: the latest attempt, carrying the attempt count.
  const latest = new Map<string, (typeof rows)[number]>();
  const attempts = new Map<string, number>();
  for (const r of rows) {
    attempts.set(r.taskId, (attempts.get(r.taskId) ?? 0) + 1);
    latest.set(r.taskId, r);
  }
  const picked = [...latest.values()];
  const runs = hydrate(db, picked).map((r) => ({ ...r, attempt: attempts.get(r.taskId) ?? 1 }));

  return {
    night,
    runs,
    previousId: nights[idx + 1]?.id ?? null,
    nextId: nights[idx - 1]?.id ?? null,
  };
}

export function getRun(db: Db, id: string): RunDetail | null {
  const row = db.select().from(schema.runs).where(eq(schema.runs.id, id)).get();
  if (!row) return null;
  const [run] = hydrate(db, [row]);
  if (!run) return null;
  const artifacts: Artifact[] = db
    .select({ kind: schema.artifacts.kind, name: schema.artifacts.name, content: schema.artifacts.content })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.runId, id))
    .all()
    .map((a) => ({ ...a, kind: a.kind as ArtifactKind }));
  artifacts.sort((a, b) => ARTIFACT_ORDER.indexOf(a.kind) - ARTIFACT_ORDER.indexOf(b.kind));
  const attempts = db
    .select({
      id: schema.runs.id,
      nightId: schema.runs.nightId,
      status: schema.runs.status,
      startedAt: schema.runs.startedAt,
      reason: schema.runs.reason,
    })
    .from(schema.runs)
    .where(and(eq(schema.runs.taskId, row.taskId), eq(schema.runs.repo, row.repo)))
    .orderBy(asc(schema.runs.startedAt))
    .all()
    .map((a) => ({ ...a, status: a.status as RunStatus }));
  return { run: { ...run, attempt: attempts.length }, artifacts, attempts };
}

/** Read display metadata in batches without loading artifact bodies or logs. */
export function getRunSummaries(db: Db, ids: string[]): Map<string, Run> {
  const unique = [...new Set(ids)];
  const out = new Map<string, Run>();
  for (let i = 0; i < unique.length; i += 400) {
    const rows = db
      .select()
      .from(schema.runs)
      .where(inArray(schema.runs.id, unique.slice(i, i + 400)))
      .all();
    for (const run of hydrate(db, rows)) out.set(run.id, run);
  }
  return out;
}

const ARTIFACT_ORDER: ArtifactKind[] = ["evidence", "policy", "report", "plan", "decisions", "review", "tests", "log"];

/** The Station spans report days and only shows the latest attempt of each task. */
export function getStation(db: Db): Omit<StationReport, "queue"> {
  const rows = db
    .select()
    .from(schema.runs)
    .where(sql`${schema.runs.id} IN (
    SELECT id FROM (
      SELECT id, row_number() OVER (
        PARTITION BY coalesce(repo_path, repo), task_id
        ORDER BY started_at DESC, rowid DESC
      ) AS rank FROM runs
    ) WHERE rank = 1
  )`)
    .orderBy(desc(schema.runs.startedAt))
    .all();
  const tasks = new Map(listTasks(db).map((t) => [t.id, t]));
  const runs: Run[] = [];
  // Keep hydration queries below SQLite's parameter limit on long-lived installs.
  for (let i = 0; i < rows.length; i += 400) runs.push(...hydrate(db, rows.slice(i, i + 400)));
  const decisions: Run[] = [];
  const recent: Run[] = [];
  for (const run of runs) {
    if (run.status === "running" || run.status === "pending") continue;
    const task = run.source === "classic" ? undefined : tasks.get(run.taskId);
    if (task && ["queued", "running", "draft", "later"].includes(task.status)) continue;
    if (needsDecision(run) && task?.status !== "archived") decisions.push(run);
    else if (recent.length < 12) recent.push(run);
  }
  // Put failures and requests for judgement first; oldest decisions first within each group.
  const priority = { failed: 0, eyes: 1, ready: 2, back: 3, shipped: 4 };
  decisions.sort(
    (a, b) => priority[a.bucket] - priority[b.bucket] || (a.startedAt ?? "").localeCompare(b.startedAt ?? ""),
  );
  return { decisions, recent, latestNightId: listNights(db)[0]?.id ?? null };
}

function hydrate(db: Db, rows: (typeof schema.runs.$inferSelect)[]): Run[] {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const triageRows = db
    .select()
    .from(schema.triage)
    .where(inArray(schema.triage.runId, ids))
    .orderBy(asc(schema.triage.id))
    .all();
  const lastTriage = new Map<string, { action: TriageAction; note: string | null }>();
  for (const t of triageRows) lastTriage.set(t.runId, { action: t.action as TriageAction, note: t.note });
  const kinds = new Map<string, ArtifactKind[]>();
  for (const a of db
    .select({ runId: schema.artifacts.runId, kind: schema.artifacts.kind })
    .from(schema.artifacts)
    .where(inArray(schema.artifacts.runId, ids))
    .all()) {
    kinds.set(a.runId, [...(kinds.get(a.runId) ?? []), a.kind as ArtifactKind]);
  }

  // A run counts as on its train only while its car is still on (not pulled or broken).
  const trainIds = [...new Set(rows.map((r) => r.trainId).filter((x): x is string => Boolean(x)))];
  const carOn = new Set<string>();
  if (trainIds.length)
    for (const t of db
      .select({ cars: schema.trains.cars })
      .from(schema.trains)
      .where(inArray(schema.trains.id, trainIds))
      .all())
      for (const car of t.cars) if (car.state === "on") carOn.add(car.runId);

  return rows.map((r) => {
    const t = lastTriage.get(r.id);
    const triage = t && t.action !== "undo" ? t.action : null;
    const status = r.status as RunStatus;
    const prState = r.prState as PrState | null;
    return {
      id: r.id,
      nightId: r.nightId,
      taskId: r.taskId,
      title: r.title,
      repo: r.repo,
      type: r.type,
      status,
      bucket: classify({
        status,
        prState,
        prUrl: r.prUrl,
        triage,
        verdict: r.verdict,
        type: r.type,
        shipped: Boolean(r.shipSha && !r.undoneAt),
        onTrain: Boolean(r.trainId) && carOn.has(r.id),
      }),
      source: r.source as RunSource,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      model: r.model,
      costCents: r.costCents,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
      attempt: r.attempt,
      prUrl: r.prUrl,
      prNumber: r.prNumber,
      prState,
      branch: r.branch,
      additions: r.additions,
      deletions: r.deletions,
      changedFiles: r.changedFiles,
      reason: r.reason,
      summary: r.summary,
      verdict: r.verdict,
      phase: r.phase,
      confidence: r.confidence,
      shipSha: r.shipSha,
      shipBranch: r.shipBranch,
      undoneAt: r.undoneAt,
      trainId: r.trainId,
      triage,
      note: triage ? (t?.note ?? null) : null,
      artifactKinds: (kinds.get(r.id) ?? []).sort((a, b) => ARTIFACT_ORDER.indexOf(a) - ARTIFACT_ORDER.indexOf(b)),
    };
  });
}
