import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  addRepo,
  createTask,
  type Db,
  getConductor,
  getMission,
  getSettings,
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

test("goal planning reads only the selected project and rejects invalid project scope before model use", async () => {
  const excluded = addRepo(db, { name: "Excluded project", path: "/demo/excluded", defaultBranch: "main" });
  const selected = addRepo(db, { name: "Selected project", path: "/demo/selected", defaultBranch: "main" });
  const mission = await create();
  const response = await send("POST", "/api/compose", {
    text: "Make invitations reliable",
    missionId: mission.id,
    repoId: selected.id,
    repoIds: [selected.id],
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    fallback: true,
    drafts: [{ repoId: selected.id, missionId: mission.id }],
  });
  expect(engine.calls[0]?.cwd).toBe("/demo/selected");
  expect(engine.calls[0]?.prompt).toContain("### Selected project");
  expect(engine.calls[0]?.prompt).not.toContain("### Excluded project");
  const calls = engine.calls.length;
  for (const repoIds of [[], null, "all", ["missing"], [selected.id, 7], [excluded.id]]) {
    expect((await send("POST", "/api/compose", { text: "Plan work", repoId: selected.id, repoIds })).status).toBe(400);
  }
  expect(engine.calls).toHaveLength(calls);
  expect(listTasks(db)).toHaveLength(0);
});

test("mission API enforces authentication, validates changes and preserves tasks on deletion", async () => {
  expect((await app.request("/api/missions")).status).toBe(401);
  for (const value of [null, [], { title: "Empty objective" }, { title: "A", objective: "B", paused: "yes" }])
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

test("starting a goal is atomic, scoped and authenticated, and never resumes a paused crew", async () => {
  const repo = addRepo(db, { name: "Fixture", path: "/demo/project", defaultBranch: "main" });
  for (const conductor of [null, {}, { repoId: "missing" }, { repoId: repo.id, authority: "ship" }])
    expect(
      (await send("POST", "/api/missions", { title: "Goal", objective: "Do the requested work", conductor })).status,
    ).toBe(400);
  expect(await (await send("GET", "/api/missions")).json()).toEqual([]);
  const response = await send("POST", "/api/missions", {
    title: "Goal",
    objective: "Do the requested work",
    paused: true,
    conductor: { repoId: repo.id },
  });
  expect(response.status).toBe(201);
  const mission = (await response.json()) as { id: string; paused: boolean; criteria: string[] };
  expect(mission.paused).toBe(false);
  expect(mission.criteria).toEqual(["Do the requested work"]);
  expect(getConductor(db, mission.id)?.repoId).toBe(repo.id);
  expect(getSettings(db).dispatch).toBe(false);
  expect(engine.calls).toHaveLength(0);
  expect((await app.request(`/api/missions/${mission.id}/conductor`, { method: "POST" })).status).toBe(401);
  expect((await send("POST", `/api/missions/${mission.id}/conductor`, { repoId: "missing" })).status).toBe(409);
  expect((await send("GET", `/api/missions/${mission.id}/conductor`)).status).toBe(200);
  expect((await send("DELETE", `/api/missions/${mission.id}/conductor`)).status).toBe(200);
  expect(getMission(db, mission.id)?.paused).toBe(true);
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

test("mission creation saves all planning controls together and rejects invalid plans atomically", async () => {
  const plan = {
    title: "Planned work",
    objective: "Deliver the complete flow",
    criteria: ["Invitations work", "Duplicates are clear"],
    paused: true,
    tokenBudget: 150000,
    priority: 2,
    deadline: "2027-01-20T18:00:00+01:00",
    stopAt: "2027-01-20T20:00:00+01:00",
  };
  const response = await send("POST", "/api/missions", plan);
  expect(response.status).toBe(201);
  const mission = (await response.json()) as { id: string };
  expect(getMission(db, mission.id)).toMatchObject({
    ...plan,
    deadline: "2027-01-20T17:00:00.000Z",
    stopAt: "2027-01-20T19:00:00.000Z",
  });
  const before = ((await (await send("GET", "/api/missions")).json()) as unknown[]).length;
  for (const patch of [
    { criteria: ["Repeated", "Repeated"] },
    { priority: 4 },
    { tokenBudget: 1 },
    { deadline: "tomorrow" },
  ])
    expect((await send("POST", "/api/missions", { ...plan, ...patch })).status).toBe(400);
  expect(((await (await send("GET", "/api/missions")).json()) as unknown[]).length).toBe(before);
});

test("criterion links belong to the current mission, validate whole batches, and clear when work moves", async () => {
  const mission = await create();
  await send("PATCH", `/api/missions/${mission.id}`, { criteria: ["Invitations work", "Duplicates are clear"] });
  const repo = addRepo(db, { name: "Fixture", path: "/demo/repo", defaultBranch: "main" });
  const base = { repoId: repo.id, title: "Invitation form", missionId: mission.id, status: "later" };
  expect(
    (
      await send("POST", "/api/tasks/batch", {
        when: "later",
        tasks: [
          { ...base, missionCriteria: ["Invitations work"] },
          { ...base, missionCriteria: ["Unknown"] },
        ],
      })
    ).status,
  ).toBe(400);
  expect(listTasks(db)).toHaveLength(0);
  const response = await send("POST", "/api/tasks", { ...base, missionCriteria: ["Invitations work"] });
  expect(response.status).toBe(201);
  const task = (await response.json()) as { id: string };
  expect(getTask(db, task.id)?.missionCriteria).toEqual(["Invitations work"]);
  expect(
    (await send("PATCH", `/api/tasks/${task.id}`, { missionCriteria: ["Invitations work", "Invitations work"] }))
      .status,
  ).toBe(400);
  await send("PATCH", `/api/missions/${mission.id}`, { criteria: ["New outcome"] });
  expect(getTask(db, task.id)?.missionCriteria).toEqual(["Invitations work"]); // Preserve stale intent for review.
  expect((await send("PATCH", `/api/tasks/${task.id}`, { missionCriteria: ["Invitations work"] })).status).toBe(400);
  expect((await send("PATCH", `/api/tasks/${task.id}`, { missionCriteria: ["New outcome"] })).status).toBe(200);
  expect((await send("PATCH", `/api/tasks/${task.id}`, { missionId: null })).status).toBe(200);
  expect(getTask(db, task.id)?.missionCriteria).toEqual([]);
  expect((await send("PATCH", `/api/tasks/${task.id}`, { missionCriteria: ["New outcome"] })).status).toBe(400);
});

test("composer links only current mission criteria and preserves unlinked work for review", async () => {
  const mission = await create();
  await send("PATCH", `/api/missions/${mission.id}`, { criteria: ["Invitations work", "Duplicates are clear"] });
  const repo = addRepo(db, { name: "Fixture", path: "/demo/repo", defaultBranch: "main" });
  engine.runPhase = async (req) => {
    engine.calls.push(req);
    return {
      ok: true,
      text: "",
      structured: {
        tasks: [
          {
            repo: "Fixture",
            title: "Build invitations",
            type: "implementation",
            brief: "Build the flow",
            scope: [],
            criteria: ["Form works"],
            missionCriteria: ["Invitations work", "Invitations work", "Invented outcome"],
            question: null,
            dependsOn: [],
          },
        ],
      },
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      turns: 1,
      error: null,
      rateLimited: false,
    };
  };
  const response = await send("POST", "/api/compose", {
    text: "Build invitations",
    repoId: repo.id,
    missionId: mission.id,
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    drafts: [{ missionId: mission.id, missionCriteria: ["Invitations work"] }],
  });
  expect(engine.calls[0]?.prompt).toContain("Link each task to the exact mission criteria");
  expect(listTasks(db)).toHaveLength(0);
});

test("mission stop edits require a timezone, reject invalid changes atomically and can be cleared", async () => {
  const mission = await create();
  expect(getMission(db, mission.id)?.stopAt).toBeNull();
  for (const stopAt of ["tomorrow", "2027-01-20T18:00", "2027-13-20T18:00:00Z", "", 42]) {
    expect((await send("PATCH", `/api/missions/${mission.id}`, { stopAt, paused: true })).status).toBe(400);
    expect(getMission(db, mission.id)).toMatchObject({ stopAt: null, paused: false });
  }
  expect((await send("PATCH", `/api/missions/${mission.id}`, { stopAt: "2027-01-20T20:00:00+01:00" })).status).toBe(
    200,
  );
  expect(getMission(db, mission.id)?.stopAt).toBe("2027-01-20T19:00:00.000Z");
  expect((await send("PATCH", `/api/missions/${mission.id}`, { stopAt: null })).status).toBe(200);
  expect(getMission(db, mission.id)?.stopAt).toBeNull();
});
