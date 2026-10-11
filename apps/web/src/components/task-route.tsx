import { policyEvidence, policySummary, type Repo, resolvePolicy, type TaskType } from "@nightcrew/core";
import { Route } from "lucide-react";

export function TaskRoute({ repo, type, compact = false }: { repo: Repo; type: TaskType; compact?: boolean }) {
  const policy = resolvePolicy(repo, type);
  return (
    <section className="grid gap-2 rounded-xl bg-raised/50 p-3.5" aria-label="Task route">
      <span className="inline-flex items-center gap-2 font-medium text-[12.5px] text-dawn">
        <Route className="size-3.5" /> Route before dispatch
      </span>
      <p className="text-[13px] leading-relaxed">{policySummary(policy)}</p>
      {!compact && (
        <ul className="grid gap-1 text-[12.5px] text-muted">
          {policyEvidence(policy).map((item) => (
            <li key={item}>• {item}</li>
          ))}
        </ul>
      )}
      <p className="text-[12px] text-muted">
        {type === "research"
          ? "Research produces a report and makes no code changes."
          : policy.authority === "ship"
            ? `May merge to ${repo.shipBranch ?? "the configured ship branch"} when the evidence and path rules pass.`
            : policy.authority === "train"
              ? "Changes are tested together on the train. You merge its PR."
              : policy.authority === "propose"
                ? "Stops at a plan for your review."
                : "Stops at a draft PR for your merge decision."}
      </p>
      {!compact && (
        <p className="text-[12px] text-faint">
          The repo's path rules also apply. Missing required evidence brings the task back to you. This preview uses
          current settings; a completed run records the route it actually followed.
        </p>
      )}
    </section>
  );
}
