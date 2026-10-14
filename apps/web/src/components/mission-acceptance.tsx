import type { Mission, MissionAcceptance, OperationJob } from "@nightcrew/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../api";
import { Field, TextArea } from "./form";
import { OperationProgress, operationActive } from "./operation-progress";
import { Button } from "./ui";

interface Readiness {
  accepted: boolean;
  fingerprint: string;
  blockers: string[];
  targets: { repoId: string; name: string; branch: string; sha: string }[];
  latest: MissionAcceptance | null;
  operation: OperationJob | null;
}
export function MissionAcceptancePanel({ mission }: { mission: Mission }) {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const readiness = useQuery({
    queryKey: ["acceptance", mission.id, mission.updatedAt],
    queryFn: () => api.get<Readiness>(`/api/missions/${mission.id}/acceptance`),
    refetchInterval: (q) => (operationActive(q.state.data?.operation) ? 2000 : 10000),
  });
  const accept = useMutation({
    mutationFn: () =>
      api.post(`/api/missions/${mission.id}/acceptance?background=1`, {
        fingerprint: readiness.data?.fingerprint,
        evidence: mission.criteria.map((criterion) => ({ criterion, evidence: notes[criterion] ?? "" })),
      }),
    onSuccess: () => {
      void readiness.refetch();
    },
  });
  const r = readiness.data;
  const outdated = !!r?.latest && r.latest.fingerprint !== r.fingerprint;
  const status = readiness.isError
    ? "Status unavailable"
    : !r
      ? "Checking status…"
      : r.accepted
        ? "Accepted"
        : "Needs verification";
  const extra = r ? Math.max(r.blockers.length - 1, 0) : 0;
  return (
    <section aria-labelledby={`outcome-${mission.id}`} className="grid gap-3 border-t border-line pt-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={`outcome-${mission.id}`} className="text-[16px] font-medium">
          Outcome
        </h2>
        <p className="text-[14px] font-medium" role="status">
          {status}
        </p>
      </div>
      <p className="text-[13px] text-muted">
        Resolving tasks does not certify the objective. Acceptance needs your evidence and passing combined checks.
      </p>
      {outdated && (
        <p className="text-[13px] text-dawn">
          The last verification is outdated: the objective, tasks or branches have changed since.
        </p>
      )}
      {r?.latest && (
        <p className={r.latest.status === "failed" ? "text-[13px] text-bad" : "text-[13px] text-muted"}>
          Last verification · {r.latest.status}
          {outdated ? " · outdated" : ""}
          {" · "}
          <Link to="/results/$kind/$resultId" params={{ kind: "mission", resultId: r.latest.id }} className="text-dawn">
            Open saved result →
          </Link>
        </p>
      )}
      {r?.operation && <OperationProgress job={r.operation} />}
      {r && !!r.blockers.length && (
        <p className="text-[13px] text-dawn break-words">
          Blocked: {r.blockers[0]}
          {extra > 0 ? ` (+${extra} more)` : ""}
        </p>
      )}
      <details className="border-t border-line pt-3 text-[13px]">
        <summary className="cursor-pointer text-[13px] font-medium">Review and verify</summary>
        <div className="mt-4 grid gap-4">
          {r?.targets.map((t) => (
            <p key={t.repoId} className="text-[12px] text-muted break-all">
              {t.name} · {t.branch} · {t.sha.slice(0, 8)}
            </p>
          ))}
          {!!r?.blockers.length && (
            <ul className="list-disc pl-5 text-[13px] text-dawn break-words">
              {r.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
          {mission.criteria.map((criterion, i) => (
            <Field key={criterion} label={criterion} htmlFor={`acceptance-${i}`}>
              <TextArea
                id={`acceptance-${i}`}
                value={notes[criterion] ?? ""}
                onChange={(e) => setNotes({ ...notes, [criterion]: e.target.value })}
                maxLength={4000}
                rows={2}
                placeholder="What demonstrates that this criterion is met?"
              />
            </Field>
          ))}
          <div>
            <Button
              disabled={
                !r ||
                readiness.isError ||
                !!r.blockers.length ||
                accept.isPending ||
                operationActive(r.operation) ||
                !mission.criteria.length ||
                mission.criteria.some((c) => !notes[c]?.trim())
              }
              onClick={() => accept.mutate()}
            >
              {accept.isPending
                ? "Starting verification…"
                : operationActive(r?.operation)
                  ? "Verification in progress…"
                  : "Verify and accept goal"}
            </Button>
          </div>
          {r?.latest && (
            <div className="grid gap-2 border-t border-line pt-3">
              <p className="font-medium">
                Last verification · {r.latest.status}
                {outdated ? " · outdated" : ""}
              </p>
              <p className="text-muted">{new Date(r.latest.at).toLocaleString()}</p>
              {r.latest.evidence.map((e) => (
                <p key={e.criterion} className="whitespace-pre-wrap break-words">
                  <strong>{e.criterion}</strong>: {e.evidence}
                </p>
              ))}
              {r.latest.checks.map((c) => (
                <pre
                  key={c.repoId}
                  className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-bg p-3 text-[12px]"
                >
                  {c.ok ? "Passed" : "Failed"} · {c.detail}
                </pre>
              ))}
              <Link
                to="/results/$kind/$resultId"
                params={{ kind: "mission", resultId: r.latest.id }}
                className="inline-block text-[12px] text-dawn"
              >
                Open this saved result →
              </Link>
            </div>
          )}
        </div>
      </details>
      {(accept.error || readiness.error) && (
        <p role="alert" className="text-bad">
          {(accept.error ?? readiness.error)?.message}
        </p>
      )}
    </section>
  );
}
