import type { OperationJob } from "@nightcrew/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Button } from "./ui";

export const operationActive = (job?: OperationJob | null) => job?.status === "running" || job?.status === "stopping";
const phases: Record<OperationJob["phase"], string> = {
  validating: "Checking requirements",
  waiting: "Waiting for repository access",
  preparing: "Preparing isolated checkout",
  setup: "Running repository setup",
  command: "Running command",
  finalizing: "Cleaning up checkout",
  finished: "Finished",
};

export function OperationProgress({ job }: { job: OperationJob }) {
  const qc = useQueryClient();
  const stop = useMutation({
    mutationFn: () => api.post(`/api/operations/${job.id}/stop`),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["operations"] });
      void qc.invalidateQueries({ queryKey: ["acceptance"] });
      void qc.invalidateQueries({ queryKey: ["repository-readiness"] });
    },
  });
  const active = operationActive(job);
  const seconds = Math.max(
    0,
    Math.floor(((active ? Date.now() : Date.parse(job.updatedAt)) - Date.parse(job.createdAt)) / 1000),
  );
  return (
    <div className="grid gap-2 text-[13px]" aria-live="polite">
      <p className="font-medium">
        {job.status === "stopping"
          ? "Stopping…"
          : active
            ? phases[job.phase]
            : job.status === "passed"
              ? "Passed"
              : job.status === "interrupted"
                ? "Interrupted"
                : "Failed"}
        <span className="font-normal text-muted">
          {" "}
          · {seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`}
        </span>
      </p>
      {job.detail && <p className="break-words text-muted">{job.detail}</p>}
      {active && (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="ghost" disabled={stop.isPending || job.status === "stopping"} onClick={() => stop.mutate()}>
            Stop this operation
          </Button>
          <span className="text-[12px] text-muted">You can leave this page; the local runner keeps working.</span>
        </div>
      )}
      {stop.error && (
        <p role="alert" className="text-bad">
          {stop.error.message}
        </p>
      )}
    </div>
  );
}
