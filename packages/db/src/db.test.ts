import { describe, expect, test } from "bun:test";
import journal from "../migrations/meta/_journal.json";
import {
  addCar,
  addRepo,
  createTrain,
  getReport,
  getRun,
  listNights,
  openDb,
  type RunRow,
  recordTriage,
  setCarState,
  setRunTrain,
  upsertRuns,
} from "./index";

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

  // Value: protects=a run pulled off its train stops showing as ready to merge with the train; fails_when=hydrate classifies onTrain from trainId alone, ignoring the car state; why_new=X6, pulled cars still read as ready; seam=none
  test("a run counts as on the train only while its car is on", () => {
    const db = openDb(":memory:");
    const repo = addRepo(db, { name: "acme", path: "/code/acme", defaultBranch: "main" });
    const train = createTrain(db, { repoId: repo.id, nightId: "2026-04-16", branch: "crew/train" });
    upsertRuns(db, [{ run: row({ source: "local", prUrl: null, prNumber: null, prState: null }), artifacts: [] }]);
    setRunTrain(db, "s1:task-a", train.id);
    addCar(db, train.id, {
      runId: "s1:task-a",
      taskId: "task-a",
      title: "Task A",
      mergeSha: "a".repeat(40),
      state: "on",
    });
    expect(getRun(db, "s1:task-a")?.run.bucket).toBe("ready");
    setCarState(db, train.id, "s1:task-a", "pulled");
    expect(getRun(db, "s1:task-a")?.run.bucket).toBe("eyes");
    expect(getReport(db)?.runs[0]?.bucket).toBe("eyes");
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

  // Value: protects=a re-sync that couldn't reach GitHub keeps the PR state and title an earlier sync recorded; fails_when=upsertRuns overwrites kept fields and a merged PR falls back to draft; why_new=offline re-syncs regressed PR state; seam=none
  test("re-importing without fresh PR info keeps the stored PR state and title", () => {
    const db = openDb(":memory:");
    upsertRuns(db, [{ run: row({ title: "Task a" }), artifacts: [] }]);
    upsertRuns(db, [{ run: row({ prState: "merged", title: "Add pagination", costCents: 90 }), artifacts: [] }]);
    upsertRuns(db, [{ run: row({ title: "Task a", costCents: 120 }), artifacts: [], keep: ["prState", "title"] }]);
    const r = getRun(db, "s1:task-a")?.run;
    expect(r?.prState).toBe("merged");
    expect(r?.title).toBe("Add pagination");
    expect(r?.costCents).toBe(120);
  });
});

// Value: protects=the migrations embedded in the binary are exactly drizzle-kit's journal, in order; fails_when=a new migration is generated but not appended to MIGRATIONS (or out of order) and fresh installs miss a table or column; why_new=nothing tied the two lists together; seam=none
test("embedded migrations match the drizzle journal", () => {
  const db = openDb(":memory:");
  const applied = db.$client
    .query<{ name: string }, []>("SELECT name FROM __migrations ORDER BY rowid")
    .all()
    .map((r) => r.name);
  expect(applied).toEqual(journal.entries.map((e) => e.tag));
});
