import { beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addRepo, type Db, getSettings, listTasks, openDb } from "@nightcrew/db";
import { Crew, ScriptedEngine } from "@nightcrew/runner";
import { createApp } from "./server";

let db: Db;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = openDb(":memory:");
  const engine = new ScriptedEngine({});
  const dataDir = join(tmpdir(), "nc-server");
  const crew = new Crew({ db, engine, dataDir, publish: false });
  app = createApp({ db, cwd: dataDir, crew, engine, dataDir, publish: false });
});

const error = async (res: Response) => ((await res.json()) as { error: string }).error;

describe("local API guard", () => {
  // Value: protects=a website can't create tasks with a CORS-simple text/plain POST; fails_when=the Origin or content-type check is dropped from the /api middleware; why_new=the API had no CSRF guard; seam=none
  test("a cross-site text/plain POST is refused and creates nothing", async () => {
    const repo = addRepo(db, { name: "acme", path: "/code/acme", defaultBranch: "main" });
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "text/plain" },
      body: JSON.stringify({ repoId: repo.id, title: "pwn" }),
    });
    expect(res.status).toBe(403);
    expect(listTasks(db)).toHaveLength(0);

    // Same body without an Origin still fails on content-type.
    const plain = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ repoId: repo.id, title: "pwn" }),
    });
    expect(plain.status).toBe(415);
    expect(listTasks(db)).toHaveLength(0);
  });

  // Value: protects=a DNS-rebound page can't read the API under a foreign Host; fails_when=the Host check is removed or loosened; why_new=Host was never checked; seam=none
  test("a foreign Host is refused, localhost on any port is fine", async () => {
    const evil = await app.request("/api/repos", { headers: { host: "evil.example:3721" } });
    expect(evil.status).toBe(403);
    expect(await error(evil)).toContain("localhost");
    for (const host of ["localhost:3721", "127.0.0.1:5173", "[::1]:3721"]) {
      expect((await app.request("/api/repos", { headers: { host } })).status).toBe(200);
    }
  });

  // Value: protects=the dashboard (and the Vite dev proxy) can still create tasks; fails_when=the guard rejects same-host JSON writes; why_new=new middleware could over-block; seam=none
  test("a same-origin JSON POST still works", async () => {
    const repo = addRepo(db, { name: "acme", path: "/code/acme", defaultBranch: "main" });
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { host: "localhost:5173", origin: "http://localhost:5173", "content-type": "application/json" },
      body: JSON.stringify({ repoId: repo.id, title: "Fix login" }),
    });
    expect(res.status).toBe(201);
    expect(listTasks(db)).toHaveLength(1);
  });

  // Value: protects=body-less dashboard buttons (pause, stop all, sync) keep working; fails_when=the content-type rule demands a body; why_new=new middleware could over-block; seam=none
  test("a body-less dashboard POST still works", async () => {
    const res = await app.request("/api/crew/pause", {
      method: "POST",
      headers: { host: "localhost:3721", origin: "http://localhost:3721", "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(getSettings(db).dispatch).toBe(false);

    const bare = await app.request("/api/crew/resume", { method: "POST" });
    expect(bare.status).toBe(200);
  });

  // Value: protects=a thrown error returns JSON like every other route; fails_when=onError is removed and Hono falls back to text; why_new=errors returned plain text; seam=none
  test("a thrown error returns JSON 500", async () => {
    app.get("/api/boom", () => {
      throw new Error("Something broke.");
    });
    const res = await app.request("/api/boom");
    expect(res.status).toBe(500);
    expect(await error(res)).toBe("Something broke.");
  });
});
