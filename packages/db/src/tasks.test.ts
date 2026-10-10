import { describe, expect, test } from "bun:test";
import {
  addNote,
  addRepo,
  addRunEvent,
  createTask,
  getSettings,
  listNotes,
  listRunEvents,
  listTasks,
  openDb,
  reorderTasks,
  schema,
  updateSettings,
  updateTask,
} from "./index";

function setup() {
  const db = openDb(":memory:");
  const repo = addRepo(db, {
    name: "acme",
    path: "/code/acme",
    defaultBranch: "main",
    protectedBranches: ["production"],
  });
  return { db, repo };
}

describe("repos", () => {
  test("adding the same path twice returns the existing repo", () => {
    const { db, repo } = setup();
    expect(addRepo(db, { name: "x", path: "/code/acme", defaultBranch: "main" }).id).toBe(repo.id);
  });
  test("the default branch and main/master are always protected", () => {
    const { repo } = setup();
    expect(repo.protectedBranches).toEqual(expect.arrayContaining(["main", "master", "production"]));
  });
});

describe("tasks", () => {
  test("create, queue at the end of the list, reorder", () => {
    const { db, repo } = setup();
    const a = createTask(db, { repoId: repo.id, title: "Add pagination", status: "queued" });
    const b = createTask(db, { repoId: repo.id, title: "Fix login race", type: "bugfix", status: "queued" });
    expect(b.branch).toBe("fix/fix-login-race");
    expect(listTasks(db, ["queued"]).map((t) => t.id)).toEqual([a.id, b.id]);
    reorderTasks(db, [b.id, a.id]);
    expect(listTasks(db, ["queued"]).map((t) => t.id)).toEqual([b.id, a.id]);
    const c = createTask(db, { repoId: repo.id, title: "Later thing", status: "later" });
    updateTask(db, c.id, { status: "queued" });
    expect(listTasks(db, ["queued"]).at(-1)?.id).toBe(c.id);
  });
  test("branch names stay unique per repo", () => {
    const { db, repo } = setup();
    const a = createTask(db, { repoId: repo.id, title: "Dark mode" });
    const b = createTask(db, { repoId: repo.id, title: "Dark mode" });
    expect(a.branch).toBe("crew/dark-mode");
    expect(b.branch).toBe("crew/dark-mode-2");
  });
  test("json fields round-trip and the repo name is joined in", () => {
    const { db, repo } = setup();
    const t = createTask(db, { repoId: repo.id, title: "T", scope: ["src/**"], criteria: ["works"], dependsOn: ["x"] });
    expect(t.scope).toEqual(["src/**"]);
    expect(t.criteria).toEqual(["works"]);
    expect(t.dependsOn).toEqual(["x"]);
    expect(t.repoName).toBe("acme");
  });
});

test("notes and run events", () => {
  const { db, repo } = setup();
  const t = createTask(db, { repoId: repo.id, title: "T" });
  addNote(db, t.id, "you", "use the helper");
  expect(listNotes(db, t.id).map((n) => n.body)).toEqual(["use the helper"]);
  const e1 = addRunEvent(db, { runId: "r", phase: "plan", kind: "phase", text: "Planning", data: null });
  addRunEvent(db, { runId: "r", phase: "plan", kind: "tool", text: "Read src/a.ts", data: { tool: "Read" } });
  expect(listRunEvents(db, "r", e1.id).map((e) => e.text)).toEqual(["Read src/a.ts"]);
});

test("settings merge over defaults", () => {
  const { db } = setup();
  expect(getSettings(db).maxAgents).toBe(3);
  expect(getSettings(db).maxPerRepo).toBe(1);
  expect(updateSettings(db, { scheduleAt: "23:30", dailyTokenBudget: 5_000_000 }).scheduleAt).toBe("23:30");
  expect(getSettings(db).dailyTokenBudget).toBe(5_000_000);
});

test("night-era settings carry over", () => {
  const { db } = setup();
  db.insert(schema.settings).values({ key: "startAt", value: "21:00" }).run();
  expect(getSettings(db).scheduleAt).toBe("21:00");
});
