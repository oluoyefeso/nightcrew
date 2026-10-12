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
    db.$client.exec(
      "DROP TABLE operation_jobs; DELETE FROM __migrations WHERE name IN ('0009_operation_progress', '0012_operation_attention')",
    );
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

test("attention spans the recent window, pages ties without duplicates, filters and persists review acknowledgements", async () => {
  const { operationAttention, reviewOperation, listAudit } = await import("./index");
  const dir = mkdtempSync(join(tmpdir(), "nc-attention-db-"));
  let db = openDb(join(dir, "crew.db"));
  const row: OperationJob = {
    id: "fixture",
    kind: "delivery",
    subjectId: "repo_fixture",
    stage: "deploy",
    status: "failed",
    phase: "finished",
    repoId: "repo_fixture",
    resultId: "saved_result",
    detail: "Inspect fixture outcome.",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:01:00Z",
  };
  try {
    for (let i = 0; i < 65; i++) saveOperationJob(db, { ...row, id: `failed_${String(i).padStart(3, "0")}` });
    saveOperationJob(db, { ...row, id: "interrupted", kind: "repository", stage: null, status: "interrupted" });
    saveOperationJob(db, { ...row, id: "active", status: "running", phase: "command" });
    for (let i = 0; i < 35; i++)
      saveOperationJob(db, { ...row, id: `passed_${i}`, status: "passed", createdAt: "2026-02-01T00:00:00Z" });
    expect(listOperationJobs(db).some((job) => job.status === "failed")).toBe(false);
    const first = operationAttention(db);
    expect(first.total).toBe(66);
    expect(first.jobs).toHaveLength(30);
    const second = operationAttention(db, { before: first.nextCursor! });
    const third = operationAttention(db, { before: second.nextCursor! });
    expect(new Set([...first.jobs, ...second.jobs, ...third.jobs].map((job) => job.id)).size).toBe(66);
    expect(third.nextCursor).toBeNull();
    expect(operationAttention(db, { kind: "repository", status: "interrupted" }).total).toBe(1);
    expect(reviewOperation(db, "active", row.updatedAt)).toBeNull();
    expect(reviewOperation(db, "passed_0", row.updatedAt)).toBeNull();
    expect(reviewOperation(db, "failed_000", "stale")).toBeNull();
    const reviewed = reviewOperation(db, "failed_000", row.updatedAt)!;
    expect(reviewed.reviewedAt).toBeTruthy();
    expect(reviewed).toMatchObject({ status: "failed", resultId: row.resultId, updatedAt: row.updatedAt });
    expect(reviewOperation(db, "failed_000", row.updatedAt)?.reviewedAt).toBe(reviewed.reviewedAt);
    expect(listAudit(db).filter((entry) => entry.action === "operation.reviewed")).toHaveLength(1);
    expect(operationAttention(db).total).toBe(65);
    db.$client.close();
    db = openDb(join(dir, "crew.db"));
    expect(getOperationJob(db, "failed_000")?.reviewedAt).toBe(reviewed.reviewedAt);
    expect(operationAttention(db, { status: "failed" }).total).toBe(64);
    recoverOperationJobs(db);
    expect(operationAttention(db).total).toBe(66);
  } finally {
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
