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
