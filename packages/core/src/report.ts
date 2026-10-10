import type { Bucket, PrState, Run, RunStatus } from "./model";

export const BUCKET_ORDER: Bucket[] = ["shipped", "ready", "eyes", "back", "failed"];

export const BUCKET_LABEL: Record<Bucket, string> = {
  shipped: "Shipped",
  // (Shipped covers merged PRs, ships to dev and finished research.)
  ready: "Ready to merge",
  eyes: "Needs your eyes",
  back: "Sent back",
  failed: "Failed",
};

/**
 * Decide which Morning Report bucket a run belongs to.
 * A triage decision from the user always wins over what the run reported.
 */
export function classify(input: {
  status: RunStatus;
  prState: PrState | null;
  prUrl: string | null;
  triage?: "merge" | "send_back" | "close" | "again" | "undo" | null;
  verdict?: string | null;
  type?: string | null;
  /** Shipped by the crew to the ship branch, and not undone. */
  shipped?: boolean;
  /** Merged into tonight's train; you merge the train. */
  onTrain?: boolean;
}): Bucket {
  if (input.triage === "send_back" || input.triage === "again") return "back";
  if (input.triage === "merge" || input.prState === "merged" || input.shipped) return "shipped";
  if (input.triage === "close" || input.prState === "closed") return "failed";
  if (input.status === "failed" || input.status === "timeout" || input.status === "blocked") {
    return "failed";
  }
  if (input.status === "running" || input.status === "pending") return "eyes";
  // A research report is the deliverable; there's nothing to merge.
  if (input.type === "research" && input.status === "complete") return "shipped";
  if (
    input.status === "complete" &&
    (input.prUrl || input.onTrain) &&
    (input.verdict == null || input.verdict === "ready")
  )
    return "ready";
  return "eyes";
}

/**
 * A report day runs from 04:00 to 04:00 local time: agents work around the
 * clock, and late-night work still belongs to the day it started.
 */
export const REPORT_DAY_CUTOFF_HOURS = 4;

export function nightIdFor(iso: string, offsetMinutes = new Date(iso).getTimezoneOffset()): string {
  const local = new Date(new Date(iso).getTime() - offsetMinutes * 60_000);
  local.setUTCHours(local.getUTCHours() - REPORT_DAY_CUTOFF_HOURS);
  return local.toISOString().slice(0, 10);
}

export interface HorizonWindow {
  start: Date;
  end: Date;
}

/**
 * The Horizon covers the hours around the day's work, in whole hours. For
 * today it runs up to now, so agents still working sit at its right edge.
 */
export function horizonWindow(
  runs: Pick<Run, "startedAt" | "endedAt">[],
  dayId: string,
  now = new Date(),
): HorizonWindow {
  const times = runs
    .flatMap((r) => [r.startedAt, r.endedAt])
    .filter((t): t is string => Boolean(t))
    .map((t) => new Date(t).getTime());
  if (nightIdFor(now.toISOString()) === dayId) times.push(now.getTime());
  if (times.length === 0) {
    const start = new Date(`${dayId}T09:00:00`);
    return { start, end: new Date(start.getTime() + 9 * 3_600_000) };
  }
  const s = new Date(Math.min(...times));
  s.setMinutes(0, 0, 0);
  const e = new Date(Math.max(...times));
  if (e.getMinutes() || e.getSeconds() || e.getMilliseconds()) e.setHours(e.getHours() + 1, 0, 0, 0);
  if (e.getTime() - s.getTime() < 3 * 3_600_000) s.setTime(e.getTime() - 3 * 3_600_000);
  // Today: leave room after "now" so the latest reports don't sit under the marker.
  if (nightIdFor(now.toISOString()) === dayId) {
    const room = Math.max(30 * 60_000, (e.getTime() - s.getTime()) * 0.15);
    // Whole hours, so the hour labels underneath stay true to scale.
    const end = Math.ceil((now.getTime() + room) / 3_600_000) * 3_600_000;
    if (end > e.getTime()) e.setTime(end);
  }
  return { start: s, end: e };
}

/** Position of a timestamp on the Horizon, 0–100. */
export function horizonPosition(iso: string, w: HorizonWindow): number {
  const span = w.end.getTime() - w.start.getTime();
  const pct = ((new Date(iso).getTime() - w.start.getTime()) / span) * 100;
  return Math.max(0, Math.min(100, pct));
}

export interface ReportSummary {
  total: number;
  byBucket: Record<Bucket, number>;
  prs: number;
  costCents: number;
  unattendedMs: number;
}

export function summarize(runs: Run[]): ReportSummary {
  const byBucket: Record<Bucket, number> = { shipped: 0, ready: 0, eyes: 0, back: 0, failed: 0 };
  let costCents = 0;
  let prs = 0;
  let first = Number.POSITIVE_INFINITY;
  let last = 0;
  for (const r of runs) {
    byBucket[r.bucket]++;
    costCents += r.costCents;
    if (r.prUrl) prs++;
    if (r.startedAt) first = Math.min(first, new Date(r.startedAt).getTime());
    if (r.endedAt) last = Math.max(last, new Date(r.endedAt).getTime());
  }
  return {
    total: runs.length,
    byBucket,
    prs,
    costCents,
    unattendedMs: last > first ? last - first : 0,
  };
}

/** "Good morning. Two shipped, two need you." */
export function greeting(s: ReportSummary, now = new Date()): string {
  const h = now.getHours();
  const hello = h < 12 ? "Good morning." : h < 18 ? "Good afternoon." : "Good evening.";
  if (s.total === 0) return `${hello} Nothing has finished yet.`;
  const needYou = s.byBucket.ready + s.byBucket.eyes;
  const parts: string[] = [];
  if (s.byBucket.shipped) parts.push(`${spell(s.byBucket.shipped)} shipped`);
  if (needYou) parts.push(`${spell(needYou)} ${needYou === 1 ? "needs" : "need"} you`);
  if (s.byBucket.failed) parts.push(`${spell(s.byBucket.failed)} failed`);
  if (parts.length === 0) return `${hello} The crew ran ${spell(s.total)} ${s.total === 1 ? "task" : "tasks"}.`;
  const sentence = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  return `${hello} ${capitalize(sentence ?? "")}.`;
}

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
function spell(n: number): string {
  return WORDS[n] ?? String(n);
}
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function formatCost(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const m = Math.round(ms / 60_000);
  const h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m`;
}

export function humanizeTaskId(id: string): string {
  const s = id.replace(/[-_]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
