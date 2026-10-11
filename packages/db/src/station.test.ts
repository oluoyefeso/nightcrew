import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  addRepo,
  createTask,
  type Db,
  getStation,
  openDb,
  type RunRow,
  recordTriage,
  updateTask,
  upsertRuns,
} from "./index";

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});
afterEach(() => db.$client.close());

function add(over: Partial<RunRow> & { id: string }) {
  upsertRuns(db, [
    {
      run: {
        nightId: "2026-04-16",
        sessionId: "session",
        taskId: over.id,
        title: over.id,
        repo: "example",
        status: "complete",
        source: "classic",
        startedAt: "2026-04-16T12:00:00Z",
        prUrl: "https://github.com/example/project/pull/1",
        prState: "draft",
        verdict: "ready",
        ...over,
      },
      artifacts: [],
    },
  ]);
}

describe("Station decisions", () => {
  test("older unresolved decisions survive new report days; only the newest attempt needs review", () => {
    add({ id: "older", taskId: "same", status: "failed" });
    add({ id: "still-waiting" });
    add({ id: "newer", taskId: "same", nightId: "2026-04-17", startedAt: "2026-04-17T12:00:00Z" });
    add({ id: "merged", prState: "merged", nightId: "2026-04-18", startedAt: "2026-04-18T12:00:00Z" });
    const station = getStation(db);
    expect(station.decisions.map((r) => r.id)).toEqual(["still-waiting", "newer"]);
    expect(station.recent.map((r) => r.id)).toEqual(["merged"]);
    expect(station.latestNightId).toBe("2026-04-18");
  });

  test("same task names in different repos remain separate, including equal timestamps", () => {
    add({ id: "one-old", taskId: "fix", repo: "one" });
    add({ id: "one-new", taskId: "fix", repo: "one" });
    add({ id: "two", taskId: "fix", repo: "two" });
    expect(
      getStation(db)
        .decisions.map((r) => r.id)
        .sort(),
    ).toEqual(["one-new", "two"]);
  });

  test("dismissed failures and closed PRs leave decisions; undo restores a dismissed failure", () => {
    add({ id: "failed", status: "failed", reason: "Checks failed." });
    add({ id: "closed", prState: "closed" });
    expect(getStation(db).decisions.map((r) => r.id)).toEqual(["failed"]);
    recordTriage(db, "failed", "close", null);
    expect(getStation(db).decisions).toHaveLength(0);
    expect(getStation(db).recent).toHaveLength(2);
    recordTriage(db, "failed", "undo", null);
    expect(getStation(db).decisions.map((r) => r.id)).toEqual(["failed"]);
  });

  test("queued repairs and active reruns do not retain stale decisions", () => {
    const repo = addRepo(db, { name: "example", path: "/example/project", defaultBranch: "main" });
    const task = createTask(db, { repoId: repo.id, title: "Fix", status: "done" });
    add({ id: "run", taskId: task.id, source: "local", status: "failed" });
    expect(getStation(db).decisions).toHaveLength(1);
    updateTask(db, task.id, { status: "queued" });
    expect(getStation(db).decisions).toHaveLength(0);
    updateTask(db, task.id, { status: "running" });
    expect(getStation(db).decisions).toHaveLength(0);
    updateTask(db, task.id, { status: "archived" });
    expect(getStation(db).decisions).toHaveLength(0);
    expect(getStation(db).recent).toHaveLength(1);
  });

  test("limits the outcome digest without truncating pending decisions", () => {
    for (let i = 0; i < 18; i++) {
      add({ id: `pending-${i}` });
      add({ id: `done-${i}`, prState: "merged" });
    }
    expect(getStation(db).decisions).toHaveLength(18);
    expect(getStation(db).recent).toHaveLength(12);
  });
});
