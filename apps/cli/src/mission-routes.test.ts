import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  addRepo,
  createTask,
  type Db,
  getMission,
  getTask,
  listTasks,
  openDb,
  updateSettings,
  updateTask,
} from "@nightcrew/db";
import { Crew, ScriptedEngine } from "@nightcrew/runner";
import { createApp } from "./server";

let db: Db;
let app: ReturnType<typeof createApp>;
let engine: ScriptedEngine;
const token = "mission-test-key";
beforeEach(() => {
  db = openDb(":memory:");
  updateSettings(db, { dispatch: false });
  engine = new ScriptedEngine({});
  const crew = new Crew({ db, engine, dataDir: "/demo/data", publish: false });
  app = createApp({ db, crew, engine, dataDir: "/demo/data", cwd: "/demo", publish: false, token });
});
afterEach(() => db.$client.close());
const send = (method: string, path: string, value?: unknown) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json", "x-nightcrew-token": token },
    ...(value !== undefined ? { body: JSON.stringify(value) } : {}),
  });
const create = async () =>
  (await (
    await send("POST", "/api/missions", { title: "Invitations", objective: "Make team invitations reliable." })
  ).json()) as { id: string };

test("composer receives mission context while fallback drafts retain the requested task and membership", async () => {
  const mission = await create();
  const repo = addRepo(db, { name: "Demo", path: "/demo/repo", defaultBranch: "main" });
  const response = await send("POST", "/api/compose", {
    text: "Add an invitation form",
    repoId: repo.id,
    missionId: mission.id,
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    fallback: true,
    drafts: [{ title: "Add an invitation form", brief: "Add an invitation form", missionId: mission.id }],
  });
  expect(engine.calls[0]?.prompt).toContain("Make team invitations reliable.");
  expect(listTasks(db)).toHaveLength(0);
});

test("mission API enforces authentication, validates changes and preserves tasks on deletion", async () => {
  expect((await app.request("/api/missions")).status).toBe(401);
  for (const value of [null, [], { title: "Empty objective" }, { title: "A", objective: "B", paused: true }])
    expect((await send("POST", "/api/missions", value)).status).toBe(400);
  const mission = await create();
  const repo = addRepo(db, { name: "Demo", path: "/demo/repo", defaultBranch: "main" });
  const task = createTask(db, { repoId: repo.id, title: "One", missionId: mission.id });
  expect((await send("PATCH", `/api/missions/${mission.id}`, { paused: "yes" })).status).toBe(400);
  expect(getMission(db, mission.id)?.paused).toBe(false);
  expect((await send("PATCH", `/api/missions/${mission.id}`, { paused: true })).status).toBe(200);
  expect(getMission(db, mission.id)?.paused).toBe(true);
  expect((await send("DELETE", `/api/missions/${mission.id}`)).status).toBe(409);
  expect(getTask(db, task.id)?.missionId).toBe(mission.id);
  expect((await send("PATCH", `/api/tasks/${task.id}`, { missionId: null })).status).toBe(200);
  expect((await send("DELETE", `/api/missions/${mission.id}`)).status).toBe(200);
});

test("membership validates whole batches and cannot change on a running task", async () => {
  const mission = await create();
  const repo = addRepo(db, { name: "Demo", path: "/demo/repo", defaultBranch: "main" });
  expect(
    (
      await send("POST", "/api/tasks/batch", {
        when: "later",
        tasks: [
          { repoId: repo.id, title: "Valid", missionId: mission.id },
          { repoId: repo.id, title: "Invalid", missionId: "missing" },
        ],
      })
    ).status,
  ).toBe(400);
  expect(listTasks(db)).toHaveLength(0);
  const task = createTask(db, { repoId: repo.id, title: "Active", status: "running", missionId: mission.id });
  expect((await send("PATCH", `/api/tasks/${task.id}`, { missionId: null })).status).toBe(409);
  updateTask(db, task.id, { status: "queued" });
  await send("PATCH", `/api/missions/${mission.id}`, { paused: true });
  const preview = (await (await send("POST", "/api/preflight", { tasks: [getTask(db, task.id)] })).json()) as {
    tasks: { signals: { code: string; missionId?: string }[] }[];
  };
  expect(
    preview.tasks[0]?.signals.some((signal) => signal.code === "mission-paused" && signal.missionId === mission.id),
  ).toBe(true);
  const response = await send("GET", `/api/missions/${mission.id}`);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const detail = (await response.json()) as { tasks: { departure: { reason: string } }[] };
  expect(detail.tasks[0]?.departure.reason).toContain("Mission paused");
});
