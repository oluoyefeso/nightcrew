import {
  type AutonomyLevel,
  branchFor,
  DEFAULT_SETTINGS,
  DEFAULT_TASK_MINUTES,
  DEFAULT_TASK_TOKENS,
  type Repo,
  type Settings,
  type Task,
  type TaskNote,
  type TaskStatus,
  type TaskType,
} from "@nightcrew/core";
import { and, asc, eq, gt, inArray, max, sql } from "drizzle-orm";
import type { Db } from "./index";
import * as schema from "./schema";

const now = () => new Date().toISOString();
const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

// ── Repos ───────────────────────────────────────────────────────────────────

export function listRepos(db: Db): Repo[] {
  return db.select().from(schema.repos).orderBy(asc(schema.repos.name)).all().map(toRepo);
}

export function getRepo(db: Db, id: string): Repo | null {
  const r = db.select().from(schema.repos).where(eq(schema.repos.id, id)).get();
  return r ? toRepo(r) : null;
}

export function getRepoByPath(db: Db, path: string): Repo | null {
  const r = db.select().from(schema.repos).where(eq(schema.repos.path, path)).get();
  return r ? toRepo(r) : null;
}

export function addRepo(
  db: Db,
  input: {
    name: string;
    path: string;
    defaultBranch: string;
    protectedBranches?: string[];
    testCommand?: string | null;
    setupCommand?: string | null;
    previewCommand?: string | null;
    previewUrl?: string | null;
  },
): Repo {
  const existing = getRepoByPath(db, input.path);
  if (existing) return existing;
  const row = {
    id: newId("repo"),
    name: input.name,
    path: input.path,
    defaultBranch: input.defaultBranch,
    protectedBranches: input.protectedBranches ?? [],
    testCommand: input.testCommand ?? null,
    level: "draft_pr" as AutonomyLevel,
    createdAt: now(),
    setupCommand: input.setupCommand ?? null,
    previewCommand: input.previewCommand ?? null,
    previewUrl: input.previewUrl ?? null,
    previewPaths: ["/"],
    shipBranch: null,
    allowShip: [],
    alwaysAsk: [],
    policies: {},
  };
  db.insert(schema.repos).values(row).run();
  return toRepo(row);
}

export function updateRepo(
  db: Db,
  id: string,
  patch: Partial<
    Pick<
      Repo,
      | "name"
      | "defaultBranch"
      | "protectedBranches"
      | "testCommand"
      | "level"
      | "setupCommand"
      | "previewCommand"
      | "previewUrl"
      | "previewPaths"
      | "shipBranch"
      | "allowShip"
      | "alwaysAsk"
      | "policies"
    >
  >,
): Repo | null {
  // Drizzle refuses an update with nothing to set.
  if (Object.values(patch).some((v) => v !== undefined))
    db.update(schema.repos).set(patch).where(eq(schema.repos.id, id)).run();
  return getRepo(db, id);
}

export function removeRepo(db: Db, id: string) {
  db.delete(schema.repos).where(eq(schema.repos.id, id)).run();
}

function toRepo(r: typeof schema.repos.$inferSelect): Repo {
  const protectedBranches = [...new Set([r.defaultBranch, "main", "master", ...(r.protectedBranches ?? [])])];
  return { ...r, protectedBranches, level: r.level as AutonomyLevel };
}

// ── Tasks ───────────────────────────────────────────────────────────────────

export interface NewTask {
  repoId: string;
  title: string;
  brief?: string;
  type?: TaskType;
  scope?: string[];
  criteria?: string[];
  status?: TaskStatus;
  dependsOn?: string[];
  tokenBudget?: number;
  maxMinutes?: number;
  model?: string | null;
  testCommand?: string | null;
  question?: string | null;
  source?: Task["source"];
  sourceRef?: string | null;
  workflow?: Task["workflow"];
  runAt?: string | null;
}

export function createTask(db: Db, input: NewTask): Task {
  const type = input.type ?? "implementation";
  const status = input.status ?? "draft";
  const row = {
    id: newId("task"),
    repoId: input.repoId,
    title: input.title.trim(),
    brief: input.brief?.trim() ?? "",
    type,
    scope: input.scope ?? [],
    criteria: input.criteria ?? [],
    status,
    position: nextPosition(db, status),
    dependsOn: input.dependsOn ?? [],
    // The default never exceeds the daily budget, or the task could never start.
    tokenBudget: input.tokenBudget ?? Math.min(DEFAULT_TASK_TOKENS, getSettings(db).dailyTokenBudget),
    maxMinutes: input.maxMinutes ?? DEFAULT_TASK_MINUTES,
    branch: uniqueBranch(db, input.repoId, branchFor(input.title, type)),
    model: input.model ?? null,
    testCommand: input.testCommand ?? null,
    question: input.question ?? null,
    source: input.source ?? "manual",
    sourceRef: input.sourceRef ?? null,
    workflow: input.workflow ?? "auto",
    runAt: input.runAt ?? null,
    createdAt: now(),
    updatedAt: now(),
    lastRunId: null,
  };
  db.insert(schema.tasks).values(row).run();
  return getTask(db, row.id) as Task;
}

export type TaskPatch = Partial<
  Pick<
    Task,
    | "title"
    | "brief"
    | "type"
    | "scope"
    | "criteria"
    | "status"
    | "dependsOn"
    | "tokenBudget"
    | "maxMinutes"
    | "model"
    | "testCommand"
    | "question"
    | "repoId"
    | "lastRunId"
    | "workflow"
    | "runAt"
  >
>;

export function updateTask(db: Db, id: string, patch: TaskPatch): Task | null {
  const current = getTask(db, id);
  if (!current) return null;
  const set: Partial<typeof schema.tasks.$inferInsert> = { ...patch, updatedAt: now() };
  // Moving between lists puts the task at the end of its new list.
  if (patch.status && patch.status !== current.status) set.position = nextPosition(db, patch.status);
  db.update(schema.tasks).set(set).where(eq(schema.tasks.id, id)).run();
  return getTask(db, id);
}

export function deleteTask(db: Db, id: string) {
  db.delete(schema.tasks).where(eq(schema.tasks.id, id)).run();
}

export function getTask(db: Db, id: string): Task | null {
  const r = taskSelect(db).where(eq(schema.tasks.id, id)).get();
  return r ? toTask(r) : null;
}

export function listTasks(db: Db, statuses?: TaskStatus[]): Task[] {
  const q = taskSelect(db);
  const rows = statuses?.length
    ? q.where(inArray(schema.tasks.status, statuses)).orderBy(asc(schema.tasks.position)).all()
    : q.orderBy(asc(schema.tasks.position)).all();
  return rows.map(toTask);
}

/** Set the order of a list from an array of ids. */
export function reorderTasks(db: Db, ids: string[]) {
  db.transaction((tx) => {
    ids.forEach((id, i) => {
      tx.update(schema.tasks)
        .set({ position: i + 1 })
        .where(eq(schema.tasks.id, id))
        .run();
    });
  });
}

function taskSelect(db: Db) {
  return db
    .select({ task: schema.tasks, repoName: schema.repos.name })
    .from(schema.tasks)
    .innerJoin(schema.repos, eq(schema.repos.id, schema.tasks.repoId));
}

function toTask(r: { task: typeof schema.tasks.$inferSelect; repoName: string }): Task {
  return {
    ...r.task,
    repoName: r.repoName,
    type: r.task.type as TaskType,
    status: r.task.status as TaskStatus,
    source: r.task.source as Task["source"],
    workflow: r.task.workflow as Task["workflow"],
  };
}

function nextPosition(db: Db, status: string): number {
  const r = db
    .select({ m: max(schema.tasks.position) })
    .from(schema.tasks)
    .where(eq(schema.tasks.status, status))
    .get();
  return (r?.m ?? 0) + 1;
}

function uniqueBranch(db: Db, repoId: string, base: string): string {
  const taken = new Set(
    db
      .select({ b: schema.tasks.branch })
      .from(schema.tasks)
      .where(and(eq(schema.tasks.repoId, repoId), sql`${schema.tasks.branch} like ${`${base}%`}`))
      .all()
      .map((r) => r.b),
  );
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

/** Tokens the agents have used on a report day (input, cache and output). */
export function tokensOnDay(db: Db, dayId: string): number {
  return (
    db
      .select({ n: sql<number>`coalesce(sum(${schema.runs.tokensIn} + ${schema.runs.tokensOut}), 0)` })
      .from(schema.runs)
      .where(and(eq(schema.runs.nightId, dayId), sql`${schema.runs.source} != 'classic'`))
      .get()?.n ?? 0
  );
}

export function countRunsForTask(db: Db, taskId: string): number {
  return db.select({ n: sql<number>`count(*)` }).from(schema.runs).where(eq(schema.runs.taskId, taskId)).get()?.n ?? 0;
}

// ── Notes ───────────────────────────────────────────────────────────────────

export function addNote(db: Db, taskId: string, author: TaskNote["author"], body: string, runId?: string | null) {
  db.insert(schema.taskNotes)
    .values({ taskId, author, body, runId: runId ?? null, at: now() })
    .run();
}

export function listNotes(db: Db, taskId: string): TaskNote[] {
  return db
    .select()
    .from(schema.taskNotes)
    .where(eq(schema.taskNotes.taskId, taskId))
    .orderBy(asc(schema.taskNotes.id))
    .all()
    .map((n) => ({ ...n, author: n.author as TaskNote["author"] }));
}

// ── Run events ──────────────────────────────────────────────────────────────

export interface RunEvent {
  id: number;
  runId: string;
  at: string;
  phase: string;
  kind: "phase" | "text" | "tool" | "denied" | "result" | "error" | "info";
  text: string;
  data: unknown;
}

export function addRunEvent(db: Db, e: Omit<RunEvent, "id" | "at"> & { at?: string }): RunEvent {
  const row = { ...e, at: e.at ?? now(), data: e.data ?? null };
  const r = db.insert(schema.runEvents).values(row).returning({ id: schema.runEvents.id }).get();
  return { ...row, id: r.id };
}

export function listRunEvents(db: Db, runId: string, afterId = 0): RunEvent[] {
  return db
    .select()
    .from(schema.runEvents)
    .where(and(eq(schema.runEvents.runId, runId), gt(schema.runEvents.id, afterId)))
    .orderBy(asc(schema.runEvents.id))
    .all()
    .map((e) => ({ ...e, kind: e.kind as RunEvent["kind"] }));
}

// ── Settings ────────────────────────────────────────────────────────────────

export function getSettings(db: Db): Settings {
  const rows = db.select().from(schema.settings).all();
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value])) as Record<string, unknown>;
  // The night-era start time carries over as the schedule time.
  if (stored.scheduleAt === undefined && typeof stored.startAt === "string") stored.scheduleAt = stored.startAt;
  const known = Object.fromEntries(Object.entries(stored).filter(([k]) => k in DEFAULT_SETTINGS));
  return { ...DEFAULT_SETTINGS, ...known } as Settings;
}

export function updateSettings(db: Db, patch: Partial<Settings>): Settings {
  db.transaction((tx) => {
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in DEFAULT_SETTINGS) || value === undefined) continue;
      tx.insert(schema.settings)
        .values({ key, value })
        .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
        .run();
    }
  });
  return getSettings(db);
}
