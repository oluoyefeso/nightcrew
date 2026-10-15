export interface A11yIssue {
  id: string;
  impact: string;
  help: string;
  count: number;
}

export interface Shot {
  path: string;
  viewport: "desktop" | "mobile";
  theme: "light" | "dark";
  before: string | null;
  after: string;
  diff: string | null;
  /** Share of pixels that changed, 0–100. Null without a before shot. */
  changedPct: number | null;
}

export interface Evidence {
  required: string[];
  screenshots: Shot[];
  a11y: { before: number | null; after: number; newIssues: A11yIssue[] } | null;
  consoleErrors: string[];
  testProof: {
    testFiles: string[];
    failsOnBase: boolean | null;
    passesOnBranch: boolean;
    log: string;
    /** Why the base run proves nothing either way (setup failed, the runner couldn't start, timed out). */
    unavailable?: string;
  } | null;
  /** What was asked for but couldn't be gathered, in plain words. */
  missing: string[];
  notes: string[];
}

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const nullable = <T>(v: unknown, check: (v: unknown) => v is T): v is T | null => v === null || check(v);
const asset = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length > 0 &&
  !v.startsWith("/") &&
  !v.includes("\\") &&
  !/\p{Cc}/u.test(v) &&
  v.split("/").every((part) => part !== ".." && part !== ".");
function shot(v: unknown): v is Shot {
  return (
    record(v) &&
    typeof v.path === "string" &&
    (v.viewport === "desktop" || v.viewport === "mobile") &&
    (v.theme === "light" || v.theme === "dark") &&
    asset(v.after) &&
    nullable(v.before, asset) &&
    nullable(v.diff, asset) &&
    (v.changedPct === null ||
      (typeof v.changedPct === "number" && Number.isFinite(v.changedPct) && v.changedPct >= 0 && v.changedPct <= 100))
  );
}
function a11y(v: unknown): v is NonNullable<Evidence["a11y"]> {
  return (
    record(v) &&
    nullable(v.before, count) &&
    count(v.after) &&
    Array.isArray(v.newIssues) &&
    v.newIssues.every(
      (issue) =>
        record(issue) &&
        typeof issue.id === "string" &&
        typeof issue.impact === "string" &&
        typeof issue.help === "string" &&
        count(issue.count),
    )
  );
}
function proof(v: unknown): v is NonNullable<Evidence["testProof"]> {
  return (
    record(v) &&
    strings(v.testFiles) &&
    (v.failsOnBase === null || typeof v.failsOnBase === "boolean") &&
    typeof v.passesOnBranch === "boolean" &&
    typeof v.log === "string" &&
    (v.unavailable === undefined || typeof v.unavailable === "string")
  );
}

/** Malformed or incomplete artifacts stay unreadable; missing checks must never become passing defaults. */
export function parseEvidence(content: string): Evidence | null {
  try {
    const v: unknown = JSON.parse(content);
    if (
      !record(v) ||
      !strings(v.required) ||
      !strings(v.consoleErrors) ||
      !strings(v.missing) ||
      !strings(v.notes) ||
      !Array.isArray(v.screenshots) ||
      !v.screenshots.every(shot) ||
      !nullable(v.a11y, a11y) ||
      !nullable(v.testProof, proof)
    )
      return null;
    return v as unknown as Evidence;
  } catch {
    return null;
  }
}
