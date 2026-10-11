import type { Artifact, ArtifactKind, Run } from "./model";
import { decisionFor } from "./station";

export interface Intervention {
  title: string;
  reason: string;
  next: string;
  missing: string[];
  inspect: ArtifactKind[];
}

/** Guidance from recorded outcomes and evidence, never an inferred approval. */
export function interventionFor(run: Run, artifacts: Artifact[]): Intervention {
  const kinds = new Set(artifacts.map((a) => a.kind));
  let missing: string[] = [];
  const evidence = artifacts.find((a) => a.kind === "evidence");
  if (evidence) {
    try {
      const parsed: unknown = JSON.parse(evidence.content);
      if (parsed && typeof parsed === "object" && "missing" in parsed && Array.isArray(parsed.missing))
        missing = parsed.missing.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
    } catch {
      /* Legacy artifacts may be plain text. Keep them available for inspection. */
    }
  }
  const decision = decisionFor(run);
  let title = decision.label;
  let next = decision.action;
  if (run.status === "failed" || run.status === "timeout" || run.status === "blocked") {
    title = "Recover this run";
    next =
      "Inspect the failed checks and stop reason. Fix task scope or repository setup, then retry; send back with a note when the approach needs to change.";
  } else if (missing.length) {
    title = "Complete the evidence";
    next =
      "Inspect what is missing, correct the task or repository settings, then send back with instructions or retry to gather fresh evidence.";
  } else if (run.type === "research" && kinds.has("report")) {
    title = "Review the research";
    next =
      "Check the report's sources and conclusions. Send back any unanswered questions, or dismiss the finished report.";
  } else if (kinds.has("plan") && !kinds.has("tests") && !run.prUrl && !run.shipSha) {
    title = "Review the plan";
    next =
      "Read the proposed approach. To implement it, allow this task type to build in repository routes, then retry. Send back a note to revise the plan first.";
  }
  const order: ArtifactKind[] =
    run.status !== "complete"
      ? ["tests", "log", "policy", "review", "evidence", "plan", "report"]
      : missing.length
        ? ["evidence", "policy", "review", "tests", "plan"]
        : ["review", "policy", "tests", "evidence", "plan", "report"];
  return { title, reason: decision.reason, next, missing, inspect: order.filter((kind) => kinds.has(kind)) };
}
