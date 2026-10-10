import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    nightId: text("night_id").notNull(),
    sessionId: text("session_id").notNull(),
    taskId: text("task_id").notNull(),
    title: text("title").notNull(),
    repo: text("repo").notNull(),
    repoPath: text("repo_path"),
    type: text("type"),
    status: text("status").notNull(),
    source: text("source").notNull(),
    startedAt: text("started_at"),
    endedAt: text("ended_at"),
    model: text("model"),
    costCents: integer("cost_cents").notNull().default(0),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    attempt: integer("attempt").notNull().default(1),
    prUrl: text("pr_url"),
    prNumber: integer("pr_number"),
    prState: text("pr_state"),
    branch: text("branch"),
    additions: integer("additions"),
    deletions: integer("deletions"),
    changedFiles: integer("changed_files"),
    reason: text("reason"),
    summary: text("summary"),
    /** plan | implement | review | validate | publish while running. */
    phase: text("phase"),
    worktree: text("worktree"),
    verdict: text("verdict"),
  },
  (t) => [index("runs_night_idx").on(t.nightId), index("runs_task_idx").on(t.taskId)],
);

export const artifacts = sqliteTable(
  "artifacts",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    content: text("content").notNull(),
  },
  (t) => [uniqueIndex("artifacts_run_kind_idx").on(t.runId, t.kind)],
);

/** The user's morning decisions. Latest row per run wins. */
export const triage = sqliteTable(
  "triage",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    note: text("note"),
    at: text("at").notNull(),
  },
  (t) => [index("triage_run_idx").on(t.runId)],
);

export const repos = sqliteTable("repos", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  path: text("path").notNull().unique(),
  defaultBranch: text("default_branch").notNull().default("main"),
  protectedBranches: text("protected_branches", { mode: "json" }).$type<string[]>().notNull().default([]),
  testCommand: text("test_command"),
  level: text("level").notNull().default("draft_pr"),
  createdAt: text("created_at").notNull(),
});

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    repoId: text("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    brief: text("brief").notNull().default(""),
    type: text("type").notNull().default("implementation"),
    scope: text("scope", { mode: "json" }).$type<string[]>().notNull().default([]),
    criteria: text("criteria", { mode: "json" }).$type<string[]>().notNull().default([]),
    status: text("status").notNull().default("draft"),
    position: integer("position").notNull().default(0),
    dependsOn: text("depends_on", { mode: "json" }).$type<string[]>().notNull().default([]),
    budgetCents: integer("budget_cents").notNull().default(200),
    maxMinutes: integer("max_minutes").notNull().default(45),
    branch: text("branch").notNull(),
    model: text("model"),
    testCommand: text("test_command"),
    question: text("question"),
    source: text("source").notNull().default("manual"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    lastRunId: text("last_run_id"),
  },
  (t) => [index("tasks_status_idx").on(t.status, t.position)],
);

export const taskNotes = sqliteTable(
  "task_notes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    author: text("author").notNull(),
    body: text("body").notNull(),
    runId: text("run_id"),
    at: text("at").notNull(),
  },
  (t) => [index("task_notes_task_idx").on(t.taskId)],
);

/** What the crew did, step by step, for the live run view. */
export const runEvents = sqliteTable(
  "run_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id").notNull(),
    at: text("at").notNull(),
    phase: text("phase").notNull(),
    kind: text("kind").notNull(),
    text: text("text").notNull(),
    data: text("data", { mode: "json" }),
  },
  (t) => [index("run_events_run_idx").on(t.runId, t.id)],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
});
