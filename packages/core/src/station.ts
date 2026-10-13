import type { Run } from "./model";

export interface QueueEntry {
  taskId: string;
  title: string;
  repoName: string;
  kind: "ready" | "scheduled" | "paused" | "dependency" | "capacity" | "budget" | "deadline" | "backoff" | "setup";
  reason: string;
  runAt: string | null;
}

export interface StationReport {
  /** Unresolved decisions, including work from earlier report days. */
  decisions: Run[];
  /** Latest resolved outcomes, newest first. */
  recent: Run[];
  latestNightId: string | null;
  queue: QueueEntry[];
}

export function needsDecision(run: Run): boolean {
  return (
    !["pending", "running"].includes(run.status) &&
    run.triage === null &&
    run.prState !== "closed" &&
    run.bucket !== "shipped" &&
    run.bucket !== "back"
  );
}

/** Describe the next human action without treating an agent's claims as proof. */
export function decisionFor(run: Run): { label: string; reason: string; action: string } {
  if (run.bucket === "failed")
    return {
      label: "Recovery needed",
      reason: run.reason ?? "The run stopped before completing its work.",
      action: "Inspect the failure, then retry, send instructions, or dismiss.",
    };
  if (run.bucket === "ready")
    return {
      label: run.trainId ? "Train review" : "Merge decision",
      reason:
        run.reason ??
        (run.trainId
          ? "The change is on an integration train awaiting your review."
          : "The pull request is waiting for your merge decision."),
      action: run.trainId
        ? "Review the evidence and the train's combined changes."
        : "Review the evidence, then merge or send back.",
    };
  return {
    label: "Needs your judgement",
    reason:
      run.reason ??
      (run.verdict === "not_done"
        ? "The reviewer found unfinished work."
        : "The result needs a human review before it can move forward."),
    action: "Inspect the evidence and review, then give the crew a decision.",
  };
}
