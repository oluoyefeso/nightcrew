// Turns a paragraph ("dark mode for the widgets, and fix the 429 retry bug")
// into task cards with repo, type, scope and acceptance criteria.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { type Mission, type Repo, TASK_TYPES, type TaskType } from "@nightcrew/core";
import { type AgentEngine, type EngineEvent, type PhaseResult, runEnginePhase } from "./engine";

export interface DraftTask {
  repoId: string;
  title: string;
  type: TaskType;
  brief: string;
  scope: string[];
  criteria: string[];
  missionCriteria?: string[];
  /** One question the crew needs answered before it can work unattended. */
  question: string | null;
  /** Indexes of other drafts in this batch that must run first. */
  dependsOn: number[];
}

const SCHEMA = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          repo: { type: "string", description: "Exact repo name from the list." },
          title: { type: "string", description: "Imperative, under 70 characters, like a good PR title." },
          type: { type: "string", enum: TASK_TYPES },
          brief: { type: "string", description: "What to do and why, with the details the user gave. 1-6 sentences." },
          scope: {
            type: "array",
            items: { type: "string" },
            description:
              "Glob patterns of files the task may change, based on the file tree. Include test files. Empty if unsure.",
          },
          criteria: { type: "array", items: { type: "string" }, description: "2-5 checkable acceptance criteria." },
          missionCriteria: {
            type: "array",
            items: { type: "string" },
            description:
              "Exact mission acceptance criteria this task supports. Empty when unrelated or no mission is provided.",
          },
          question: {
            type: ["string", "null"],
            description: "Only if the task can't be done well without an answer. Otherwise null.",
          },
          dependsOn: {
            type: "array",
            items: { type: "integer" },
            description: "Indexes of earlier tasks in this list that must finish first.",
          },
        },
        required: ["repo", "title", "type", "brief", "scope", "criteria", "missionCriteria", "question", "dependsOn"],
      },
    },
  },
  required: ["tasks"],
};

export async function draftTasks(
  engine: AgentEngine,
  input: {
    text: string;
    repos: Repo[];
    defaultRepoId?: string;
    model: string;
    mission?: (Pick<Mission, "title" | "objective"> & Partial<Pick<Mission, "criteria">>) | null;
    maxTokens?: number;
    strict?: boolean;
    signal?: AbortSignal;
    onEvent?: (event: EngineEvent) => void;
    onResult?: (result: PhaseResult) => void;
  },
): Promise<{ drafts: DraftTask[]; costUsd: number; fallback: boolean }> {
  const { repos } = input;
  if (repos.length === 0) throw new Error("Add a repo first so the crew knows where to work.");
  const fallback = (): DraftTask[] => [
    {
      repoId: input.defaultRepoId ?? (repos[0] as Repo).id,
      title: input.text.split(/[.\n]/)[0]?.trim().slice(0, 70) || "New task",
      type: /\b(bug|fix|broken|error|crash)\b/i.test(input.text) ? "bugfix" : "implementation",
      brief: input.text.trim(),
      scope: [],
      criteria: [],
      question: null,
      dependsOn: [],
    },
  ];

  const context = repos.map((r) => `### ${r.name}\n${fileTree(r.path)}`).join("\n\n");

  const result = await runEnginePhase(
    engine,
    {
      phase: "compose",
      cwd: (repos.find((r) => r.id === input.defaultRepoId) ?? (repos[0] as Repo)).path,
      model: input.model,
      systemPrompt:
        "You turn a developer's request into well-scoped tasks for a coding crew that works unattended. Split unrelated work into separate tasks; keep one coherent change and its tests as ONE task. Each task must pass its checks before any dependent task can start. Never put deliberately failing regression tests in a separate predecessor task: the bug fix task must implement both the fix and its regression test. The conductor performs final integration verification itself; do not create a separate task just to verify the goal. Never invent requirements.",
      prompt: `Repos and their files:\n\n${context}\n\n---\n\n${input.mission ? `Shared mission context (scope comes from the request):\n${input.mission.title}\n${input.mission.objective}\nMission acceptance criteria:\n${(input.mission.criteria ?? []).map((c) => `- ${c}`).join("\n")}\nPropose the work needed, with prerequisites where necessary. A fix and its regression tests must be in the same task so each task can pass before its dependents start. The conductor runs final integration verification itself. Link each task to the exact mission criteria it supports; leave unrelated work unlinked.\n\n` : ""}The request:\n\n${input.text}`,
      guard: { worktree: "/nonexistent", writableDirs: [], scope: [], protectedBranches: [], readOnly: true },
      maxTokens: input.maxTokens ?? 200_000,
      maxTurns: 3,
      outputSchema: {
        ...SCHEMA,
        properties: {
          tasks: {
            ...SCHEMA.properties.tasks,
            items: {
              ...SCHEMA.properties.tasks.items,
              properties: {
                ...SCHEMA.properties.tasks.items.properties,
                repo: {
                  type: "string",
                  enum: repos.map((repo) => repo.name),
                  description: "Exact connected project name, with no annotations.",
                },
              },
            },
          },
        },
      },
      signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000),
    },
    input.onEvent ?? (() => {}),
  );
  input.onResult?.(result);

  const out = result.structured as { tasks?: Array<Omit<DraftTask, "repoId"> & { repo: string }> } | null;
  if (
    !result.ok ||
    !Array.isArray(out?.tasks) ||
    !out.tasks.length ||
    out.tasks.length > 12 ||
    out.tasks.some(
      (t) =>
        !t ||
        typeof t.title !== "string" ||
        !t.title.trim() ||
        !Array.isArray(t.scope) ||
        !Array.isArray(t.criteria) ||
        !Array.isArray(t.dependsOn),
    )
  )
    return { drafts: fallback(), costUsd: result.costUsd, fallback: true };

  const byName = new Map(repos.map((r) => [r.name.toLowerCase(), r.id]));
  if (
    input.strict &&
    out.tasks.some(
      (task, index) =>
        !byName.has(String(task.repo).toLowerCase()) ||
        !(TASK_TYPES as string[]).includes(task.type) ||
        typeof task.brief !== "string" ||
        task.brief.length > 10000 ||
        task.scope.some((scope) => typeof scope !== "string" || scope.length > 1000) ||
        task.criteria.some(
          (criterion) => typeof criterion !== "string" || !criterion.trim() || criterion.length > 1000,
        ) ||
        (task.question !== null && typeof task.question !== "string") ||
        task.dependsOn.some((dependency) => !Number.isInteger(dependency) || dependency < 0 || dependency >= index),
    )
  )
    return { drafts: fallback(), costUsd: result.costUsd, fallback: true };
  const drafts = out.tasks.map((t, i) => ({
    repoId: byName.get(String(t.repo).toLowerCase()) ?? input.defaultRepoId ?? (repos[0] as Repo).id,
    title: String(t.title).slice(0, 120),
    type: (TASK_TYPES as string[]).includes(t.type) ? t.type : "implementation",
    brief: String(t.brief ?? ""),
    scope: (t.scope ?? []).map(String).slice(0, 20),
    criteria: (t.criteria ?? []).map(String).slice(0, 8),
    ...(input.mission
      ? {
          missionCriteria: [
            ...new Set(
              (Array.isArray(t.missionCriteria) ? t.missionCriteria : []).filter(
                (c) => typeof c === "string" && input.mission?.criteria?.includes(c),
              ),
            ),
          ],
        }
      : {}),
    question: t.question ? String(t.question) : null,
    dependsOn: (t.dependsOn ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d < i),
  }));
  return { drafts, costUsd: result.costUsd, fallback: false };
}

const SKIP = new Set([
  ".git",
  "node_modules",
  ".worktrees",
  "dist",
  "build",
  ".next",
  "target",
  "vendor",
  ".venv",
  "__pycache__",
  "coverage",
]);

/** A compact tree, two levels deep, so the composer can guess scope. */
export function fileTree(root: string, depth = 2, max = 160): string {
  const lines: string[] = [];
  const walk = (dir: string, prefix: string, level: number) => {
    if (lines.length >= max) return;
    let entries: { name: string; dir: boolean }[];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => !SKIP.has(e.name) && !(e.name.startsWith(".") && e.name !== ".github"))
        .map((e) => ({ name: e.name, dir: e.isDirectory() }))
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const e of entries) {
      if (lines.length >= max) {
        lines.push(`${prefix}…`);
        return;
      }
      lines.push(`${prefix}${e.name}${e.dir ? "/" : ""}`);
      if (e.dir && level < depth) walk(join(dir, e.name), `${prefix}  `, level + 1);
    }
  };
  walk(root, "", 1);
  return lines.join("\n");
}
