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
  return (
    <section className="grid gap-4 rounded-2xl bg-surface p-5 ring-1 ring-line">
      <h2 className="text-[16px] font-medium">
        Mission acceptance · {r?.accepted ? "Accepted" : "Needs verification"}
      </h2>
      <p className="text-[13px] text-muted">
        Task completion is separate from objective acceptance. Review each criterion, record your evidence, then run
        combined tests on the pinned local branches. Changes to the objective, tasks or branches invalidate acceptance.
      </p>
      {r?.targets.map((t) => (
        <p key={t.repoId} className="text-[12px] text-muted break-all">
          {t.name} · {t.branch} · {t.sha.slice(0, 8)}
        </p>
      ))}
      {r?.operation && <OperationProgress job={r.operation} />}
      {!!r?.blockers.length && (
        <ul className="list-disc pl-5 text-[13px] text-dawn">
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
              : "Verify and accept mission"}
        </Button>
      </div>
      {r?.latest && (
        <details className="text-[13px]">
          <summary className="cursor-pointer">
            Last verification · {r.latest.status}
            {r.latest.fingerprint !== r.fingerprint ? " · outdated" : ""}
          </summary>
          <p className="mt-2 text-muted">{new Date(r.latest.at).toLocaleString()}</p>
          {r.latest.evidence.map((e) => (
            <p key={e.criterion} className="mt-2 whitespace-pre-wrap">
              <strong>{e.criterion}</strong>: {e.evidence}
            </p>
          ))}
          {r.latest.checks.map((c) => (
            <pre
              key={c.repoId}
              className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-bg p-3 text-[12px]"
            >
              {c.ok ? "Passed" : "Failed"} · {c.detail}
            </pre>
          ))}
          <Link
            to="/results/$kind/$resultId"
            params={{ kind: "mission", resultId: r.latest.id }}
            className="mt-3 inline-block text-[12px] text-dawn"
          >
            Open this saved result →
          </Link>
        </details>
      )}
      {(accept.error || readiness.error) && (
        <p role="alert" className="text-bad">
          {(accept.error ?? readiness.error)?.message}
        </p>
      )}
    </section>
  );
}
