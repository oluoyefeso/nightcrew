// Tasks, repos, agent settings and scheduling.
import type { TaskPolicies } from "./policy";

export type TaskType = "implementation" | "bugfix" | "test" | "refactor" | "ui" | "research";

export const TASK_TYPES: TaskType[] = ["implementation", "bugfix", "ui", "test", "refactor", "research"];

export const TASK_TYPE_LABEL: Record<TaskType, string> = {
  implementation: "Feature",
  bugfix: "Bug fix",
  ui: "UI",
  test: "Tests",
  refactor: "Refactor",
  research: "Research",
};

/**
 * draft: shaped in the composer, not queued yet
 * queued: waiting for an agent (now, or at runAt)
 * later: parked in the backlog
 * running: an agent is on it
 * done: the latest run finished (see its bucket in the Morning Report)
 * archived: dismissed or merged and out of the way
 */
export type TaskStatus = "draft" | "queued" | "later" | "running" | "done" | "archived";

export type AutonomyLevel = "propose" | "draft_pr" | "train" | "ship";

export const AUTONOMY_LABEL: Record<AutonomyLevel, string> = {
  propose: "Propose",
  draft_pr: "Draft PR",
  train: "Daily train",
  ship: "Ship to dev",
};

export interface Repo {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  protectedBranches: string[];
  testCommand: string | null;
  level: AutonomyLevel;
  createdAt: string;
  setupCommand: string | null;
  previewCommand: string | null;
  previewUrl: string | null;
  previewPaths: string[];
  shipBranch: string | null;
  allowShip: string[];
  alwaysAsk: string[];
  /** Per-type limits and extra verification. Missing on older integrations means inherit. */
  policies?: TaskPolicies;
  delivery?: import("./operations").DeliveryPolicy;
}

export type Workflow = "auto" | "quick" | "planned";

/** Validate routing metadata before storage or dispatch, including records from older integrations. */
export function taskRoutingError(value: { type?: unknown; workflow?: unknown; status?: unknown }): string | null {
  if (value.type !== undefined && !TASK_TYPES.includes(value.type as TaskType))
    return "Choose a supported task type before dispatch.";
  if (value.workflow !== undefined && !["auto", "quick", "planned"].includes(value.workflow as string))
    return "Choose an automatic, quick or planned workflow before dispatch.";
  if (
    value.status !== undefined &&
    !["draft", "queued", "later", "running", "done", "archived"].includes(value.status as string)
  )
    return "Choose a supported task status.";
  return null;
}

export interface TrainCar {
  runId: string;
  taskId: string;
  title: string;
  mergeSha: string;
  state: "on" | "pulled" | "broke";
}

export interface Train {
  id: string;
  repoId: string;
  repoName: string;
  nightId: string;
  branch: string;
  status: "open" | "published" | "merged" | "closed";
  prUrl: string | null;
  prNumber: number | null;
  cars: TrainCar[];
  createdAt: string;
}

export interface Routine {
  id: string;
  repoId: string;
  repoName: string;
  title: string;
  brief: string;
  type: TaskType;
  scope: string[];
  criteria: string[];
  days: number[];
  enabled: boolean;
  lastNight: string | null;
  createdAt: string;
}

export interface Task {
  id: string;
  missionId?: string | null;
  /** Mission criteria this task is intended to support; a planning link, not acceptance evidence. */
  missionCriteria?: string[];
  recoveryMode?: "auto" | "verify" | "rebuild";
  autoRetries?: number;
  repoId: string;
  repoName: string;
  title: string;
  brief: string;
  type: TaskType;
  scope: string[];
  criteria: string[];
  status: TaskStatus;
  position: number;
  dependsOn: string[];
  /** Most tokens this task may use (input, cache and output), across every phase. */
  tokenBudget: number;
  maxMinutes: number;
  branch: string;
  model: string | null;
  testCommand: string | null;
  question: string | null;
  /** Hold until this time (ISO). Null means run as soon as a slot is free. */
  runAt: string | null;
  source: "composer" | "cli" | "github" | "manual" | "routine";
  sourceRef: string | null;
  workflow: Workflow;
  createdAt: string;
  updatedAt: string;
  lastRunId: string | null;
}

export interface TaskNote {
  id: number;
  taskId: string;
  author: "you" | "crew";
  body: string;
  runId: string | null;
  at: string;
}

export interface Settings {
  /** Agents working at once, across all repos. */
  maxAgents: number;
  /** Agents working at once in a single repo. */
  maxPerRepo: number;
  /** Most tokens the agents may use per day (local time). */
  dailyTokenBudget: number;
  /** Dispatch queued tasks as soon as a slot is free. Off = the queue is paused. */
  dispatch: boolean;
  /** When "Schedule" sends a task, local "HH:MM" (an off-peak window, like 22:00). */
  scheduleAt: string;
  planModel: string;
  buildModel: string;
  reviewModel: string;
  /** Optional Slack incoming webhook for reports that need you. */
  slackWebhookUrl: string | null;
}

export const DEFAULT_SETTINGS: Settings = {
  maxAgents: 3,
  maxPerRepo: 1,
  dailyTokenBudget: 20_000_000,
  dispatch: true,
  scheduleAt: "22:00",
  planModel: "claude-opus-5-5",
  buildModel: "claude-sonnet-5-5",
  reviewModel: "claude-sonnet-5-5",
  slackWebhookUrl: null,
};

/** A small task measured ~100k tokens end to end; this leaves room for big ones. */
export const DEFAULT_TASK_TOKENS = 1_000_000;
export const DEFAULT_TASK_MINUTES = 45;

/** Evidence each task type has to produce (M2 enforces it; M1 shows it). */
export const EVIDENCE_FOR: Record<TaskType, string[]> = {
  implementation: ["Tests pass", "Diff stays in scope"],
  bugfix: ["A test that fails on the base branch and passes on the fix", "Diff stays in scope"],
  ui: ["Screenshots: desktop and mobile, light and dark", "Accessibility scan", "Diff stays in scope"],
  test: ["New tests pass", "No production code changes outside scope"],
  refactor: ["Tests pass before and after", "No behavior change"],
  research: ["A written report with sources"],
};

export function slugify(s: string, max = 48): string {
  const slug = s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, max).replace(/-+$/, "") || "task";
}

export function branchFor(title: string, type: TaskType): string {
  const prefix = type === "bugfix" ? "fix" : type === "research" ? "research" : type === "test" ? "test" : "crew";
  return `${prefix}/${slugify(title, 40)}`;
}

/**
 * Order tonight's queue: by position, but never before a dependency.
 * Tasks whose dependencies aren't queued or done are returned as blocked.
 */
export function planQueue(tasks: Pick<Task, "id" | "position" | "dependsOn" | "status">[]): {
  order: string[];
  blocked: { id: string; waitingOn: string[] }[];
} {
  const queued = tasks.filter((t) => t.status === "queued").sort((a, b) => a.position - b.position);
  const done = new Set(tasks.filter((t) => t.status === "done" || t.status === "archived").map((t) => t.id));
  const queuedIds = new Set(queued.map((t) => t.id));
  const order: string[] = [];
  const placed = new Set<string>();
  const blocked: { id: string; waitingOn: string[] }[] = [];

  // Anything waiting on a task that isn't queued or done can't run yet.
  const runnable = queued.filter((t) => {
    const missing = t.dependsOn.filter((d) => !done.has(d) && !queuedIds.has(d));
    if (missing.length) blocked.push({ id: t.id, waitingOn: missing });
    return missing.length === 0;
  });

  let progress = true;
  while (progress) {
    progress = false;
    for (const t of runnable) {
      if (placed.has(t.id)) continue;
      if (t.dependsOn.every((d) => done.has(d) || placed.has(d))) {
        order.push(t.id);
        placed.add(t.id);
        progress = true;
        break; // restart so position order is respected
      }
    }
  }
  for (const t of runnable) {
    if (!placed.has(t.id))
      blocked.push({ id: t.id, waitingOn: t.dependsOn.filter((d) => !placed.has(d) && !done.has(d)) });
  }
  return { order, blocked };
}

/** The next occurrence of a local "HH:MM", for scheduled tasks. */
export function nextStart(startAt: string, now = new Date()): Date {
  const [h, m] = startAt.split(":").map((n) => Number.parseInt(n, 10));
  const next = new Date(now);
  next.setHours(h ?? 22, m ?? 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}
