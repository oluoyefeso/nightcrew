import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findClassicRoot, humanizeReason, importClassic } from "./classic";

let root: string;

function session(id: string, tasks: Record<string, unknown>, logs: Record<string, string> = {}) {
  const dir = join(root, "state", "sessions", id);
  mkdirSync(join(dir, "logs"), { recursive: true });
  writeFileSync(join(dir, "progress.json"), JSON.stringify({ tasks }));
  for (const [name, body] of Object.entries(logs)) writeFileSync(join(dir, "logs", name), body);
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nc-classic-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("importClassic", () => {
  test("dedupes attempts copied forward across sessions and keeps retries", () => {
    const s1 = session(
      "2026-04-17T111503Z",
      { lockfile: { status: "complete", started_at: "2026-04-17T11:31:41Z", cost_cents: "153" } },
      { "lockfile-impl.log": "Tests pass. Implementation complete.\n" },
    );
    session("2026-04-17T124914Z", {
      lockfile: {
        status: "complete",
        started_at: "2026-04-17T11:31:41Z",
        cost_cents: "153",
        log_file: join(s1, "logs", "lockfile-impl.log"),
      },
      branches: {
        status: "failed",
        started_at: "2026-04-17T13:33:00Z",
        reason: '{"type":"result","is_error":true,"api_error_status":429}',
      },
    });
    session("2026-04-17T143100Z", {
      branches: {
        status: "complete",
        started_at: "2026-04-17T14:31:00Z",
        reason: '{"type":"result","is_error":true,"api_error_status":429}',
        pr_url: "https://github.com/o/r/pull/13",
      },
    });
    writeFileSync(join(root, "PLAN-branches.md"), "# Plan\n");
    writeFileSync(join(root, "tasks.yaml"), "tasks:\n  - id: branches\n    title: Per-project branches\n");

    const runs = importClassic(root);
    expect(runs).toHaveLength(3);
    const lock = runs.find((r) => r.run.taskId === "lockfile");
    expect(lock?.run.sessionId).toBe("2026-04-17T111503Z");
    expect(lock?.run.summary).toBe("Tests pass. Implementation complete.");
    expect(lock?.run.costCents).toBe(153);

    const attempts = runs.filter((r) => r.run.taskId === "branches");
    expect(attempts.map((a) => a.run.status)).toEqual(["failed", "complete"]);
    expect(attempts[0]?.run.reason).toBe("Rate limited by the API (429).");
    // a successful retry doesn't inherit the old failure reason
    expect(attempts[1]?.run.reason).toBeNull();
    expect(attempts[1]?.run.title).toBe("Per-project branches");
    expect(attempts[1]?.run.prNumber).toBe(13);
    expect(attempts[1]?.artifacts.map((a) => a.kind)).toContain("plan");
  });

  test("ignores non-timestamp session folders", () => {
    session("demo-baseline", { x: { status: "complete", started_at: "2026-04-17T11:00:00Z" } });
    expect(importClassic(root)).toHaveLength(0);
  });

  test("findClassicRoot looks in the folder, classic/ and the parent", () => {
    mkdirSync(join(root, "classic", "state", "sessions"), { recursive: true });
    expect(findClassicRoot(root)).toBe(join(root, "classic"));
  });
});

describe("humanizeReason", () => {
  test("turns raw CLI JSON into a sentence", () => {
    expect(humanizeReason('{"api_error_status":500}')).toBe("API error 500.");
    expect(humanizeReason('{"is_error":true}')).toBe("The agent exited with an error.");
    expect(humanizeReason("validation failed")).toBe("Validation failed after the run.");
    expect(humanizeReason(undefined)).toBeNull();
  });
});
