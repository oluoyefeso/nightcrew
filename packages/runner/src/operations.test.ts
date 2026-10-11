import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DELIVERY, type Repo, validateDelivery } from "@nightcrew/core";
import {
  addRepo,
  createMission,
  createTask,
  type Db,
  getDelivery,
  getOperationJob,
  getTask,
  listDeliveries,
  listOperationJobs,
  openDb,
  recoverDeliveries,
  saveDelivery,
  updateMission,
  updateRepo,
  updateTask,
  upsertRuns,
} from "@nightcrew/db";
import { git, resolveSha, withRepoLock } from "./git";
import {
  acceptMission,
  advanceDelivery,
  automaticDelivery,
  missionReadiness,
  redactOperationLog,
  startDelivery,
  startMissionAcceptance,
  stopOperation,
  stopOperations,
} from "./operations";
import { taskRef } from "./workspace";

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
const policy = () => ({
  ...DEFAULT_DELIVERY,
  branch: "main",
  check: "test -f feature.txt",
  deploy: 'test -n "$NC_COMMIT"',
  release: 'test "$NC_STAGE" = release',
});

test("delivery requires ordered verification of the same commit and unchanged policy", async () => {
  updateRepo(db, repo.id, { delivery: policy() });
  await expect(advanceDelivery(db, repo.id, "deploy", dir)).rejects.toThrow("preceding");
  const checked = await advanceDelivery(db, repo.id, "check", dir);
  expect(checked.status).toBe("passed");
  const deployed = await advanceDelivery(db, repo.id, "deploy", dir, checked.id);
  expect(deployed.status).toBe("passed");
  const released = await advanceDelivery(db, repo.id, "release", dir, deployed.id);
  expect(released.status).toBe("passed");
  await expect(advanceDelivery(db, repo.id, "deploy", dir, checked.id)).rejects.toThrow("already attempted");
  expect((await git(repo.path, "status", "--porcelain")).stdout).toBe("");
  expect(listDeliveries(db, repo.id)).toHaveLength(3);
});

test("changing delivery settings while waiting for the repo lock prevents the action", async () => {
  updateRepo(db, repo.id, { delivery: policy() });
  const checked = await advanceDelivery(db, repo.id, "check", dir);
  let release!: () => void;
  const held = withRepoLock(
    repo.path,
    () =>
      new Promise<void>((r) => {
        release = r;
      }),
  );
  await Bun.sleep(10);
  const pending = advanceDelivery(db, repo.id, "deploy", dir, checked.id);
  await Bun.sleep(40);
  updateRepo(db, repo.id, { delivery: { ...policy(), automatic: "check" } });
  release();
  await held;
  const result = await pending;
  expect(result.status).toBe("failed");
  expect(result.log).toContain("changed before");
});

test("source mutation and nonzero checks hold delivery; interrupted actions are never replayed automatically", async () => {
  updateRepo(db, repo.id, { delivery: { ...policy(), check: "echo changed > feature.txt", automatic: "release" } });
  await automaticDelivery(db, repo.id, dir);
  expect(listDeliveries(db)[0]?.status).toBe("failed");
  await automaticDelivery(db, repo.id, dir);
  expect(listDeliveries(db)).toHaveLength(1);
  const row = listDeliveries(db)[0]!;
  saveDelivery(db, { ...row, status: "running" });
  recoverDeliveries(db);
  expect(getDelivery(db, row.id)?.status).toBe("interrupted");
  await automaticDelivery(db, repo.id, dir);
  expect(listDeliveries(db)).toHaveLength(1);
});

test("delivery credentials are explicit, absent from checks and redacted from recorded output", async () => {
  process.env.DEMO_DELIVERY_SECRET = "synthetic-credential-for-test";
  try {
    updateRepo(db, repo.id, {
      delivery: {
        ...policy(),
        environment: ["DEMO_DELIVERY_SECRET"],
        check: 'test -z "$DEMO_DELIVERY_SECRET"',
        deploy: "printf '%s' \"$DEMO_DELIVERY_SECRET\"",
      },
    });
    const check = await advanceDelivery(db, repo.id, "check", dir);
    expect(check.status).toBe("passed");
    const deployed = await advanceDelivery(db, repo.id, "deploy", dir, check.id);
    expect(deployed.log).toContain("[redacted]");
    expect(JSON.stringify(listDeliveries(db))).not.toContain(process.env.DEMO_DELIVERY_SECRET);
  } finally {
    delete process.env.DEMO_DELIVERY_SECRET;
  }
  expect(redactOperationLog("Authorization: Bearer synthetic-test-token")).not.toContain("synthetic-test-token");
  expect(validateDelivery({ ...policy(), environment: ["PATH"] })).toContain("reserved");
});

async function readyMission() {
  const mission = createMission(db, { title: "Feature", objective: "Deliver the complete feature." });
  updateMission(db, mission.id, { criteria: ["Feature works"] });
  const task = createTask(db, { title: "Build feature", repoId: repo.id, missionId: mission.id, status: "done" });
  const sha = (await resolveSha(repo.path, "HEAD"))!;
  await git(repo.path, "update-ref", taskRef(task.id), sha);
  upsertRuns(db, [
    {
      run: {
        id: "run_fixture",
        nightId: "2026-10-11",
        sessionId: "session_fixture",
        taskId: task.id,
        title: task.title,
        repo: repo.name,
        status: "complete",
        source: "local",
        verdict: "ready",
      },
      artifacts: [{ kind: "tests", name: "Checks", content: "Passed" }],
    },
  ]);
  updateTask(db, task.id, { lastRunId: "run_fixture" });
  return { mission, task };
}

test("mission acceptance needs exact criteria evidence and combined checks, and expires when intent changes", async () => {
  const { mission } = await readyMission();
  const before = await missionReadiness(db, mission.id);
  expect(before.blockers).toEqual([]);
  expect(before.accepted).toBe(false);
  await expect(acceptMission(db, mission.id, before.fingerprint, [], dir)).rejects.toThrow("every mission criterion");
  const result = await acceptMission(
    db,
    mission.id,
    before.fingerprint,
    [{ criterion: "Feature works", evidence: "Verified the fixture behavior." }],
    dir,
  );
  expect(result.status).toBe("passed");
  expect((await missionReadiness(db, mission.id)).accepted).toBe(true);
  updateMission(db, mission.id, { objective: "A changed objective." });
  expect((await missionReadiness(db, mission.id)).accepted).toBe(false);
  await expect(acceptMission(db, mission.id, before.fingerprint, [], dir)).rejects.toThrow("changed");
});

test("mission acceptance fails on combined tests and unfinished work cannot be accepted", async () => {
  const { mission, task } = await readyMission();
  updateRepo(db, repo.id, { testCommand: "false" });
  const before = await missionReadiness(db, mission.id);
  const result = await acceptMission(
    db,
    mission.id,
    before.fingerprint,
    [{ criterion: "Feature works", evidence: "Needs checking." }],
    dir,
  );
  expect(result.status).toBe("failed");
  updateTask(db, task.id, { status: "queued" });
  expect((await missionReadiness(db, mission.id)).blockers.join(" ")).toContain("Resolve Build feature");
  expect(getTask(db, task.id)?.status).toBe("queued");
});

test("automatic authority stops at checks and a new commit cannot reuse earlier verification", async () => {
  updateRepo(db, repo.id, { delivery: { ...policy(), automatic: "check" } });
  await automaticDelivery(db, repo.id, dir);
  await automaticDelivery(db, repo.id, dir);
  expect(listDeliveries(db).map((d) => d.stage)).toEqual(["check"]);
  const checked = listDeliveries(db)[0]!;
  writeFileSync(join(repo.path, "feature.txt"), "new revision\n");
  await git(repo.path, "add", ".");
  await git(
    repo.path,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "new revision",
  );
  await expect(advanceDelivery(db, repo.id, "deploy", dir, checked.id)).rejects.toThrow("preceding");
});

test("a stopped delivery is interrupted and cannot silently continue", async () => {
  updateRepo(db, repo.id, { delivery: { ...policy(), check: "sleep 30" } });
  const pending = advanceDelivery(db, repo.id, "check", dir);
  await Bun.sleep(100);
  stopOperations(db);
  const result = await pending;
  expect(result.status).toBe("interrupted");
  await automaticDelivery(db, repo.id, dir);
  expect(listDeliveries(db)).toHaveLength(1);
});

test("delivery verification binds setup and successful actions remain protected beyond the dashboard window", async () => {
  updateRepo(db, repo.id, { delivery: policy() });
  const checked = await advanceDelivery(db, repo.id, "check", dir);
  updateRepo(db, repo.id, { setupCommand: "true" });
  await expect(advanceDelivery(db, repo.id, "deploy", dir, checked.id)).rejects.toThrow("preceding");
  updateRepo(db, repo.id, { setupCommand: null });
  const deployed = await advanceDelivery(db, repo.id, "deploy", dir, checked.id);
  for (let i = 0; i < 105; i++)
    saveDelivery(db, { ...deployed, id: `history_${i}`, sha: "other", createdAt: "2099-01-01T00:00:00Z" });
  await expect(advanceDelivery(db, repo.id, "deploy", dir, checked.id)).rejects.toThrow("already attempted");
});

async function waitForJob(id: string, predicate: (row: NonNullable<ReturnType<typeof getOperationJob>>) => boolean) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const row = getOperationJob(db, id)!;
    if (predicate(row)) return row;
    await Bun.sleep(10);
  }
  throw new Error("Operation did not reach the expected state.");
}

test("background jobs persist progress, reject duplicate starts and can stop one repository wait without stopping another job", async () => {
  const { mission } = await readyMission();
  const before = await missionReadiness(db, mission.id);
  updateRepo(db, repo.id, { delivery: policy() });
  // Delivery configuration changes the acceptance target, so take its current snapshot.
  const fingerprint = (await missionReadiness(db, mission.id)).fingerprint;
  let release!: () => void;
  const held = withRepoLock(
    repo.path,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await Bun.sleep(10);
  const delivery = await startDelivery(db, repo.id, "check", dir);
  const acceptance = await startMissionAcceptance(
    db,
    mission.id,
    fingerprint,
    [{ criterion: "Feature works", evidence: "Checked the fixture." }],
    dir,
  );
  try {
    await waitForJob(delivery.id, (j) => j.phase === "waiting");
    await waitForJob(acceptance.id, (j) => j.phase === "waiting");
    await expect(startDelivery(db, repo.id, "check", dir)).rejects.toThrow("already running");
    await expect(startMissionAcceptance(db, mission.id, fingerprint, [], dir)).rejects.toThrow(
      "already being verified",
    );
    expect(stopOperation(db, delivery.id)).toBe(true);
    const stopped = await waitForJob(delivery.id, (j) => j.status === "interrupted");
    expect(stopped.resultId).not.toBeNull();
    expect(getDelivery(db, stopped.resultId!)?.status).toBe("interrupted");
    expect(getOperationJob(db, acceptance.id)?.status).toBe("running");
    expect(stopOperation(db, delivery.id)).toBe(false);
    expect(listOperationJobs(db)).toHaveLength(2);
  } finally {
    release();
    await held;
  }
  expect((await waitForJob(acceptance.id, (j) => j.phase === "finished")).status).toBe("passed");
  expect((await missionReadiness(db, mission.id)).operation?.id).toBe(acceptance.id);
  expect(before.blockers).toEqual([]);
});

test("background commands expose their phase, clean up after a stop, and keep scripts and credentials out of progress", async () => {
  process.env.DEMO_JOB_SECRET = "synthetic-job-credential";
  try {
    updateRepo(db, repo.id, { delivery: { ...policy(), check: "sleep 30", environment: ["DEMO_JOB_SECRET"] } });
    const job = await startDelivery(db, repo.id, "check", dir);
    await waitForJob(job.id, (j) => j.phase === "command");
    expect(stopOperation(db, job.id)).toBe(true);
    expect(getOperationJob(db, job.id)?.status).toBe("stopping");
    const finished = await waitForJob(job.id, (j) => j.status === "interrupted");
    expect(finished.phase).toBe("finished");
    expect((await git(repo.path, "worktree", "list", "--porcelain")).stdout.match(/^worktree /gm)).toHaveLength(1);
    expect(JSON.stringify(listOperationJobs(db))).not.toContain("sleep 30");
    expect(JSON.stringify(listOperationJobs(db))).not.toContain(process.env.DEMO_JOB_SECRET);
  } finally {
    delete process.env.DEMO_JOB_SECRET;
  }
});

test("background validation failures are recorded instead of disappearing with the request", async () => {
  const job = await startDelivery(db, repo.id, "check", dir);
  const failed = await waitForJob(job.id, (j) => j.phase === "finished");
  expect(failed.status).toBe("failed");
  expect(failed.detail).toContain("Configure the delivery branch");
  expect(failed.resultId).toBeNull();
});

test("stopping a research-only acceptance cannot record a pass", async () => {
  const { mission, task } = await readyMission();
  updateTask(db, task.id, { type: "research" });
  const before = await missionReadiness(db, mission.id);
  const job = await startMissionAcceptance(
    db,
    mission.id,
    before.fingerprint,
    [{ criterion: "Feature works", evidence: "Reviewed the research." }],
    dir,
  );
  expect(stopOperation(db, job.id)).toBe(true);
  expect((await waitForJob(job.id, (j) => j.phase === "finished")).status).toBe("interrupted");
  expect((await missionReadiness(db, mission.id)).accepted).toBe(false);
});
