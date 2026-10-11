import { type DepartureReport, type DepartureTask, formatTokens, policySummary } from "@nightcrew/core";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CheckCircle2, Signal } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";

export type DepartureInput = Partial<DepartureTask> & { repoId: string; title: string; dependsOnIndex?: number[] };

export function DepartureChecks({ tasks }: { tasks: DepartureInput[] }) {
  const input = JSON.stringify(tasks);
  const [settled, setSettled] = useState(input);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(input), 250);
    return () => clearTimeout(timer);
  }, [input]);
  const preview = useQuery({
    queryKey: ["preflight", settled],
    queryFn: () => api.post<DepartureReport>("/api/preflight", { tasks: JSON.parse(settled) }),
    staleTime: 0,
    refetchInterval: 15000,
    retry: false,
  });
  const current = settled === input;
  const report = current && !preview.error ? preview.data : undefined;
  return (
    <section className="grid gap-4 rounded-2xl bg-surface p-4 ring-1 ring-line sm:p-5" aria-label="Departure checks">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="inline-flex items-center gap-2 font-medium text-[14px]">
          <Signal className="size-4 text-dawn" />
          Departure checks
        </h2>
        <span className="text-[11.5px] text-muted">
          {preview.isFetching || !current ? "Updating…" : "Checked against current settings"}
        </span>
      </div>
      <p className="text-[12.5px] text-muted">
        Setup holds stay queued without spending tokens until fixed. Waiting tasks start when their dependencies,
        schedule and budget allow. Scope warnings are advisory.
      </p>
      {preview.error && current && (
        <p role="alert" className="text-[13px] text-bad">
          Couldn't check departure. {preview.error.message}{" "}
          <button type="button" className="underline" onClick={() => preview.refetch()}>
            Retry checks
          </button>
        </p>
      )}
      {!report && !preview.error && (
        <p className="text-[13px] text-muted">Checking routes, setup and available budget…</p>
      )}
      {report && (
        <>
          <dl className="grid grid-cols-2 gap-3 text-[12px] sm:grid-cols-4">
            {[
              ["Used today", report.budget.used],
              ["Reserved by running agents", report.budget.reserved],
              ["Available today", report.budget.available],
              ["These task caps", report.budget.requested],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-muted">{label}</dt>
                <dd className="mt-1 font-mono text-[14px]">{formatTokens(Number(value))}</dd>
              </div>
            ))}
          </dl>
          <p className="text-[11.5px] text-faint">
            Daily limit: {formatTokens(report.budget.daily)}. Caps are reserved as agents start; they are not usage
            estimates or a reservation made by this preview.
          </p>
          {report.tasks.map((task) => {
            const holds = task.signals.some((s) => s.kind === "hold");
            const waits = task.signals.some((s) => s.kind === "wait");
            return (
              <article key={task.taskId} className="grid gap-2 rounded-xl bg-raised/50 p-3.5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h3 className="text-[13.5px] font-medium">{task.title || "Untitled task"}</h3>
                  <span
                    className={holds ? "text-[12px] text-bad" : waits ? "text-[12px] text-dawn" : "text-[12px] text-ok"}
                  >
                    {holds ? "Setup hold" : waits ? "Waiting" : "Ready to queue"}
                  </span>
                </div>
                {task.route && <p className="text-[12px] text-muted">{policySummary(task.route)}</p>}
                {!task.signals.length && (
                  <p className="flex items-center gap-2 text-[12px] text-ok">
                    <CheckCircle2 className="size-3.5" />
                    Departure checks passed.
                  </p>
                )}
                <ul className="grid gap-2">
                  {task.signals.map((signal) => (
                    <li
                      key={`${signal.code}-${signal.taskId ?? signal.message}`}
                      className="text-[12.5px] leading-relaxed"
                    >
                      <span className={signal.kind === "hold" ? "text-bad" : "text-muted"}>{signal.message}</span>{" "}
                      {signal.target === "settings" ? (
                        <Link to="/settings" className="text-dawn underline underline-offset-2">
                          Open settings
                        </Link>
                      ) : signal.taskId ? (
                        <Link
                          to="/task/$taskId"
                          params={{ taskId: signal.taskId }}
                          className="text-dawn underline underline-offset-2"
                        >
                          Open task
                        </Link>
                      ) : (
                        <span className="text-faint">Edit the task above.</span>
                      )}
                    </li>
                  ))}
                </ul>
              </article>
            );
          })}
          <p className="text-[11.5px] text-faint">
            Preflight checks configuration, not command success or actual file conflicts. The crew still gathers
            evidence and verifies changes when it runs.
          </p>
        </>
      )}
    </section>
  );
}
