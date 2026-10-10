import type { Night, NightReport, RunDetail, TriageAction } from "@nightcrew/core";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";

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
