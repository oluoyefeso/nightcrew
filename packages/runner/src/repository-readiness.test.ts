import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Repo } from "@nightcrew/core";
import { addRepo, type Db, getOperationJob, listOperationJobs, openDb, updateRepo } from "@nightcrew/db";
import { git, withRepoLock } from "./git";
import { stopOperation } from "./operation-progress";
import { repositoryReadiness, startRepositoryVerification, verifyRepository } from "./repository-readiness";

let dir: string;
let db: Db;
let repo: Repo;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "nc-operations-"));
  const path = join(dir, "acme");
  mkdirSync(path);
  writeFileSync(join(path, "feature.txt"), "ready\n");
  await git(path, "init", "-q", "-b", "main");
  await git(path, "add", ".");
  await git(path, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "initial");
  db = openDb(":memory:");
  repo = addRepo(db, { name: "Acme", path, defaultBranch: "main", testCommand: "test -f feature.txt" });
});
afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

test("setup verification uses the committed branch and isolated installation, preserving working changes", async () => {
  updateRepo(db, repo.id, {
    setupCommand: "printf installed > dependency.txt",
    testCommand: "test -f dependency.txt && cat feature.txt",
  });
  writeFileSync(join(repo.path, "feature.txt"), "uncommitted local work\n");
  const before = await repositoryReadiness(db, repo.id);
  expect(before.blockers).toEqual([]);
  const result = await verifyRepository(db, repo.id, before.fingerprint, dir);
  expect(result.status).toBe("passed");
  expect(result.detail).toContain("ready");
  expect(result.detail).not.toContain("uncommitted local work");
  expect(readFileSync(join(repo.path, "feature.txt"), "utf8")).toBe("uncommitted local work\n");
  expect((await repositoryReadiness(db, repo.id)).verified).toBe(true);
  expect(listOperationJobs(db)[0]).toMatchObject({
    kind: "repository",
    subjectId: repo.id,
    status: "passed",
    resultId: result.id,
  });
});

test("changed commands or branch commits invalidate readiness without spending tokens or raising authority", async () => {
  const before = await repositoryReadiness(db, repo.id);
  await verifyRepository(db, repo.id, before.fingerprint, dir);
  updateRepo(db, repo.id, { testCommand: "true" });
  expect((await repositoryReadiness(db, repo.id)).verified).toBe(false);
  await expect(verifyRepository(db, repo.id, before.fingerprint, dir)).rejects.toThrow("changed");
  const current = await repositoryReadiness(db, repo.id);
  await verifyRepository(db, repo.id, current.fingerprint, dir);
  writeFileSync(join(repo.path, "feature.txt"), "new commit\n");
  await git(repo.path, "add", ".");
  await git(
    repo.path,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "new version",
  );
  expect((await repositoryReadiness(db, repo.id)).verified).toBe(false);
  expect(db.$client.query("SELECT count(*) as n FROM runs").get()).toEqual({ n: 0 });
  expect(db.$client.query("SELECT level FROM repos").get()).toEqual({ level: "draft_pr" });
});

test("setup failure shows redacted diagnostics and setup mutations cannot pass verification", async () => {
  updateRepo(db, repo.id, { setupCommand: "printf 'Authorization: Bearer synthetic-secret'; exit 1" });
  let ready = await repositoryReadiness(db, repo.id);
  const failed = await verifyRepository(db, repo.id, ready.fingerprint, dir);
  expect(failed.status).toBe("failed");
  expect(failed.detail).toContain("Repository setup failed");
  expect(failed.detail).toContain("[redacted]");
  expect(failed.detail).not.toContain("synthetic-secret");
  updateRepo(db, repo.id, { setupCommand: "echo changed > feature.txt", testCommand: "echo should-not-run" });
  ready = await repositoryReadiness(db, repo.id);
  const changed = await verifyRepository(db, repo.id, ready.fingerprint, dir);
  expect(changed.status).toBe("failed");
  expect(changed.detail).toContain("Setup changed tracked files");
  expect(changed.detail).not.toContain("should-not-run");
});

test("saved verification can be cancelled while queued, cannot start twice, and does not replay after cancellation", async () => {
  const before = await repositoryReadiness(db, repo.id);
  let release!: () => void;
  const held = withRepoLock(
    repo.path,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await Bun.sleep(10);
  const job = await startRepositoryVerification(db, repo.id, before.fingerprint, dir);
  try {
    await expect(startRepositoryVerification(db, repo.id, before.fingerprint, dir)).rejects.toThrow(
      "already being verified",
    );
    for (let i = 0; i < 100 && getOperationJob(db, job.id)?.phase !== "waiting"; i++) await Bun.sleep(10);
    expect(getOperationJob(db, job.id)?.phase).toBe("waiting");
    stopOperation(db, job.id);
    for (let i = 0; i < 100 && getOperationJob(db, job.id)?.status !== "interrupted"; i++) await Bun.sleep(10);
    const after = await repositoryReadiness(db, repo.id);
    expect(after.verified).toBe(false);
    expect(after.latest?.status).toBe("interrupted");
    expect(after.operation?.status).toBe("interrupted");
  } finally {
    release();
    await held;
  }
});

test("changed setup while waiting prevents running the old command", async () => {
  const before = await repositoryReadiness(db, repo.id);
  let release!: () => void;
  const held = withRepoLock(
    repo.path,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await Bun.sleep(10);
  const pending = verifyRepository(db, repo.id, before.fingerprint, dir);
  await Bun.sleep(40);
  updateRepo(db, repo.id, { setupCommand: "true" });
  release();
  await held;
  const result = await pending;
  expect(result.status).toBe("failed");
  expect(result.detail).toContain("changed");
});
