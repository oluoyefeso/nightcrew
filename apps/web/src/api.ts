import type {
  Night,
  NightReport,
  Repo,
  RunDetail,
  Settings,
  Task,
  TaskNote,
  TaskStatus,
  TriageAction,
} from "@nightcrew/core";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(body?.error ?? `Request failed (${res.status}).`, res.status);
  return body as T;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export const nightsQuery = queryOptions({
  queryKey: ["nights"],
  queryFn: () => request<Night[]>("/api/nights"),
});

export const reportQuery = (nightId?: string) =>
  queryOptions({
    queryKey: ["report", nightId ?? "latest"],
    queryFn: () => request<NightReport>(`/api/report${nightId ? `?night=${encodeURIComponent(nightId)}` : ""}`),
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
  });

export const runQuery = (id: string) =>
  queryOptions({
    queryKey: ["run", id],
    queryFn: () => request<RunDetail>(`/api/runs/${encodeURIComponent(id)}`),
  });

export function useTriage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action, note }: { id: string; action: TriageAction; note?: string }) =>
      request<RunDetail>(`/api/runs/${encodeURIComponent(id)}/triage`, {
        method: "POST",
        body: JSON.stringify({ action, note }),
      }),
    onSuccess: (detail) => {
      qc.setQueryData(runQuery(detail.run.id).queryKey, detail);
      qc.invalidateQueries({ queryKey: ["report"] });
    },
  });
}

export function useSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => request<{ runs: number; prsChecked: number }>("/api/sync", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries(),
  });
}

// ── Tasks, repos, crew ──────────────────────────────────────────────────────

export interface RunEvent {
  id: number;
  runId: string;
  at: string;
  phase: string;
  kind: "phase" | "text" | "tool" | "denied" | "result" | "error" | "info";
  text: string;
}

export interface ActiveAgent {
  taskId: string;
  runId: string | null;
  title: string;
  repoId: string;
  repoName: string;
  phase: string | null;
  startedAt: string;
  lastEvent: string | null;
}

export interface CrewStatus {
  state: "working" | "idle" | "paused" | "waiting";
  active: ActiveAgent[];
  queued: number;
  scheduled: number;
  nextAt: string | null;
  spentTodayCents: number;
  dailyBudgetCents: number;
  maxAgents: number;
  message: string | null;
  engine: string;
}

export interface AgentReport {
  runId: string;
  taskId: string;
  title: string;
  status: "complete" | "failed" | "timeout";
  costCents: number;
  prUrl: string | null;
  reason: string | null;
}

export interface DraftTask {
  repoId: string;
  title: string;
  type: Task["type"];
  brief: string;
  scope: string[];
  criteria: string[];
  question: string | null;
  dependsOn: number[];
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

export const tasksQuery = (statuses: TaskStatus[]) =>
  queryOptions({
    queryKey: ["tasks", statuses.join(",")],
    queryFn: () => api.get<Task[]>(`/api/tasks?status=${statuses.join(",")}`),
  });

export const taskQuery = (id: string) =>
  queryOptions({
    queryKey: ["task", id],
    queryFn: () =>
      api.get<{
        task: Task;
        notes: TaskNote[];
        runs: { id: string; nightId: string; status: string; startedAt: string | null; reason: string | null }[];
      }>(`/api/tasks/${id}`),
  });

export const reposQuery = queryOptions({ queryKey: ["repos"], queryFn: () => api.get<Repo[]>("/api/repos") });
export const settingsQuery = queryOptions({
  queryKey: ["settings"],
  queryFn: () => api.get<Settings>("/api/settings"),
});
export const crewQuery = queryOptions({ queryKey: ["crew"], queryFn: () => api.get<CrewStatus>("/api/crew") });
export const eventsQuery = (runId: string) =>
  queryOptions({
    queryKey: ["events", runId],
    queryFn: () => api.get<RunEvent[]>(`/api/runs/${encodeURIComponent(runId)}/events`),
  });

/** Invalidate everything a task change can affect. */
export function useInvalidateTasks() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["tasks"] });
    qc.invalidateQueries({ queryKey: ["task"] });
  };
}

/** One EventSource for the whole app: crew status and live run events. */
export function useCrewStream() {
  const qc = useQueryClient();
  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let lastActive = "";
    const connect = () => {
      es = new EventSource("/api/stream");
      es.addEventListener("status", (m) => {
        const s = JSON.parse((m as MessageEvent).data) as CrewStatus;
        qc.setQueryData(crewQuery.queryKey, s);
        const active = s.active.map((a) => a.taskId).join(",");
        if (active !== lastActive) {
          qc.invalidateQueries({ queryKey: ["tasks"] });
          qc.invalidateQueries({ queryKey: ["report"] });
          qc.invalidateQueries({ queryKey: ["nights"] });
        }
        lastActive = active;
      });
      es.addEventListener("report", (m) => {
        const r = JSON.parse((m as MessageEvent).data) as AgentReport;
        qc.invalidateQueries({ queryKey: ["report"] });
        qc.invalidateQueries({ queryKey: ["tasks"] });
        qc.invalidateQueries({ queryKey: ["trains"] });
        announce(r);
      });
      es.addEventListener("run_event", (m) => {
        const e = JSON.parse((m as MessageEvent).data) as RunEvent;
        qc.setQueryData<RunEvent[]>(eventsQuery(e.runId).queryKey, (prev) =>
          prev && !prev.some((p) => p.id === e.id) ? [...prev, e] : (prev ?? [e]),
        );
        if (e.kind === "phase" || e.kind === "result" || e.kind === "error") {
          qc.invalidateQueries({ queryKey: ["run", e.runId] });
          qc.invalidateQueries({ queryKey: ["report"] });
        }
      });
      es.onerror = () => {
        es?.close();
        retry = setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      clearTimeout(retry);
      es?.close();
    };
  }, [qc]);
}

/** An agent reported back: a toast in the app, and a desktop notification if you've allowed them and aren't looking. */
function announce(r: AgentReport) {
  const text = r.status === "complete" ? `Finished: ${r.title}` : `Needs you: ${r.title}`;
  window.dispatchEvent(new CustomEvent("nc:toast", { detail: text }));
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted" && document.hidden) {
      const n = new Notification(text, {
        body: r.status === "complete" ? `$${(r.costCents / 100).toFixed(2)}` : (r.reason ?? ""),
        tag: r.runId,
      });
      n.onclick = () => {
        window.focus();
        window.location.href = `/?run=${encodeURIComponent(r.runId)}`;
      };
    }
  } catch {}
}

export function toast(text: string) {
  window.dispatchEvent(new CustomEvent("nc:toast", { detail: text }));
}
