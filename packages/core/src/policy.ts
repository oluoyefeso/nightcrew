import { AUTONOMY_LABEL, type AutonomyLevel, EVIDENCE_FOR, type Repo, TASK_TYPES, type TaskType } from "./tasks";

export type PolicyTaskType = Exclude<TaskType, "research">;
export const POLICY_TASK_TYPES = TASK_TYPES.filter((t): t is PolicyTaskType => t !== "research");
export const AUTONOMY_ORDER: AutonomyLevel[] = ["propose", "draft_pr", "train", "ship"];

export interface TaskPolicy {
  /** Null inherits the repo ceiling. A task rule can only reduce that authority. */
  autonomy: AutonomyLevel | null;
  requireTests: boolean;
  visual: boolean;
  regression: boolean;
  reviewers?: number;
}

export type TaskPolicies = Partial<Record<PolicyTaskType, TaskPolicy>>;
export const DEFAULT_TASK_POLICY: TaskPolicy = {
  autonomy: null,
  requireTests: false,
  visual: false,
  regression: false,
};

export interface ResolvedPolicy {
  type: TaskType;
  authority: AutonomyLevel;
  requireTests: boolean;
  visual: boolean;
  regression: boolean;
  reviewers?: number;
}

export function limitAuthority(a: AutonomyLevel, b: AutonomyLevel): AutonomyLevel {
  return AUTONOMY_ORDER[Math.min(AUTONOMY_ORDER.indexOf(a), AUTONOMY_ORDER.indexOf(b))] ?? "propose";
}

export function resolvePolicy(repo: Pick<Repo, "level" | "policies">, type: TaskType): ResolvedPolicy {
  if (type === "research") return { type, authority: "propose", requireTests: false, visual: false, regression: false };
  const rule = repo.policies?.[type] ?? DEFAULT_TASK_POLICY;
  return {
    type,
    authority: limitAuthority(repo.level, rule.autonomy ?? repo.level),
    requireTests: rule.requireTests || rule.regression || type === "bugfix",
    visual: type === "ui" || rule.visual,
    regression: type === "bugfix" || rule.regression,
    reviewers: rule.reviewers ?? 1,
  };
}

/** A running task retains the stricter of its starting policy and the current policy. */
export function tightenPolicy(start: ResolvedPolicy, current: ResolvedPolicy): ResolvedPolicy {
  return {
    type: start.type,
    authority: limitAuthority(start.authority, current.authority),
    requireTests: start.requireTests || current.requireTests,
    visual: start.visual || current.visual,
    regression: start.regression || current.regression,
    reviewers: Math.max(start.reviewers ?? 1, current.reviewers ?? 1),
  };
}

export function policyEvidence(policy: ResolvedPolicy): string[] {
  if (policy.type === "research") return EVIDENCE_FOR.research;
  if (policy.authority === "propose") return ["A written plan for your review"];
  return [
    ...new Set([
      ...EVIDENCE_FOR[policy.type],
      `${policy.reviewers ?? 1} independent Skeptic review${(policy.reviewers ?? 1) > 1 ? "s" : ""}`,
      ...(policy.requireTests ? ["A configured test command must pass"] : []),
      ...(policy.visual ? EVIDENCE_FOR.ui : []),
      ...(policy.regression ? EVIDENCE_FOR.bugfix : []),
    ]),
  ];
}

export function policySummary(policy: ResolvedPolicy): string {
  if (policy.type === "research") return "Read-only research → written report";
  if (policy.authority === "propose") return "Plan → your review";
  const checks = [
    "Build",
    policy.requireTests ? "required tests" : "checks",
    ...(policy.visual ? ["visual evidence"] : []),
    ...(policy.regression ? ["regression proof"] : []),
    (policy.reviewers ?? 1) > 1 ? `${policy.reviewers} Skeptic reviews` : "Skeptic",
  ];
  return `${checks.join(" → ")} → ${AUTONOMY_LABEL[policy.authority]}`;
}

/** Strict validation at the API boundary; never accept misspelled or silently ignored rules. */
export function validatePolicies(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "Task policies must be an object keyed by task type.";
  for (const [type, rule] of Object.entries(value)) {
    if (!POLICY_TASK_TYPES.includes(type as PolicyTaskType)) return `No configurable policy for task type: ${type}.`;
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) return `The ${type} policy must be an object.`;
    const fields = Object.keys(rule);
    if (
      fields.length < 4 ||
      fields.length > 5 ||
      ["autonomy", "requireTests", "visual", "regression"].some((key) => !fields.includes(key)) ||
      fields.some((key) => !["autonomy", "requireTests", "visual", "regression", "reviewers"].includes(key))
    )
      return `The ${type} policy needs autonomy, requireTests, visual, and regression.`;
    const r = rule as TaskPolicy;
    if (r.reviewers !== undefined && (!Number.isInteger(r.reviewers) || r.reviewers < 1 || r.reviewers > 3))
      return "Choose one to three independent reviewers.";
    if (r.autonomy !== null && !AUTONOMY_ORDER.includes(r.autonomy))
      return `Choose a valid autonomy level for ${type}, or null to inherit.`;
    if ([r.requireTests, r.visual, r.regression].some((x) => typeof x !== "boolean"))
      return `Verification settings for ${type} must be true or false.`;
  }
  return null;
}
