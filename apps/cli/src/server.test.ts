import { beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addRepo, type Db, getSettings, listTasks, openDb } from "@nightcrew/db";
import { Crew, ScriptedEngine } from "@nightcrew/runner";
import { createApp, tildePath } from "./server";

let db: Db;
let app: ReturnType<typeof createApp>;
const KEY = "k".repeat(64);
let locked: ReturnType<typeof createApp>;

beforeEach(() => {
  db = openDb(":memory:");
  const engine = new ScriptedEngine({});
  const dataDir = join(tmpdir(), "nc-server");
  const crew = new Crew({ db, engine, dataDir, publish: false });
  app = createApp({ db, cwd: dataDir, crew, engine, dataDir, publish: false });
  locked = createApp({ db, cwd: dataDir, crew, engine, dataDir, publish: false, token: KEY });
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

describe("GET /api/info", () => {
  // Value: protects=Settings shows where task clones really live; fails_when=/api/info drops dataDir/workDir or workDir stops ending in /work; why_new=H6, the clone path was hard-coded copy; seam=none
  test("returns the data dir and the clone folder", async () => {
    const res = await app.request("/api/info", { headers: { host: "localhost:3721" } });
    expect(res.status).toBe(200);
    const info = (await res.json()) as { dataDir: string; workDir: string };
    expect(info.dataDir).toBe(join(tmpdir(), "nc-server"));
    expect(info.workDir).toBe(tildePath(join(tmpdir(), "nc-server", "work")));
    expect((await locked.request("/api/info", { headers: { host: "localhost:3721" } })).status).toBe(401);
  });

  // Value: protects=$HOME shows as ~ and look-alike prefixes don't; fails_when=tildePath matches /Users/me2 for home /Users/me or drops the separator check; why_new=H6; seam=none
  test("tildePath abbreviates only paths under home", () => {
    expect(tildePath("/Users/me/.nightcrew/work", "/Users/me")).toBe("~/.nightcrew/work");
    expect(tildePath("/Users/me", "/Users/me")).toBe("~");
    expect(tildePath("/Users/me2/x", "/Users/me")).toBe("/Users/me2/x");
    expect(tildePath("/srv/nc/work", "/Users/me")).toBe("/srv/nc/work");
  });
});

describe("per-launch key", () => {
  const host = "localhost:3721";

  test("the API refuses a caller without the key", async () => {
    // Value: protects=a local process or another localhost page can't read or drive the API without the printed link; fails_when=the token check is dropped from the /api middleware; why_new=D10 adds the per-launch key; seam=none
    const res = await locked.request("/api/crew", { headers: { host } });
    expect(res.status).toBe(401);
    expect(await error(res)).toBe("Open NightCrew from the link it printed in your terminal.");
    const wrong = await locked.request("/api/crew", { headers: { host, "x-nightcrew-token": "nope" } });
    expect(wrong.status).toBe(401);
    const wrongCookie = await locked.request("/api/crew", { headers: { host, cookie: "nc_session_3721=nope" } });
    expect(wrongCookie.status).toBe(401);
  });

  test("the printed link sets the cookie and redirects without the key", async () => {
    // Value: protects=opening ?t=<key> logs the browser in with an HttpOnly SameSite=Strict cookie and strips the key from the URL; fails_when=the cookie flags change or the redirect keeps ?t; why_new=D10 adds the per-launch key; seam=none
    const res = await locked.request(`http://${host}/?t=${KEY}&night=n1`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?night=n1");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`nc_session_3721=${KEY}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
  });

  test("the cookie or the header opens the API", async () => {
    // Value: protects=the dashboard (cookie) and scripted callers (X-NightCrew-Token) still get in with the key; fails_when=hasKey stops reading either one; why_new=D10 adds the per-launch key; seam=none
    const byCookie = await locked.request("/api/crew", {
      headers: { host, cookie: `other=1; nc_session_3721=${KEY}` },
    });
    expect(byCookie.status).toBe(200);
    const byHeader = await locked.request("/api/crew", { headers: { host, "x-nightcrew-token": KEY } });
    expect(byHeader.status).toBe(200);
  });

  test("a page without the key gets the explainer, its assets still load", async () => {
    // Value: protects=a stray tab gets a plain explanation (with this dashboard's own address), not the dashboard shell; fails_when=the page gate is dropped, blocks /assets, or echoes an unchecked Host header; why_new=D10 adds the per-launch key, W6 restyled the page and added the host; seam=none
    const page = await locked.request("/", { headers: { host } });
    expect(page.status).toBe(401);
    const html = await page.text();
    expect(html).toContain("This dashboard needs its launch link.");
    // The example link names the port this dashboard is on, and a forged Host can't inject markup.
    expect(html).toContain(`http://${host}/?t=`);
    const forged = await locked.request("/", { headers: { host: "<script>x</script>" } });
    expect(await forged.text()).not.toContain("<script>x");
    const asset = await locked.request("/assets/app.js", { headers: { host } });
    expect(asset.status).not.toBe(401);
  });

  test("a write from another localhost port is refused, even body-less", async () => {
    // Value: protects=a page on localhost:5173 (or any other port) can't fire body-less POSTs like stop-all at the dashboard; fails_when=the Origin check goes back to any-localhost; why_new=the Origin check ignored the port; seam=none
    const res = await locked.request("/api/crew/pause", {
      method: "POST",
      headers: { host, origin: "http://localhost:5173", "x-nightcrew-token": KEY },
    });
    expect(res.status).toBe(403);
    expect(getSettings(db).dispatch).toBe(true);
    const same = await locked.request("/api/crew/pause", {
      method: "POST",
      headers: { host, origin: `http://${host}`, "x-nightcrew-token": KEY },
    });
    expect(same.status).toBe(200);
  });

  test("without a token option the app answers as before", async () => {
    // Value: protects=tests and dev (NIGHTCREW_DEV, --dev) work without a key; fails_when=the token check runs when no token was given; why_new=D10 made the key optional; seam=none
    expect((await app.request("/api/crew", { headers: { host } })).status).toBe(200);
    expect((await app.request(`/?t=${KEY}`, { headers: { host } })).status).not.toBe(302);
  });
});
