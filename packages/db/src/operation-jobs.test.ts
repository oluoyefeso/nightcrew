import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperationJob } from "@nightcrew/core";
import {
  addRepo,
  getOperationJob,
  getRepo,
  latestOperationJob,
  listOperationJobs,
  openDb,
  recoverOperationJobs,
  saveOperationJob,
} from "./index";

test("an existing database gains operation history without changing repository authority; restart holds unfinished work", () => {
  const dir = mkdtempSync(join(tmpdir(), "nc-progress-db-"));
  let db = openDb(join(dir, "crew.db"));
  try {
    const repo = addRepo(db, { name: "Fixture", path: "/demo/repo", defaultBranch: "main" });
    db.$client.exec("DROP TABLE operation_jobs; DELETE FROM __migrations WHERE name = '0009_operation_progress'");
    db.$client.close();
    db = openDb(join(dir, "crew.db"));
    expect(getRepo(db, repo.id)?.level).toBe("draft_pr");
    const row: OperationJob = {
      id: "running",
      kind: "mission",
      subjectId: "mission_fixture",
      stage: null,
      status: "running",
      phase: "command",
      repoId: repo.id,
      resultId: null,
      detail: "",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    saveOperationJob(db, row);
    saveOperationJob(db, { ...row, id: "stopping", subjectId: "other", status: "stopping" });
    for (let i = 0; i < 35; i++)
      saveOperationJob(db, {
        ...row,
        id: `done_${i}`,
        subjectId: "done",
        status: "passed",
        phase: "finished",
        createdAt: "2026-02-01T00:00:00Z",
      });
    // Active work must remain visible even when newer completed jobs fill the recent window.
    expect(listOperationJobs(db).filter((j) => j.status === "running" || j.status === "stopping")).toHaveLength(2);
    expect(latestOperationJob(db, "mission", "done")?.id).toBe("done_34");
    db.$client.close();
    db = openDb(join(dir, "crew.db"));
    expect(getOperationJob(db, row.id)?.status).toBe("running");
    recoverOperationJobs(db);
    expect(getOperationJob(db, row.id)).toMatchObject({ status: "interrupted", phase: "finished", resultId: null });
    expect(getOperationJob(db, "stopping")?.status).toBe("interrupted");
    expect(getOperationJob(db, "done_0")?.status).toBe("passed");
    expect(getOperationJob(db, row.id)?.detail).toContain("not replayed");
  } finally {
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
