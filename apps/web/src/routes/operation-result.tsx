import type { OperationJob, OperationResult } from "@nightcrew/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "../api";
import { OperationProgress, operationActive } from "../components/operation-progress";
import { Button } from "../components/ui";

export function OperationPage({ operationId }: { operationId: string }) {
  const operation = useQuery({
    queryKey: ["operation", operationId],
    queryFn: () => api.get<OperationJob>(`/api/operations/${operationId}`),
    refetchInterval: (q) => (operationActive(q.state.data) ? 2000 : false),
  });
  const job = operation.data;
  return (
    <div className="mx-auto grid max-w-[900px] gap-5 px-4 pt-8 pb-24 sm:px-8">
      <Link to="/operations" className="text-[13px] text-dawn">
        ← Operations
      </Link>
      <h1 className="t-h1">
        {job?.kind === "mission"
          ? "Mission verification"
          : job?.kind === "repository"
            ? "Repository setup"
            : job?.stage
              ? `Delivery ${job.stage}`
              : "Operation"}
      </h1>
      {!job && !operation.error && <p className="text-muted">Loading operation…</p>}
      {operation.error && (
        <p role="alert" className="text-bad">
          {operation.error.message}
        </p>
      )}
      {job && (
        <>
          <p className="text-[13px] text-muted">Started {new Date(job.createdAt).toLocaleString()}</p>
          <OperationProgress job={job} />
          {job.resultId ? (
            <ResultDetails kind={job.kind} resultId={job.resultId} />
          ) : (
            !operationActive(job) && (
              <p className="text-[13px] text-muted">No command result was saved. Review the operation message above.</p>
            )
          )}
        </>
      )}
    </div>
  );
}

export function ResultPage({ kind, resultId }: { kind: string; resultId: string }) {
  return (
    <div className="mx-auto grid max-w-[900px] gap-5 px-4 pt-8 pb-24 sm:px-8">
      <Link to="/operations" className="text-[13px] text-dawn">
        ← Operations
      </Link>
      <h1 className="t-h1">Saved result</h1>
      <ResultDetails kind={kind} resultId={resultId} />
    </div>
  );
}

function Log({ text }: { text: string }) {
  return (
    <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-raised/40 p-4 text-[12px]">
      {text}
    </pre>
  );
}
function ResultDetails({ kind, resultId }: { kind: string; resultId: string }) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["operation-result", kind, resultId],
    queryFn: () => api.get<OperationResult>(`/api/results/${encodeURIComponent(kind)}/${encodeURIComponent(resultId)}`),
    refetchInterval: (q) =>
      q.state.data?.kind === "delivery" && q.state.data.result.status === "running" ? 2000 : false,
  });
  const retry = useMutation({
    mutationFn: () => api.post(`/api/deliveries/${resultId}/allow-retry`, { inspected: true }),
    onSuccess: () => {
      void query.refetch();
      void qc.invalidateQueries({ queryKey: ["delivery-readiness"] });
      void qc.invalidateQueries({ queryKey: ["operations"] });
    },
  });
  const data = query.data;
  return (
    <section className="grid min-w-0 gap-4 rounded-2xl bg-surface p-5 ring-1 ring-line">
      <p className="text-[12px] text-muted">
        This saved outcome belongs to the snapshot tested at the time. It does not establish current readiness.
      </p>
      {!data && !query.error && <p className="text-muted">Loading saved result…</p>}
      {(query.error || retry.error) && (
        <p role="alert" className="text-bad">
          {(query.error ?? retry.error)?.message}
        </p>
      )}
      {data?.kind === "delivery" && (
        <>
          <h2 className="t-h3">
            Delivery {data.result.stage} · {data.result.status}
          </h2>
          <p className="text-[12px] text-muted">{new Date(data.result.createdAt).toLocaleString()}</p>
          <p className="font-mono text-[12px] break-all">
            {data.result.branch} · {data.result.sha}
          </p>
          {data.result.status === "failed" || data.result.status === "interrupted" ? (
            <p className="text-[13px] text-dawn">
              Inspect the external outcome before retrying. Commands may have performed an action before they stopped or
              failed.
            </p>
          ) : null}
          {data.result.status === "interrupted" && (
            <div>
              <Button disabled={retry.isPending} onClick={() => retry.mutate()}>
                I inspected the external outcome; allow manual retry
              </Button>
            </div>
          )}
          <Log text={data.result.log || "Command running…"} />
          <Link to="/operations" hash={`delivery-${data.result.repoId}`} className="text-[13px] text-dawn">
            Review current delivery eligibility →
          </Link>
        </>
      )}
      {data?.kind === "repository" && (
        <>
          <h2 className="t-h3">Repository setup · {data.result.status}</h2>
          <p className="text-[12px] text-muted">{new Date(data.result.at).toLocaleString()}</p>
          <p className="font-mono text-[12px] break-all">
            {data.result.branch} · {data.result.sha}
          </p>
          <Log text={data.result.detail} />
          <Link to="/operations" hash={`setup-${data.result.repoId}`} className="text-[13px] text-dawn">
            Review current setup readiness →
          </Link>
        </>
      )}
      {data?.kind === "mission" && (
        <>
          <h2 className="t-h3">Mission acceptance · {data.result.status}</h2>
          <p className="text-[12px] text-muted">{new Date(data.result.at).toLocaleString()}</p>
          <h3 className="text-[14px] font-medium">Evidence recorded for this verification</h3>
          {data.result.evidence.map((row) => (
            <div key={row.criterion} className="grid gap-2 text-[13px] break-words">
              <h4 className="font-medium">{row.criterion}</h4>
              <p className="whitespace-pre-wrap text-muted">{row.evidence}</p>
            </div>
          ))}
          {data.result.checks.map((row) => (
            <div key={row.repoId} className="grid gap-2">
              <p className="font-mono text-[12px] break-all">
                {row.ok ? "Passed" : "Failed"}
                {row.sha ? ` · ${row.sha}` : ""}
              </p>
              <Log text={row.detail} />
            </div>
          ))}
          {!data.result.checks.length && (
            <p className="text-[12px] text-muted">No combined repository commands were recorded for this result.</p>
          )}
          <Link
            to="/missions/$missionId"
            params={{ missionId: data.result.missionId }}
            className="text-[13px] text-dawn"
          >
            Review current mission acceptance →
          </Link>
        </>
      )}
    </section>
  );
}
