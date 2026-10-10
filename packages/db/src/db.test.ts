import { describe, expect, test } from "bun:test";
import { getReport, getRun, listNights, openDb, type RunRow, recordTriage, upsertRuns } from "./index";

function row(over: Partial<RunRow>): RunRow {
  return {
    id: "s1:task-a",
    nightId: "2026-04-16",
    sessionId: "s1",
    taskId: "task-a",
    title: "Task A",
    repo: "nightcrew",
    status: "complete",
    source: "classic",
    startedAt: "2026-04-16T23:00:00Z",
    endedAt: "2026-04-16T23:30:00Z",
    costCents: 100,
    prUrl: "https://github.com/o/r/pull/1",
    prNumber: 1,
    prState: "draft",
    ...over,
  };
}

describe("db", () => {
  test("migrates, upserts and reports the latest attempt per task", () => {
    const db = openDb(":memory:");
    upsertRuns(db, [
      { run: row({ id: "s1:task-a", status: "failed", prUrl: null, prNumber: null, prState: null }), artifacts: [] },
      {
        run: row({ id: "s2:task-a", sessionId: "s2", startedAt: "2026-04-17T01:00:00Z" }),
        artifacts: [{ kind: "plan", name: "PLAN-task-a.md", content: "# Plan" }],
      },
      { run: row({ id: "s2:task-b", sessionId: "s2", taskId: "task-b", prState: "merged" }), artifacts: [] },
    ]);
    expect(listNights(db)).toHaveLength(1);
    const report = getReport(db);
    expect(report?.runs).toHaveLength(2);
    const a = report?.runs.find((r) => r.taskId === "task-a");
    expect(a?.id).toBe("s2:task-a");
    expect(a?.attempt).toBe(2);
    expect(a?.bucket).toBe("ready");
    expect(a?.artifactKinds).toEqual(["plan"]);
    expect(report?.runs.find((r) => r.taskId === "task-b")?.bucket).toBe("shipped");
  });

  test("triage moves a run between buckets and undo reverts it", () => {
    const db = openDb(":memory:");
    upsertRuns(db, [{ run: row({}), artifacts: [] }]);
    recordTriage(db, "s1:task-a", "send_back", "use the existing helper");
    expect(getRun(db, "s1:task-a")?.run.bucket).toBe("back");
    expect(getRun(db, "s1:task-a")?.run.note).toBe("use the existing helper");
    recordTriage(db, "s1:task-a", "undo", null);
    expect(getRun(db, "s1:task-a")?.run.bucket).toBe("ready");
    expect(getRun(db, "s1:task-a")?.run.triage).toBeNull();
    expect(getRun(db, "s1:task-a")?.run.note).toBeNull();
  });

  test("re-importing keeps triage decisions", () => {
    const db = openDb(":memory:");
    upsertRuns(db, [{ run: row({}), artifacts: [] }]);
    recordTriage(db, "s1:task-a", "close", null);
    upsertRuns(db, [{ run: row({ costCents: 120 }), artifacts: [] }]);
    const r = getRun(db, "s1:task-a")?.run;
    expect(r?.costCents).toBe(120);
    expect(r?.bucket).toBe("failed");
  });
});
