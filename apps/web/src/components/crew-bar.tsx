import { formatCost } from "@nightcrew/core";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { crewQuery, eventsQuery, tasksQuery } from "../api";

const PHASE_LABEL: Record<string, string> = {
  setup: "Preparing",
  plan: "Planning",
  implement: "Implementing",
  validate: "Checking",
  repair: "Repairing",
  review: "Reviewing",
  publish: "Opening the PR",
  research: "Researching",
};

/** A live strip showing what the crew is doing right now. */
export function CrewBar() {
  const crew = useQuery(crewQuery);
  const tasks = useQuery(tasksQuery(["queued", "running"]));
  const status = crew.data;
  const events = useQuery({ ...eventsQuery(status?.runId ?? "none"), enabled: Boolean(status?.runId) });
  if (!status || status.state === "idle") {
    return status?.message ? <p className="-mt-4 text-[12.5px] text-faint">{status.message}</p> : null;
  }
  const task = tasks.data?.find((t) => t.id === status.taskId);
  const last = events.data?.at(-1);
  const phase = [...(events.data ?? [])].reverse().find((e) => e.kind === "phase");
  return (
    <div className="relative grid gap-2 overflow-hidden rounded-2xl bg-surface px-5 py-4 ring-1 ring-[color-mix(in_srgb,var(--dawn)_35%,transparent)]">
      <div className="absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-raised">
        <div className="h-full w-1/3 animate-[nc-sweep_2.4s_ease-in-out_infinite] bg-dawn" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="size-2 shrink-0 animate-pulse rounded-full bg-dawn" />
          <span className="truncate font-medium text-[14px]">
            {status.state === "waiting"
              ? "Waiting"
              : status.state === "stopping"
                ? "Stopping"
                : (PHASE_LABEL[phase?.phase ?? ""] ?? "Working")}
            {task && <span className="text-muted"> · {task.title}</span>}
          </span>
        </div>
        <div className="flex items-center gap-4 font-mono text-[11.5px] text-muted tabular">
          <span>{status.done} done</span>
          <span>{formatCost(status.spentCents)} spent</span>
          {status.runId && (
            <Link
              to="/run/$runId"
              params={{ runId: status.runId }}
              className="inline-flex items-center gap-1 text-fg hover:text-dawn"
            >
              Watch <ArrowRight className="size-3" />
            </Link>
          )}
        </div>
      </div>
      {(status.message && status.state === "waiting") || last ? (
        <p className="truncate font-mono text-[12px] text-faint">
          {status.state === "waiting" ? status.message : last?.text}
        </p>
      ) : null}
    </div>
  );
}
