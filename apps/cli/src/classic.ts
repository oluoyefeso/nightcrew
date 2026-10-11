// Imports run history from NightCrew classic (the bash runner): every archived
// session under state/sessions/<timestamp>/progress.json, plus the PLAN /
// DECISIONS / REVIEW files and phase logs each task left behind.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { humanizeTaskId, nightIdFor } from "@nightcrew/core";
import type { ArtifactRow, RunRow } from "@nightcrew/db";
import { parse as parseYaml } from "yaml";

const SESSION_DIR = /^\d{4}-\d{2}-\d{2}T\d{6}Z$/;
const MAX_ARTIFACT_BYTES = 256 * 1024;

interface ClassicTask {
  status?: string;
  started_at?: string;
  completed_at?: string;
  failed_at?: string;
  model?: string;
  cost_cents?: string | number;
  input_tokens?: string | number;
  output_tokens?: string | number;
  plan_in_tokens?: string | number;
  plan_out_tokens?: string | number;
  impl_in_tokens?: string | number;
  impl_out_tokens?: string | number;
  review_in_tokens?: string | number;
  review_out_tokens?: string | number;
  pr_url?: string;
  plan_file?: string;
  log_file?: string;
  reason?: string;
  diagnosis?: string;
}

interface TaskDef {
  id: string;
  title?: string;
  branch?: string;
  type?: string;
  project_path?: string;
}

export interface ImportedRun {
  run: RunRow;
  artifacts: Omit<ArtifactRow, "runId">[];
}

/** Find a classic install: a directory holding state/sessions. */
export function findClassicRoot(start: string): string | null {
  for (const dir of [start, join(start, "classic"), resolve(start, "..")]) {
    if (existsSync(join(dir, "state", "sessions"))) return dir;
  }
  return null;
}

export function importClassic(root: string): ImportedRun[] {
  const sessionsDir = join(root, "state", "sessions");
  const defs = loadTaskDefs(root);
  const defaultRepo = root;
  const seen = new Map<string, ImportedRun>();

  const sessions = readdirSync(sessionsDir)
    .filter((d) => SESSION_DIR.test(d))
    .sort();

  for (const sessionId of sessions) {
    const dir = join(sessionsDir, sessionId);
    const progress = readJson<{ tasks?: Record<string, ClassicTask> }>(join(dir, "progress.json"));
    if (!progress?.tasks) continue;

    for (const [taskId, t] of Object.entries(progress.tasks)) {
      if (!t.started_at) continue;
      // Sessions copy earlier entries forward, so one attempt can appear in
      // several progress files. An attempt is identified by its start time.
      const id = `${taskId}@${t.started_at}`;
      const def = defs.get(taskId);
      const repoPath = def?.project_path ?? inferRepoPath(t) ?? defaultRepo;
      const endedAt = t.completed_at ?? t.failed_at ?? null;
      // log_file points at the session that actually ran this attempt.
      const logDir = t.log_file ? dirname(dirname(t.log_file)) : dir;
      const logs = readLogs(existsSync(logDir) ? logDir : dir, taskId);
      const prNumber = t.pr_url ? Number(t.pr_url.split("/").pop()) || null : null;

      const run: RunRow = {
        id,
        nightId: nightIdFor(t.started_at),
        sessionId,
        taskId,
        title: def?.title ?? humanizeTaskId(taskId),
        repo: repoName(repoPath),
        repoPath,
        type: def?.type ?? null,
        status: mapStatus(t.status),
        source: "classic",
        startedAt: t.started_at,
        endedAt,
        model: t.model ?? null,
        costCents: num(t.cost_cents),
        tokensIn: num(t.input_tokens) || num(t.plan_in_tokens) + num(t.impl_in_tokens) + num(t.review_in_tokens),
        tokensOut: num(t.output_tokens) || num(t.plan_out_tokens) + num(t.impl_out_tokens) + num(t.review_out_tokens),
        prUrl: t.pr_url ?? null,
        prNumber,
        prState: t.pr_url ? "draft" : null,
        branch: def?.branch ?? null,
        // Classic leaves the last failure reason behind after a successful retry.
        reason: t.status === "complete" ? null : humanizeReason(t.reason ?? t.diagnosis),
        summary: firstLine(logs.impl) ?? firstLine(logs.review),
      };

      const prev = seen.get(id);
      seen.set(id, {
        run: prev ? { ...run, sessionId: prev.run.sessionId } : run,
        artifacts: collectArtifacts(taskId, repoPath, t, logs),
      });
    }
  }
  return [...seen.values()];
}

function loadTaskDefs(root: string): Map<string, TaskDef> {
  const out = new Map<string, TaskDef>();
  for (const file of [join(root, "tasks.yaml"), join(dirname(root), "tasks.yaml")]) {
    if (!existsSync(file)) continue;
    try {
      const doc = parseYaml(readFileSync(file, "utf8")) as { tasks?: TaskDef[] };
      for (const t of doc.tasks ?? []) if (t?.id && !out.has(t.id)) out.set(t.id, t);
    } catch {
      // A broken tasks.yaml only costs us titles; ids still import.
    }
  }
  return out;
}

function mapStatus(s: string | undefined): RunRow["status"] {
  switch (s) {
    case "complete":
    case "failed":
    case "timeout":
    case "blocked":
    case "paused":
    case "running":
      return s;
    case "in_progress":
      return "running";
    default:
      return "pending";
  }
}

/** Classic stored raw CLI JSON as the failure reason. Turn it into a sentence. */
export function humanizeReason(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (s.startsWith("{")) {
    if (/"api_error_status"\s*:\s*429/.test(s)) return "Rate limited by the API (429).";
    const status = s.match(/"api_error_status"\s*:\s*(\d+)/)?.[1];
    if (status) return `API error ${status}.`;
    if (/"is_error"\s*:\s*true/.test(s)) return "The agent exited with an error.";
  }
  if (s === "validation failed") return "Validation failed after the run.";
  return s.length > 240 ? `${s.slice(0, 237)}…` : s;
}

function collectArtifacts(
  taskId: string,
  repoPath: string,
  t: ClassicTask,
  logs: { plan?: string; impl?: string; review?: string },
): Omit<ArtifactRow, "runId">[] {
  const out: Omit<ArtifactRow, "runId">[] = [];
  const candidates: [ArtifactRow["kind"], string[]][] = [
    ["plan", [t.plan_file ?? "", join(repoPath, `PLAN-${taskId}.md`)]],
    ["decisions", [join(repoPath, `DECISIONS-${taskId}.md`)]],
    ["review", [join(repoPath, `REVIEW-${taskId}.md`)]],
  ];
  for (const [kind, paths] of candidates) {
    const path = paths.find((p) => p && isFile(p));
    if (path) out.push({ kind, name: basename(path), content: readCapped(path) });
  }
  const logText = (
    [
      ["Plan", logs.plan],
      ["Implement", logs.impl],
      ["Review", logs.review],
    ] as const
  )
    .filter(([, body]) => body?.trim())
    .map(([phase, body]) => `## ${phase}\n\n${body?.trim()}`)
    .join("\n\n");
  if (logText) out.push({ kind: "log", name: `${taskId} phase logs`, content: logText });
  return out;
}

function readLogs(sessionDir: string, taskId: string) {
  const read = (phase: string) => {
    const p = join(sessionDir, "logs", `${taskId}-${phase}.log`);
    return isFile(p) ? readCapped(p) : undefined;
  };
  return { plan: read("plan"), impl: read("impl"), review: read("review") };
}

function firstLine(text: string | undefined): string | null {
  if (!text) return null;
  for (const raw of text.split("\n")) {
    const line = raw
      .replace(/^[#>*\s-]+/, "")
      .replace(/\*\*/g, "")
      .trim();
    if (line && !line.startsWith("{") && !/^-{3,}$/.test(line) && !line.startsWith("```")) {
      return line.length > 200 ? `${line.slice(0, 197)}…` : line;
    }
  }
  return null;
}

function inferRepoPath(t: ClassicTask): string | null {
  // log_file lives at <nightcrew>/state/sessions/...; plan_file at <repo>/.worktrees/<id>/...
  const m = t.plan_file?.match(/^(.*)\/\.worktrees\//);
  return m?.[1] ?? null;
}

function repoName(path: string): string {
  try {
    const head = readFileSync(join(path, ".git", "config"), "utf8");
    const url = head.match(/url\s*=\s*(\S+)/)?.[1];
    const name = url
      ?.replace(/\.git$/, "")
      .split(/[/:]/)
      .pop();
    if (name) return name;
  } catch {}
  return basename(path);
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function readCapped(path: string): string {
  const text = readFileSync(path, "utf8");
  return text.length > MAX_ARTIFACT_BYTES ? `${text.slice(0, MAX_ARTIFACT_BYTES)}\n\n… truncated` : text;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function num(v: string | number | undefined): number {
  const n = typeof v === "number" ? v : Number.parseInt(v ?? "0", 10);
  return Number.isFinite(n) ? n : 0;
}
