import type { Delivery, DeliveryReadiness, OperationJob, Repo } from "@nightcrew/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../api";
import { OperationProgress, operationActive } from "./operation-progress";
import { Button } from "./ui";

const labels = { check: "Check current commit", deploy: "Deploy verified commit", release: "Release deployed commit" };
export function DeliveryReadinessPanel({ repo, records }: { repo: Repo; records: Delivery[] }) {
  const qc = useQueryClient();
  const [showHistory, setShowHistory] = useState(false);
  const readiness = useQuery({
    queryKey: ["delivery-readiness", repo.id],
    queryFn: () => api.get<DeliveryReadiness>(`/api/repos/${repo.id}/delivery-readiness`),
    refetchInterval: (q) => (operationActive(q.state.data?.operation) ? 2000 : 5000),
  });
  const action = useMutation({
    mutationFn: (stage: DeliveryReadiness["stages"][number]) =>
      api.post<OperationJob>(`/api/repos/${repo.id}/deliver?background=1`, {
        stage: stage.stage,
        previousId: stage.previousId ?? undefined,
        fingerprint: readiness.data?.fingerprint,
      }),
    onSettled: () => {
      void readiness.refetch();
      void qc.invalidateQueries({ queryKey: ["operations"] });
    },
  });
  const r = readiness.data;
  return (
    <article
      id={`delivery-${repo.id}`}
      aria-label={`${repo.name} delivery`}
      className="grid scroll-mt-20 gap-4 rounded-2xl bg-surface p-5 ring-1 ring-line"
    >
      <div className="flex flex-wrap justify-between gap-2">
        <h3 className="font-medium break-words">{repo.name}</h3>
        <Link to="/settings" className="text-[13px] text-dawn">
          Configure delivery →
        </Link>
      </div>
      <p className="text-[12px] text-muted break-all">
        {r?.branch || "No delivery branch configured"}
        {r?.sha ? ` · ${r.sha.slice(0, 12)}` : ""}
      </p>
      <p className="text-[12px] text-muted">
        Eligibility is checked against this local commit and current settings. Starting a stage checks the preview
        again.
      </p>
      {!r && !readiness.error && <p className="text-[13px] text-muted">Checking delivery readiness…</p>}
      <div className="grid gap-3 md:grid-cols-3">
        {r?.stages.map((stage) => (
          <section
            key={stage.stage}
            aria-label={`${stage.stage} eligibility`}
            className="grid content-start gap-3 rounded-xl bg-raised/40 p-3"
          >
            <h4 className="text-[13px] font-medium capitalize">{stage.stage}</h4>
            <p className="text-[12px] text-muted">{stage.blockers.length ? "Held" : "Ready for your action"}</p>
            {stage.blockers.map((message) => (
              <p key={message} className="text-[12px] text-dawn break-words">
                {message}
              </p>
            ))}
            <div>
              <Button
                disabled={!!stage.blockers.length || action.isPending || readiness.isError}
                onClick={() => action.mutate(stage)}
              >
                {labels[stage.stage]}
              </Button>
            </div>
            {stage.latest && (
              <Link
                to="/results/$kind/$resultId"
                params={{ kind: "delivery", resultId: stage.latest.id }}
                className="text-[12px] text-dawn"
              >
                Latest attempt on this commit · {stage.latest.status} →
              </Link>
            )}
          </section>
        ))}
      </div>
      {r && (
        <div className="grid gap-2 text-[12px]">
          <h4 className="font-medium">
            {r.automatic.through === "off" ? "Manual delivery" : `Automatic through ${r.automatic.through}`}
          </h4>
          {r.automatic.next ? (
            <p className="text-muted">{r.automatic.next} is eligible when the crew can take repository access.</p>
          ) : (
            r.automatic.blockers.map((message) => (
              <p key={message} className="text-muted">
                {message}
              </p>
            ))
          )}
        </div>
      )}
      {r?.operation && (
        <div className="grid gap-2">
          <OperationProgress job={r.operation} />
          <Link
            to="/operations/$operationId"
            params={{ operationId: r.operation.id }}
            className="text-[12px] text-dawn"
          >
            View latest delivery operation →
          </Link>
        </div>
      )}
      {!!records.length && (
        <div className="grid gap-2">
          <h4 className="text-[13px] font-medium">Saved delivery results</h4>
          <p className="text-[12px] text-muted">
            Historical outcomes stay attached to their tested commit and settings.
          </p>
          {records.slice(0, showHistory ? records.length : 3).map((row) => (
            <Link
              key={row.id}
              to="/results/$kind/$resultId"
              params={{ kind: "delivery", resultId: row.id }}
              className="text-[12px] text-dawn break-words"
            >
              {row.stage} · {row.status} · {row.sha.slice(0, 8)} · {new Date(row.createdAt).toLocaleString()} →
            </Link>
          ))}
          {records.length > 3 && (
            <div>
              <Button variant="ghost" onClick={() => setShowHistory(!showHistory)}>
                {showHistory ? "Show fewer results" : `Show ${records.length} saved results`}
              </Button>
            </div>
          )}
        </div>
      )}
      {(readiness.error || action.error) && (
        <p role="alert" className="text-[13px] text-bad">
          {(readiness.error ?? action.error)?.message}
        </p>
      )}
    </article>
  );
}
