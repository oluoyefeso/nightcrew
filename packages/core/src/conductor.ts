export interface GoalConductor {
  missionId: string;
  repoId: string;
  generation: number;
  state: "planning" | "working" | "verifying" | "needs_you" | "paused" | "ready";
  code: string;
  detail: string;
  intent: string;
  taskIds: string[];
  repairs: number;
  resultId: string | null;
  updatedAt: string;
}

export interface GoalResult {
  id: string;
  missionId: string;
  fingerprint: string;
  at: string;
  status: "passed" | "failed";
  summary: string;
  commit: string | null;
  checks: { ok: boolean; detail: string }[];
  criteria: {
    criterion: string;
    met: boolean;
    evidence: { source: string; quote: string }[];
  }[];
  sources: { id: string; runId: string | null; kind: string; content: string }[];
}
