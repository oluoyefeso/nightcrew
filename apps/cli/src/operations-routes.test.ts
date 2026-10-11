import { afterEach, beforeEach, expect, test } from "bun:test";
import { DEFAULT_DELIVERY, DEFAULT_TASK_POLICY } from "@nightcrew/core";
import {
  addRepo,
  createMission,
  createTask,
  type Db,
  getMission,
  getRepo,
  getTask,
  listAudit,
  openDb,
  updateSettings,
} from "@nightcrew/db";
import { Crew, ScriptedEngine } from "@nightcrew/runner";
import { createApp } from "./server";

let db: Db;
let app: ReturnType<typeof createApp>;
const token = "operations-fixture-key";
beforeEach(() => {
  db = openDb(":memory:");
  updateSettings(db, { dispatch: false });
  const engine = new ScriptedEngine({});
  const crew = new Crew({ db, engine, dataDir: "/demo/data", publish: false });
  app = createApp({ db, engine, crew, dataDir: "/demo/data", cwd: "/demo", publish: false, token });
});
afterEach(() => db.$client.close());
const send = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json", "x-nightcrew-token": token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

test("operations endpoints require the launch key and reject malformed controls", async () => {
  const repo = addRepo(db, { name: "Demo", path: "/demo/repo", defaultBranch: "main" });
  const task = createTask(db, { repoId: repo.id, title: "Work", status: "done" });
  for (const path of ["/api/operations", "/api/audit", "/api/policy-templates", `/api/tasks/${task.id}/recovery`])
    expect((await app.request(path)).status).toBe(401);
  expect((await send("POST", `/api/tasks/${task.id}/recover`, { mode: "verify" })).status).toBe(409);
  expect((await send("POST", `/api/tasks/${task.id}/recover`, { mode: "unknown" })).status).toBe(400);
  expect((await send("POST", `/api/tasks/${task.id}/recover`, { mode: "rebuild" })).status).toBe(200);
  expect(getTask(db, task.id)).toMatchObject({ recoveryMode: "rebuild", autoRetries: 0, status: "queued" });
  expect((await send("POST", `/api/tasks/${task.id}/recover`, { mode: "auto" })).status).toBe(409);
  expect(
    (await send("PATCH", `/api/repos/${repo.id}/delivery`, { ...DEFAULT_DELIVERY, environment: ["HOME"] })).status,
  ).toBe(400);
  expect(
    (await send("PATCH", `/api/repos/${repo.id}/delivery`, { ...DEFAULT_DELIVERY, automatic: "release" })).status,
  ).toBe(400);
  expect((await send("POST", `/api/repos/${repo.id}/deliver`, { stage: "deploy" })).status).toBe(409);
});

test("mission limits validate atomically and policy templates never promote repository authority", async () => {
  const mission = createMission(db, { title: "Objective", objective: "Complete the objective." });
  for (const patch of [
    { criteria: ["Same", "Same"] },
    { priority: 4 },
    { tokenBudget: -1 },
    { tokenBudget: 1.5 },
    { deadline: "yesterday" },
  ]) {
    expect((await send("PATCH", `/api/missions/${mission.id}`, { title: "Should not save", ...patch })).status).toBe(
      400,
    );
    expect(getMission(db, mission.id)?.title).toBe("Objective");
  }
  expect(
    (
      await send("PATCH", `/api/missions/${mission.id}`, {
        criteria: ["Works"],
        priority: 3,
        tokenBudget: 50000,
        deadline: "2027-01-01T00:00:00Z",
      })
    ).status,
  ).toBe(200);
  const repo = addRepo(db, { name: "Demo", path: "/demo/repo", defaultBranch: "main" });
  const response = await send("POST", "/api/policy-templates", {
    name: "Verified",
    policies: { implementation: { ...DEFAULT_TASK_POLICY, requireTests: true, autonomy: "ship" } },
  });
  expect(response.status).toBe(201);
  const template = (await response.json()) as { id: string };
  expect((await send("POST", `/api/repos/${repo.id}/policy-template`, { templateId: template.id })).status).toBe(200);
  expect(getRepo(db, repo.id)?.level).toBe("draft_pr");
  expect(getRepo(db, repo.id)?.policies?.implementation?.requireTests).toBe(true);
});

test("audit records changed field names rather than sensitive settings values", async () => {
  const secret = "https://hooks.slack.com/services/synthetic/test/credential";
  expect((await send("PATCH", "/api/settings", { slackWebhookUrl: secret })).status).toBe(200);
  const rows = listAudit(db);
  expect(rows.some((row) => row.detail.includes("slackWebhookUrl"))).toBe(true);
  expect(JSON.stringify(rows)).not.toContain(secret);
});
