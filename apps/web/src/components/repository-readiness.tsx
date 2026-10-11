import type { Repo, RepositoryReadiness } from "@nightcrew/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { OperationProgress, operationActive } from "./operation-progress";
import { Button } from "./ui";

export function RepositoryReadinessPanel({ repo }: { repo: Repo }) {
  const qc = useQueryClient();
  const state = useQuery({
    queryKey: ["repository-readiness", repo.id, repo.defaultBranch, repo.setupCommand, repo.testCommand],
    queryFn: () => api.get<RepositoryReadiness>(`/api/repos/${repo.id}/readiness`),
    refetchInterval: (q) => (operationActive(q.state.data?.operation) ? 2000 : 15000),
  });
  const run = useMutation({
    mutationFn: () => api.post(`/api/repos/${repo.id}/verify-setup`, { fingerprint: state.data?.fingerprint }),
    onSettled: () => {
      void state.refetch();
      void qc.invalidateQueries({ queryKey: ["operations"] });
    },
  });
  const r = state.data;
  const busy = operationActive(r?.operation);
  return (
    <section className="grid gap-3 rounded-xl bg-raised/40 p-4" aria-label={`${repo.name} setup verification`}>
      <h3 className="text-[14px] font-medium">
        Setup verification ·{" "}
        {busy
          ? "In progress"
          : r?.verified
            ? "Verified"
            : r?.latest && r.latest.fingerprint !== r.fingerprint
              ? "Outdated"
              : "Needs verification"}
      </h3>
      <p className="text-[12px] text-muted">
        Run the saved install and test commands on an isolated checkout of the local {repo.defaultBranch} branch, before
        spending agent tokens. This checks installation and tests; previews, agent sign-in and deployment are separate.
      </p>
      {r?.sha && (
        <p className="font-mono text-[11px] text-muted break-all">
          {r.branch} · {r.sha.slice(0, 8)}
        </p>
      )}
      {r?.blockers.map((message) => (
        <p key={message} className="text-[12px] text-dawn">
          {message}
        </p>
      ))}
      <div>
        <Button disabled={!r || busy || run.isPending || !!r.blockers.length} onClick={() => run.mutate()}>
          {run.isPending ? "Starting verification…" : "Verify repository setup"}
        </Button>
      </div>
      {r?.operation && <OperationProgress job={r.operation} />}
      {r?.latest && (
        <details className="text-[12px]">
          <summary className="cursor-pointer">
            Last setup result · {r.latest.status}
            {r.latest.fingerprint !== r.fingerprint ? " · outdated" : ""}
          </summary>
          <p className="mt-2 text-muted">
            {new Date(r.latest.at).toLocaleString()} · {r.latest.branch} · {r.latest.sha.slice(0, 8)}
          </p>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-bg p-3">
            {r.latest.detail}
          </pre>
        </details>
      )}
      {(state.error || run.error) && (
        <p role="alert" className="text-[12px] text-bad">
          {(state.error ?? run.error)?.message}
        </p>
      )}
    </section>
  );
}
