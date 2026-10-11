import type { TaskPolicies } from "./policy";

/** Durable progress metadata; command output remains on the verification/delivery result. */
export interface OperationJob {
  id: string;
  kind: "mission" | "delivery" | "repository";
  subjectId: string;
  stage: Delivery["stage"] | null;
  status: "running" | "stopping" | "passed" | "failed" | "interrupted";
  phase: "validating" | "waiting" | "preparing" | "setup" | "command" | "finalizing" | "finished";
  repoId: string | null;
  resultId: string | null;
  detail: string;
  createdAt: string;
  updatedAt: string;
}

export interface RepositoryCheck {
  id: string;
  repoId: string;
  fingerprint: string;
  branch: string;
  sha: string;
  status: "passed" | "failed" | "interrupted";
  detail: string;
  at: string;
}

export interface RepositoryReadiness {
  fingerprint: string;
  branch: string;
  sha: string | null;
  blockers: string[];
  latest: RepositoryCheck | null;
  operation: OperationJob | null;
  verified: boolean;
}

export interface Checkpoint {
  taskId: string;
  runId: string;
  stage: "plan" | "build";
  fingerprint: string;
  sha: string;
  plan: string | null;
  summary: string | null;
  at: string;
}
export interface PolicyTemplate {
  id: string;
  name: string;
  policies: TaskPolicies;
  updatedAt: string;
}
export interface AuditEntry {
  id: number;
  at: string;
  actor: "you" | "crew";
  action: string;
  subjectId: string;
  detail: string;
}
export interface MissionAcceptance {
  id: string;
  missionId: string;
  at: string;
  fingerprint: string;
  status: "passed" | "failed";
  checks: { repoId: string; sha: string; ok: boolean; detail: string }[];
  evidence: { criterion: string; evidence: string }[];
}
export interface DeliveryPolicy {
  branch: string;
  check: string;
  deploy: string;
  release: string;
  automatic: "off" | "check" | "deploy" | "release";
  /** Environment variable names only. Values never enter the database. */
  environment: string[];
}
export interface Delivery {
  id: string;
  repoId: string;
  sha: string;
  branch: string;
  policy: DeliveryPolicy & { setupCommand?: string | null };
  stage: "check" | "deploy" | "release";
  status: "running" | "passed" | "failed" | "interrupted";
  log: string;
  createdAt: string;
  updatedAt: string;
}
export const DEFAULT_DELIVERY: DeliveryPolicy = {
  branch: "",
  check: "",
  deploy: "",
  release: "",
  automatic: "off",
  environment: [],
};
export function validateDelivery(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Provide a delivery policy.";
  const p = value as DeliveryPolicy;
  if (Object.keys(p).some((k) => !Object.keys(DEFAULT_DELIVERY).includes(k))) return "Unknown delivery setting.";
  if ([p.branch, p.check, p.deploy, p.release].some((v) => typeof v !== "string" || v.length > 4000))
    return "Delivery branch and commands must be text (up to 4,000 characters).";
  if (
    p.branch &&
    (!/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/.test(p.branch) ||
      p.branch.includes("..") ||
      p.branch.endsWith("/") ||
      p.branch.endsWith(".lock"))
  )
    return "Use a valid delivery branch.";
  if (!["off", "check", "deploy", "release"].includes(p.automatic)) return "Choose a valid delivery authority.";
  if (
    !Array.isArray(p.environment) ||
    p.environment.length > 20 ||
    p.environment.some(
      (v) =>
        typeof v !== "string" ||
        !/^[A-Z][A-Z0-9_]*$/.test(v) ||
        /^(HOME|PATH|SHELL|NODE_OPTIONS|BUN_OPTIONS|LD_|DYLD_|GIT_|NIGHTCREW_|NC_)/.test(v),
    )
  )
    return "Allow only explicit credential environment names; runtime and NightCrew variables are reserved.";
  if ((p.deploy.trim() || p.release.trim() || p.automatic !== "off") && (!p.branch.trim() || !p.check.trim()))
    return "Delivery requires a branch and verification command.";
  if ((p.automatic === "deploy" || p.automatic === "release" || p.release.trim()) && !p.deploy.trim())
    return "Configure deployment before release.";
  if (p.automatic === "release" && !p.release.trim()) return "Configure a release command first.";
  return null;
}
