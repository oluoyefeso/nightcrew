// Domain model shared by the runner, the API and the dashboard.

export type RunStatus = "pending" | "running" | "complete" | "failed" | "timeout" | "blocked" | "paused";

/** Where a run sits in the Morning Report. */
export type Bucket = "shipped" | "ready" | "eyes" | "back" | "failed";

export type RunSource = "classic" | "local" | "managed";

export type PrState = "open" | "draft" | "merged" | "closed";

export type ArtifactKind = "evidence" | "plan" | "decisions" | "review" | "tests" | "report" | "log";

export type TriageAction = "merge" | "send_back" | "close" | "tonight" | "undo";

export interface Run {
  id: string;
  nightId: string;
  taskId: string;
  title: string;
  repo: string;
  type: string | null;
  status: RunStatus;
  bucket: Bucket;
  source: RunSource;
  startedAt: string | null;
  endedAt: string | null;
  model: string | null;
  costCents: number;
  tokensIn: number;
  tokensOut: number;
  attempt: number;
  prUrl: string | null;
  prNumber: number | null;
  prState: PrState | null;
  branch: string | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  reason: string | null;
  /** The reviewer's verdict: ready, needs_eyes or not_done. */
  verdict: string | null;
  /** plan | implement | review | validate | publish while running. */
  phase: string | null;
  /** One-line crew note: what the agent says it did. */
  summary: string | null;
  /** The user's latest triage decision, if it hasn't been undone. */
  triage: TriageAction | null;
  /** The note that came with it. */
  note: string | null;
  artifactKinds: ArtifactKind[];
}

export interface Artifact {
  kind: ArtifactKind;
  name: string;
  content: string;
}

export interface Night {
  id: string;
  startedAt: string;
  endedAt: string;
  runCount: number;
  costCents: number;
}

export interface NightReport {
  night: Night;
  runs: Run[];
  previousId: string | null;
  nextId: string | null;
}

export interface RunDetail {
  run: Run;
  artifacts: Artifact[];
  attempts: Pick<Run, "id" | "nightId" | "status" | "startedAt" | "reason">[];
}
