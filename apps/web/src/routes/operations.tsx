import { type AuditEntry, type Delivery, formatTokens } from "@nightcrew/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api, reposQuery } from "../api";
import { Button } from "../components/ui";

interface Operations {
  audit: AuditEntry[];
  deliveries: Delivery[];
  reliability: {
    sample: number;
    ready: number;
    failed: number;
    retries: number;
    tokens: number;
    recent: { id: string; repo: string; status: string; verdict: string | null; startedAt: string | null }[];
  };
  setup: { repoId: string; name: string; checks: { label: string; ok: boolean }[] }[];
}
export function OperationsPage() {
  const info = useQuery({
    queryKey: ["operations"],
    queryFn: () => api.get<Operations>("/api/operations"),
    refetchInterval: 5000,
  });
  const repos = useQuery(reposQuery);
  const [older, setOlder] = useState<AuditEntry[]>([]);
  const history = useMutation({
    mutationFn: (before: number) => api.get<AuditEntry[]>(`/api/audit?before=${before}`),
    onSuccess: (rows) => setOlder((prev) => [...prev, ...rows]),
  });
  const action = useMutation({
    mutationFn: ({ repoId, stage, previousId }: { repoId: string; stage: string; previousId?: string }) =>
      api.post(`/api/repos/${repoId}/deliver`, { stage, previousId }),
    onSettled: () => {
      void info.refetch();
    },
  });
  const stop = useMutation({
    mutationFn: () => api.post("/api/operations/stop"),
    onSettled: () => {
      void info.refetch();
    },
  });
  const allowRetry = useMutation({
    mutationFn: (id: string) => api.post(`/api/deliveries/${id}/allow-retry`, { inspected: true }),
    onSuccess: () => {
      void info.refetch();
    },
  });
  const data = info.data;
  const audit = [...(data?.audit ?? []), ...older].filter(
    (row, i, all) => all.findIndex((other) => other.id === row.id) === i,
  );
  const recent =
    data?.reliability.recent.filter((r) => ["complete", "failed", "timeout", "blocked"].includes(r.status)) ?? [];
  const rate = (rows: typeof recent) =>
    rows.length
      ? `${Math.round((rows.filter((r) => r.status === "complete" && r.verdict === "ready").length / rows.length) * 100)}%`
      : "—";
  return (
    <div className="mx-auto grid max-w-[1080px] gap-7 px-4 pt-8 pb-24 sm:px-8">
      <header className="grid gap-2">
        <h1 className="t-h1">Operations</h1>
        <p className="text-[14px] text-muted">Follow delivery, reliability and the decisions that changed your crew.</p>
      </header>
      {info.error && (
        <p role="alert" className="text-bad">
          {info.error.message}
        </p>
      )}
      <section className="grid gap-3 rounded-2xl bg-surface p-5 ring-1 ring-line">
        <h2 className="font-medium">Reliability · last {data?.reliability.sample ?? 0} finished local attempts</h2>
        <p className="text-[13px] text-muted">
          {data?.reliability.ready ?? 0} ready · {data?.reliability.failed ?? 0} failed or timed out ·{" "}
          {data?.reliability.retries ?? 0} repeat attempts · {formatTokens(data?.reliability.tokens ?? 0)} tokens
        </p>
        <p className="text-[13px]">
          Ready rate: {rate(recent.slice(0, 20))} in the latest 20 attempts · {rate(recent.slice(20, 40))} in the
          preceding 20.
        </p>
        <p className="text-[12px] text-muted">
          These are recorded reviewer outcomes, not a guarantee of correctness. Small samples can vary widely.
        </p>
      </section>
      <section className="grid gap-4">
        <div className="flex flex-wrap justify-between gap-2">
          <h2 className="text-[18px] font-medium">Delivery</h2>
          <Button variant="ghost" disabled={stop.isPending} onClick={() => stop.mutate()}>
            Stop running verification and delivery
          </Button>
        </div>
        <p className="text-[13px] text-muted">
          Each stage applies to a pinned commit on a local branch. Update that branch before starting checks when you
          need newer remote changes. Automatic delivery follows the authority you saved in Settings.
        </p>
        {repos.data?.map((repo) => {
          const records = data?.deliveries.filter((d) => d.repoId === repo.id) ?? [];
          const latest = records[0];
          const configured = Boolean(repo.delivery?.branch && repo.delivery.check);
          const next =
            latest?.status === "passed"
              ? latest.stage === "check"
                ? "deploy"
                : latest.stage === "deploy"
                  ? "release"
                  : null
              : null;
          return (
            <article key={repo.id} className="grid gap-3 rounded-2xl bg-surface p-5 ring-1 ring-line">
              <div className="flex flex-wrap justify-between gap-2">
                <h3 className="font-medium">{repo.name}</h3>
                <Link to="/settings" className="text-[13px] text-dawn">
                  Configure delivery →
                </Link>
              </div>
              <p className="text-[13px] text-muted">
                {configured
                  ? `${repo.delivery?.branch} · ${repo.delivery?.automatic === "off" ? "You start each stage" : `Automatic through ${repo.delivery?.automatic}`}`
                  : "Set a branch and verification command to begin."}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={!configured || action.isPending || latest?.status === "running"}
                  onClick={() => action.mutate({ repoId: repo.id, stage: "check" })}
                >
                  Check current commit
                </Button>
                {next && (
                  <Button
                    disabled={action.isPending || !repo.delivery?.[next]}
                    onClick={() => action.mutate({ repoId: repo.id, stage: next, previousId: latest?.id })}
                  >
                    {next === "deploy" ? "Deploy verified commit" : "Release deployed commit"}
                  </Button>
                )}
              </div>
              {records.slice(0, 6).map((d) => (
                <details key={d.id} className="text-[13px]">
                  <summary className="cursor-pointer break-words">
                    {d.stage} · {d.status} · {d.sha.slice(0, 8)} · {new Date(d.createdAt).toLocaleString()}
                  </summary>
                  {(d.status === "failed" || d.status === "interrupted") && (
                    <p className="mt-2 text-dawn">
                      Inspect the external outcome first. To continue, rerun checks, then explicitly start the next
                      stage. Interrupted actions are held to avoid duplication.
                    </p>
                  )}
                  {d.status === "interrupted" && (
                    <Button disabled={allowRetry.isPending} onClick={() => allowRetry.mutate(d.id)}>
                      I inspected the external outcome; allow manual retry
                    </Button>
                  )}
                  <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-bg p-3 text-[12px]">
                    {d.log || "Command running…"}
                  </pre>
                </details>
              ))}
            </article>
          );
        })}
        {(stop.error || allowRetry.error) && (
          <p role="alert" className="text-bad">
            {(stop.error ?? allowRetry.error)?.message}
          </p>
        )}
        {action.error && (
          <p role="alert" className="text-bad">
            {action.error.message}
          </p>
        )}
      </section>
      <section className="grid gap-3">
        <h2 className="text-[18px] font-medium">Repository setup</h2>
        <p className="text-[13px] text-muted">
          Start with Draft PR, configure tests and any UI preview, then choose task routes. Increase authority after
          inspecting real outcomes. Optional checks below depend on the work you dispatch.
        </p>
        {data?.setup.map((repo) => (
          <div key={repo.repoId} className="rounded-2xl bg-surface p-5 ring-1 ring-line">
            <h3 className="font-medium">{repo.name}</h3>
            <ul className="mt-2 grid gap-1 text-[13px] text-muted">
              {repo.checks.map((check) => (
                <li key={check.label}>
                  {check.ok ? "✓ Configured" : "○ Not configured"} · {check.label}
                </li>
              ))}
            </ul>
            <Link to="/settings" className="mt-3 inline-block text-[13px] text-dawn">
              Review repository settings →
            </Link>
          </div>
        ))}
      </section>
      <section className="grid gap-3">
        <h2 className="text-[18px] font-medium">Activity and policy history</h2>
        <p className="text-[12px] text-muted">
          Local history records actions and changed field names. Credential values and command output are excluded from
          this log.
        </p>
        <ol className="grid gap-2">
          {audit.map((row) => (
            <li key={row.id} className="rounded-xl bg-surface p-3 text-[12px] break-words">
              <span className="text-muted">
                {new Date(row.at).toLocaleString()} · {row.actor === "crew" ? "Crew" : "You"}
              </span>
              <p className="font-medium">{row.action.replaceAll(".", " · ")}</p>
              <p className="font-mono text-muted">
                {row.subjectId}
                {row.detail ? ` · ${row.detail}` : ""}
              </p>
            </li>
          ))}
        </ol>
        {!audit.length && <p className="text-muted">Actions will appear here as you use the crew.</p>}
        {audit.length >= 100 && (
          <div>
            <Button disabled={history.isPending} onClick={() => history.mutate(audit.at(-1)!.id)}>
              Load older activity
            </Button>
          </div>
        )}
        {history.error && (
          <p role="alert" className="text-bad">
            {history.error.message}
          </p>
        )}
      </section>
    </div>
  );
}
