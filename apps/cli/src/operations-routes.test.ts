import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DELIVERY, DEFAULT_TASK_POLICY } from "@nightcrew/core";
import {
  addRepo,
  createMission,
  createTask,
  type Db,
  getMission,
  getOperationJob,
  getRepo,
  getTask,
  listAudit,
  openDb,
  updateRepo,
  updateSettings,
} from "@nightcrew/db";
import { Crew, ScriptedEngine } from "@nightcrew/runner";
import { git } from "../../../packages/runner/src/git";
import { createApp } from "./server";

let db: Db;
let dir: string;
let app: ReturnType<typeof createApp>;
const token = "operations-fixture-key";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nc-operation-api-"));
  db = openDb(":memory:");
  updateSettings(db, { dispatch: false });
  const engine = new ScriptedEngine({});
  const crew = new Crew({ db, engine, dataDir: dir, publish: false });
  app = createApp({ db, engine, crew, dataDir: dir, cwd: "/demo", publish: false, token });
});
afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});
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

test("background API returns an authenticated pollable job and stopping it is scoped and durable", async () => {
  const repoPath = join(dir, "fixture");
  mkdirSync(repoPath);
  writeFileSync(join(repoPath, "ready.txt"), "ready");
  await git(repoPath, "init", "-q", "-b", "main");
  await git(repoPath, "add", ".");
  await git(
    repoPath,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  );
  const repo = addRepo(db, { name: "Fixture", path: repoPath, defaultBranch: "main" });
  updateRepo(db, repo.id, { delivery: { ...DEFAULT_DELIVERY, branch: "main", check: "sleep 30" } });
  const response = await send("POST", `/api/repos/${repo.id}/deliver?background=1`, { stage: "check" });
  expect(response.status).toBe(202);
  const job = (await response.json()) as { id: string };
  const pollPath = `/api/operations/${job.id}`;
  expect((await app.request(pollPath)).status).toBe(401);
  expect((await app.request(`${pollPath}/stop`, { method: "POST" })).status).toBe(401);
  expect((await send("GET", pollPath)).headers.get("cache-control")).toBe("no-store");
  const state = (await (await send("GET", "/api/operations")).json()) as { jobs: { id: string }[] };
  expect(state.jobs.some((j) => j.id === job.id)).toBe(true);
  expect((await send("DELETE", `/api/repos/${repo.id}`)).status).toBe(409);
  expect((await send("POST", `/api/repos/${repo.id}/deliver?background=1`, { stage: "check" })).status).toBe(409);
  expect((await send("POST", `${pollPath}/stop`)).status).toBe(200);
  for (let i = 0; i < 200 && getOperationJob(db, job.id)?.phase !== "finished"; i++) await Bun.sleep(10);
  expect(getOperationJob(db, job.id)?.status).toBe("interrupted");
  expect((await send("POST", `${pollPath}/stop`)).status).toBe(409);
  expect((await send("GET", "/api/operations/missing")).status).toBe(404);
  expect((await send("POST", "/api/operations/missing/stop")).status).toBe(404);
  // Background execution must retain the runner's no-publish ceiling.
  expect((await send("POST", `/api/repos/${repo.id}/deliver?background=1`, { stage: "deploy" })).status).toBe(409);
});
