import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addRepo,
  createMission,
  createTask,
  getMission,
  getTask,
  listMissions,
  openDb,
  recordTriage,
  updateMission,
  updateTask,
  upsertRuns,
} from "./index";

test("existing tasks migrate unassigned and mission membership and pause survive reopening", () => {
  const dir = mkdtempSync(join(tmpdir(), "nc-mission-db-"));
  let db = openDb(join(dir, "crew.db"));
  try {
    const repo = addRepo(db, { name: "Demo", path: "/demo", defaultBranch: "main" });
    const task = createTask(db, { repoId: repo.id, title: "Existing work", status: "later" });
    db.$client.exec(
      "DROP INDEX runs_mission_idx; DROP TABLE mission_acceptances; DROP TABLE checkpoints; DROP TABLE deliveries; DROP TABLE audit; DROP TABLE policy_templates; ALTER TABLE runs DROP COLUMN mission_id; ALTER TABLE repos DROP COLUMN delivery; ALTER TABLE tasks DROP COLUMN recovery_mode; ALTER TABLE tasks DROP COLUMN auto_retries; DELETE FROM __migrations WHERE name = '0008_conductor_operations'; DROP INDEX tasks_mission_idx; ALTER TABLE tasks DROP COLUMN mission_id; DROP TABLE missions; DELETE FROM __migrations WHERE name = '0007_missions'",
    );
    db.$client.close();
    db = openDb(join(dir, "crew.db"));
    expect(getTask(db, task.id)).toMatchObject({ title: "Existing work", status: "later", missionId: null });
    const mission = createMission(db, { title: "Improve onboarding", objective: "New users can invite their team." });
    updateTask(db, task.id, { missionId: mission.id });
    updateMission(db, mission.id, { paused: true });
    db.$client.close();
    db = openDb(join(dir, "crew.db"));
    expect(getMission(db, mission.id)?.paused).toBe(true);
    expect(getTask(db, task.id)?.missionId).toBe(mission.id);
    expect(listMissions(db)[0]?.counts).toMatchObject({ total: 1, parked: 1, resolved: 0 });
  } finally {
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mission totals include retries, exclude classic imports and keep failed work unresolved", () => {
  const db = openDb(":memory:");
  try {
    const repo = addRepo(db, { name: "Demo", path: "/demo", defaultBranch: "main" });
    const mission = createMission(db, { title: "Invitations", objective: "Handle duplicate invitations." });
    const task = createTask(db, { repoId: repo.id, title: "Fix invitations", missionId: mission.id, status: "done" });
    const queued = createTask(db, {
      repoId: repo.id,
      title: "Follow-up",
      missionId: mission.id,
      status: "queued",
      tokenBudget: 500_000,
    });
    for (const [id, source, tokens] of [
      ["first", "local", 100],
      ["retry", "local", 200],
      ["imported", "classic", 900],
    ] as const) {
      upsertRuns(db, [
        {
          run: {
            id,
            sessionId: id,
            nightId: "2026-10-11",
            taskId: task.id,
            title: task.title,
            repo: repo.name,
            source,
            status: "failed",
            tokensIn: tokens,
            tokensOut: 10,
          },
          artifacts: [],
        },
      ]);
    }
    updateTask(db, task.id, { lastRunId: "retry" });
    expect(listMissions(db)[0]).toMatchObject({
      tokensUsed: 320,
      taskCaps: 500_000,
      counts: { total: 2, needsYou: 1, queued: 1, resolved: 0 },
    });
    recordTriage(db, "retry", "close", null);
    expect(listMissions(db)[0]?.counts).toMatchObject({ needsYou: 0, resolved: 1 });
    updateTask(db, queued.id, { missionId: null });
    expect(listMissions(db)[0]?.taskCaps).toBe(0);
  } finally {
    db.$client.close();
  }
});

test("spent tokens stay charged to their dispatch mission after membership changes and task deletion", () => {
  const db = openDb(":memory:");
  try {
    const repo = addRepo(db, { name: "Demo", path: "/demo/ledger", defaultBranch: "main" });
    const mission = createMission(db, { title: "Ledger", objective: "Keep an accurate budget." });
    const task = createTask(db, { repoId: repo.id, title: "Spend", missionId: mission.id });
    const run = {
      id: "ledger_run",
      sessionId: "ledger_session",
      nightId: "2026-10-11",
      taskId: task.id,
      title: task.title,
      repo: repo.name,
      status: "failed",
      source: "local",
      tokensIn: 200,
      tokensOut: 50,
    };
    upsertRuns(db, [{ run: { ...run }, artifacts: [] }]);
    updateTask(db, task.id, { missionId: null });
    upsertRuns(db, [{ run: { ...run, tokensOut: 100 }, artifacts: [] }]);
    expect(listMissions(db)[0]?.tokensUsed).toBe(300);
    db.$client.query("DELETE FROM tasks WHERE id = ?").run(task.id);
    expect(listMissions(db)[0]?.tokensUsed).toBe(300);
  } finally {
    db.$client.close();
  }
});
