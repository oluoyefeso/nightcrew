import type {
  MissionDetail,
  MissionSummary,
  Night,
  NightReport,
  QueueEntry,
  Repo,
  RunDetail,
  Settings,
  StationReport,
  Task,
  TaskNote,
  TaskStatus,
  TriageAction,
} from "@nightcrew/core";
import { formatTokens } from "@nightcrew/core";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { stashBeforeReload } from "./pending";
import { readSse } from "./sse";

/** Writes on the wire. Locking out waits for them so a save isn't cut off mid-flight. */
let writes = 0;

// ── The launch key ──────────────────────────────────────────────────────────
// `nightcrew` prints http://localhost:<port>/?t=<key>. The app takes the key
// from the address bar once, keeps it in localStorage (scoped to this exact
// origin, port included, unlike cookies) and sends it as a header on every
// API call. Another localhost port never sees it.

const KEY_HEADER = "x-nightcrew-token";
const keyName = () => `nc-launch-key-${location.port || (location.protocol === "https:" ? "443" : "80")}`;
/** Fallback when storage is blocked (some private windows): this tab only. */
let memoryKey: string | null = null;

export function launchKey(): string | null {
  try {
    return localStorage.getItem(keyName()) ?? memoryKey;
  } catch {
    return memoryKey;
  }
}

/** Move ?t= from the address bar into storage. Call before the router reads the URL. */
export function takeLaunchKey() {
  const url = new URL(location.href);
  const key = url.searchParams.get("t");
  if (key === null) return;
  url.searchParams.delete("t");
  try {
    history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {}
  if (!key) return;
  memoryKey = key;
  try {
    localStorage.setItem(keyName(), key);
  } catch {}
}

const authHeaders = (): Record<string, string> => {
  const key = launchKey();
  return key ? { [KEY_HEADER]: key } : {};
};

/** Fetch with the launch key. For things like images that need a plain fetch. */
export function authFetch(path: string, init?: RequestInit) {
  return fetch(path, { ...init, headers: { ...authHeaders(), ...init?.headers } });
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const write = (init?.method ?? "GET") !== "GET";
  if (write) writes++;
  let res: Response;
  let body: unknown;
  try {
    res = await authFetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
    body = await res.json().catch(() => null);
  } finally {
    if (write) writes--;
  }
  if (res.status === 401) lockedOut();
  if (!res.ok)
    throw new ApiError((body as { error?: string } | null)?.error ?? `Request failed (${res.status}).`, res.status);
  return body as T;
}

// ── Locked ──────────────────────────────────────────────────────────────────
// "checking": asking the API whether the key we have works, before showing
// anything. "locked": no key, or a stale one; the app shows how to get in.

export type Lock = "checking" | "open" | "locked";
let lock: Lock = "checking";
let locking = false;
const lockListeners = new Set<() => void>();
function setLock(next: Lock) {
  lock = next;
  for (const l of lockListeners) l();
}
export const lockStore = {
  subscribe: (l: () => void) => {
    lockListeners.add(l);
    return () => lockListeners.delete(l);
  },
  get: () => lock,
};

/** On load: open the app only if the API takes our key (or needs none, in development). */
export async function checkKey() {
  const status = await authFetch("/api/health")
    .then((r) => r.status)
    .catch(() => 0);
  setLock(status === 401 ? "locked" : "open");
}

/**
 * Each launch of `nightcrew` mints a new key, so a tab left open across a
 * restart gets 401s. Show the locked page, which says how to get back in.
 * Unsaved edits are stashed first (see pending.ts) so the new link's tab
 * puts them back, and a save still on the wire gets a few seconds to finish.
 */
export function lockedOut() {
  if (lock === "locked" || locking) return;
  locking = true;
  const lockNow = () => {
    stashBeforeReload();
    locking = false;
    setLock("locked");
  };
  if (writes === 0) return lockNow();
  toast("NightCrew restarted. Finishing your save…");
  const since = Date.now();
  const wait = setInterval(() => {
    if (writes > 0 && Date.now() - since < 5000) return;
    clearInterval(wait);
    lockNow();
  }, 100);
}

/** React Query's usual three retries, but never on a 401: a new key won't appear by retrying. */
export function shouldRetry(count: number, err: unknown) {
  return !(err instanceof ApiError && err.status === 401) && count < 3;
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

export const stationQuery = queryOptions({
  queryKey: ["station"],
  queryFn: () => request<StationReport>("/api/station"),
  refetchInterval: 15_000,
});

export const reportQuery = (nightId?: string) =>
  queryOptions({
    queryKey: ["report", nightId ?? "latest"],
    queryFn: () => request<NightReport>(`/api/report${nightId ? `?night=${encodeURIComponent(nightId)}` : ""}`),
    retry: (count, err) => shouldRetry(count, err) && !(err instanceof ApiError && err.status === 404) && count < 2,
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
      qc.invalidateQueries({ queryKey: ["station"] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
      // Send back can take a task off its train.
      qc.invalidateQueries({ queryKey: ["trains"] });
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
  tokensToday: number;
  dailyTokenBudget: number;
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
  tokens: number;
  prUrl: string | null;
  reason: string | null;
}

export interface DraftTask {
  missionId?: string | null;
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
export const infoQuery = queryOptions({
  queryKey: ["info"],
  queryFn: () => api.get<{ version: string; dataDir: string; workDir: string }>("/api/info"),
  staleTime: Number.POSITIVE_INFINITY,
});
export const crewQuery = queryOptions({ queryKey: ["crew"], queryFn: () => api.get<CrewStatus>("/api/crew") });
export const missionsQuery = queryOptions({
  queryKey: ["missions", "list"],
  queryFn: () => api.get<MissionSummary[]>("/api/missions"),
  refetchInterval: 5000,
});
export const missionQuery = (id: string) =>
  queryOptions({
    queryKey: ["missions", id],
    queryFn: () => api.get<MissionDetail>(`/api/missions/${encodeURIComponent(id)}`),
    refetchInterval: 5000,
  });
export const queueQuery = queryOptions({
  queryKey: ["queue"],
  queryFn: () => api.get<QueueEntry[]>("/api/crew/queue"),
  refetchInterval: 5000,
});
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
    qc.invalidateQueries({ queryKey: ["missions"] });
    qc.invalidateQueries({ queryKey: ["acceptance"] });
    qc.invalidateQueries({ queryKey: ["operations"] });
    qc.invalidateQueries({ queryKey: ["task"] });
    qc.invalidateQueries({ queryKey: ["queue"] });
    qc.invalidateQueries({ queryKey: ["preflight"] });
    qc.invalidateQueries({ queryKey: ["station"] });
  };
}

/** One live stream for the whole app: crew status and run events. */
export function useCrewStream() {
  const qc = useQueryClient();
  useEffect(() => {
    let lastActive = "";
    const handlers: Record<string, (data: string) => void> = {
      status: (data) => {
        const s = JSON.parse(data) as CrewStatus;
        qc.setQueryData(crewQuery.queryKey, s);
        const active = s.active.map((a) => a.taskId).join(",");
        if (active !== lastActive) {
          qc.invalidateQueries({ queryKey: ["station"] });
          qc.invalidateQueries({ queryKey: ["tasks"] });
          qc.invalidateQueries({ queryKey: ["report"] });
          qc.invalidateQueries({ queryKey: ["nights"] });
        }
        lastActive = active;
      },
      report: (data) => {
        const r = JSON.parse(data) as AgentReport;
        qc.invalidateQueries({ queryKey: ["station"] });
        qc.invalidateQueries({ queryKey: ["report"] });
        qc.invalidateQueries({ queryKey: ["tasks"] });
        qc.invalidateQueries({ queryKey: ["trains"] });
        announce(r);
      },
      run_event: (data) => {
        const e = JSON.parse(data) as RunEvent;
        qc.setQueryData<RunEvent[]>(eventsQuery(e.runId).queryKey, (prev) =>
          prev && !prev.some((p) => p.id === e.id) ? [...prev, e] : (prev ?? [e]),
        );
        if (e.kind === "phase" || e.kind === "result" || e.kind === "error") {
          qc.invalidateQueries({ queryKey: ["run", e.runId] });
          qc.invalidateQueries({ queryKey: ["report"] });
        }
      },
    };
    const ctrl = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 1000;
    const connect = async () => {
      const status = await readSse(
        "/api/stream",
        { headers: authHeaders(), signal: ctrl.signal },
        ({ event, data }) => {
          try {
            handlers[event]?.(data);
          } catch {}
        },
        () => {
          delay = 1000;
        },
      ).catch(() => 0);
      if (ctrl.signal.aborted) return;
      // Locked out: a new key won't appear by reconnecting.
      if (status === 401) return lockedOut();
      retry = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 30_000);
    };
    void connect();
    return () => {
      ctrl.abort();
      clearTimeout(retry);
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
        body: r.status === "complete" ? `${formatTokens(r.tokens)} tokens` : (r.reason ?? ""),
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
