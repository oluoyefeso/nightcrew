import type { ConnectionCheck, DeliveryPolicy, TaskPolicies } from "@nightcrew/core";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    nightId: text("night_id").notNull(),
    sessionId: text("session_id").notNull(),
    missionId: text("mission_id"),
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
    /** 0–1: how safe this is to merge without changes. */
    confidence: real("confidence"),
    /** Set when the crew shipped it to the ship branch itself. */
    shipSha: text("ship_sha"),
    shipBranch: text("ship_branch"),
    undoneAt: text("undone_at"),
    trainId: text("train_id"),
  },
  (t) => [
    index("runs_night_idx").on(t.nightId),
    index("runs_task_idx").on(t.taskId),
    index("runs_mission_idx").on(t.missionId),
  ],
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
  /** Installs dependencies in a fresh worktree (bun install, npm ci…). */
  setupCommand: text("setup_command"),
  /** Starts the app for screenshots. $PORT is set; {port} in the URL is replaced. */
  previewCommand: text("preview_command"),
  previewUrl: text("preview_url"),
  previewPaths: text("preview_paths", { mode: "json" }).$type<string[]>().notNull().default(["/"]),
  /** Level "ship": the branch the crew may merge into itself (never a protected one). */
  shipBranch: text("ship_branch"),
  /** Level "ship": only changes entirely inside these globs ship without you. */
  allowShip: text("allow_ship", { mode: "json" }).$type<string[]>().notNull().default([]),
  /** Changes touching these always wait for you, whatever the level. */
  alwaysAsk: text("always_ask", { mode: "json" }).$type<string[]>().notNull().default([]),
  delivery: text("delivery", { mode: "json" })
    .$type<DeliveryPolicy>()
    .notNull()
    .default({ branch: "", check: "", deploy: "", release: "", automatic: "off", environment: [] }),
  policies: text("policies", { mode: "json" }).$type<TaskPolicies>().notNull().default({}),
});

export const missions = sqliteTable("missions", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  objective: text("objective").notNull(),
  paused: integer("paused", { mode: "boolean" }).notNull().default(false),
  criteria: text("criteria", { mode: "json" }).$type<string[]>().notNull().default([]),
  tokenBudget: integer("token_budget"),
  priority: integer("priority").notNull().default(0),
  deadline: text("deadline"),
  stopAt: text("stop_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    recoveryMode: text("recovery_mode").notNull().default("auto"),
    autoRetries: integer("auto_retries").notNull().default(0),
    missionId: text("mission_id").references(() => missions.id, { onDelete: "set null" }),
    repoId: text("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    brief: text("brief").notNull().default(""),
    type: text("type").notNull().default("implementation"),
    scope: text("scope", { mode: "json" }).$type<string[]>().notNull().default([]),
    missionCriteria: text("mission_criteria", { mode: "json" }).$type<string[]>().notNull().default([]),
    criteria: text("criteria", { mode: "json" }).$type<string[]>().notNull().default([]),
    status: text("status").notNull().default("draft"),
    position: integer("position").notNull().default(0),
    dependsOn: text("depends_on", { mode: "json" }).$type<string[]>().notNull().default([]),
    /** Legacy (dollar budgets). Unused; budgets are in tokens now. */
    budgetCents: integer("budget_cents").notNull().default(200),
    tokenBudget: integer("token_budget").notNull().default(1_000_000),
    maxMinutes: integer("max_minutes").notNull().default(45),
    branch: text("branch").notNull(),
    model: text("model"),
    testCommand: text("test_command"),
    question: text("question"),
    /** Hold until this time (ISO). Null: run as soon as an agent is free. */
    runAt: text("run_at"),
    source: text("source").notNull().default("manual"),
    /** Where it came from, like a GitHub issue URL. */
    sourceRef: text("source_ref"),
    /** auto | quick (no separate plan) | planned */
    workflow: text("workflow").notNull().default("auto"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    lastRunId: text("last_run_id"),
  },
  (t) => [index("tasks_status_idx").on(t.status, t.position), index("tasks_mission_idx").on(t.missionId)],
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

/** One integration branch per repo per night: tasks merge in, you merge the train. */
export const trains = sqliteTable("trains", {
  id: text("id").primaryKey(),
  repoId: text("repo_id")
    .notNull()
    .references(() => repos.id, { onDelete: "cascade" }),
  nightId: text("night_id").notNull(),
  branch: text("branch").notNull(),
  status: text("status").notNull().default("open"),
  prUrl: text("pr_url"),
  prNumber: integer("pr_number"),
  cars: text("cars", { mode: "json" })
    .$type<{ runId: string; taskId: string; title: string; mergeSha: string; state: "on" | "pulled" | "broke" }[]>()
    .notNull()
    .default([]),
  createdAt: text("created_at").notNull(),
});

/** Recurring work: a task created automatically on chosen days. */
export const routines = sqliteTable("routines", {
  id: text("id").primaryKey(),
  repoId: text("repo_id")
    .notNull()
    .references(() => repos.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  brief: text("brief").notNull().default(""),
  type: text("type").notNull().default("implementation"),
  scope: text("scope", { mode: "json" }).$type<string[]>().notNull().default([]),
  criteria: text("criteria", { mode: "json" }).$type<string[]>().notNull().default([]),
  /** Days of the week it runs, 0 = Sunday. */
  days: text("days", { mode: "json" }).$type<number[]>().notNull().default([]),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  lastNight: text("last_night"),
  createdAt: text("created_at").notNull(),
});

export const checkpoints = sqliteTable("checkpoints", {
  taskId: text("task_id")
    .primaryKey()
    .references(() => tasks.id, { onDelete: "cascade" }),
  runId: text("run_id").notNull(),
  stage: text("stage").notNull(),
  fingerprint: text("fingerprint").notNull(),
  sha: text("sha").notNull(),
  plan: text("plan"),
  summary: text("summary"),
  at: text("at").notNull(),
});
export const audit = sqliteTable("audit", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: text("at").notNull(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  subjectId: text("subject_id").notNull(),
  detail: text("detail").notNull(),
});
export const policyTemplates = sqliteTable("policy_templates", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  policies: text("policies", { mode: "json" }).$type<TaskPolicies>().notNull(),
  updatedAt: text("updated_at").notNull(),
});
export const missionAcceptances = sqliteTable("mission_acceptances", {
  id: text("id").primaryKey(),
  missionId: text("mission_id")
    .notNull()
    .references(() => missions.id, { onDelete: "cascade" }),
  at: text("at").notNull(),
  fingerprint: text("fingerprint").notNull(),
  status: text("status").notNull(),
  checks: text("checks", { mode: "json" }).$type<import("@nightcrew/core").MissionAcceptance["checks"]>().notNull(),
  evidence: text("evidence", { mode: "json" })
    .$type<import("@nightcrew/core").MissionAcceptance["evidence"]>()
    .notNull(),
});
export const deliveries = sqliteTable(
  "deliveries",
  {
    id: text("id").primaryKey(),
    repoId: text("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    sha: text("sha").notNull(),
    branch: text("branch").notNull(),
    policy: text("policy", { mode: "json" }).$type<DeliveryPolicy>().notNull(),
    stage: text("stage").notNull(),
    status: text("status").notNull(),
    log: text("log").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("deliveries_repo_idx").on(t.repoId, t.createdAt)],
);

export const operationJobs = sqliteTable(
  "operation_jobs",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    subjectId: text("subject_id").notNull(),
    stage: text("stage"),
    status: text("status").notNull(),
    phase: text("phase").notNull(),
    repoId: text("repo_id"),
    resultId: text("result_id"),
    detail: text("detail").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    reviewedAt: text("reviewed_at"),
  },
  (t) => [index("operation_jobs_subject_idx").on(t.kind, t.subjectId, t.createdAt)],
);

export const repositoryChecks = sqliteTable(
  "repository_checks",
  {
    id: text("id").primaryKey(),
    repoId: text("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    fingerprint: text("fingerprint").notNull(),
    branch: text("branch").notNull(),
    sha: text("sha").notNull(),
    status: text("status").notNull(),
    detail: text("detail").notNull(),
    at: text("at").notNull(),
  },
  (t) => [index("repository_checks_repo_idx").on(t.repoId, t.at)],
);

export const modelConnections = sqliteTable("model_connections", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  baseUrl: text("base_url").notNull(),
  model: text("model").notNull(),
  apiKeyEnv: text("api_key_env"),
  revision: integer("revision").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastCheck: text("last_check", { mode: "json" }).$type<ConnectionCheck>(),
});
