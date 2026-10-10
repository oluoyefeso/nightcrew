import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import type { TriageAction } from "@nightcrew/core";
import {
  addNote,
  type Db,
  getReport,
  getRun,
  getTask,
  listNights,
  recordTriage,
  schema,
  updateTask,
} from "@nightcrew/db";
import type { AgentEngine, Crew } from "@nightcrew/runner";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { mergePr } from "./github";
import { mountTaskRoutes } from "./routes";
import { syncClassic } from "./sync";
import { mountTrustRoutes } from "./trust-routes";

const ACTIONS: TriageAction[] = ["merge", "send_back", "close", "again", "undo"];

export interface ServerOptions {
  db: Db;
  cwd: string;
  classicRoot?: string;
  webDir?: string;
  crew: Crew;
  engine: AgentEngine;
  dataDir: string;
  publish: boolean;
  /**
   * The per-launch key from the link `nightcrew` prints. When set, the page
   * and API answer only a browser that opened that link (or a caller sending
   * it in X-NightCrew-Token). Unset: no key check (tests, development).
   */
  token?: string;
}

export function createApp(opts: ServerOptions) {
  const { db } = opts;
  const app = new Hono();

  const { token } = opts;
  const hasKey = (c: Context) =>
    token === undefined ||
    sameSecret(c.req.header(TOKEN_HEADER), token) ||
    Object.entries(getCookie(c)).some(([name, value]) => name.startsWith(COOKIE) && sameSecret(value, token));

  // Opening the printed link trades ?t= for a cookie and drops it from the address bar.
  app.use("*", async (c, next) => {
    if (token === undefined) return next();
    const url = new URL(c.req.url);
    if (sameSecret(url.searchParams.get("t") ?? undefined, token)) {
      setCookie(c, `${COOKIE}_${url.port || "80"}`, token, { path: "/", httpOnly: true, sameSite: "Strict" });
      url.searchParams.delete("t");
      return c.redirect(`${url.pathname}${url.search}`, 302);
    }
    if (c.req.path.startsWith("/api/")) return next();
    // The locked page styles itself, but let the dashboard's own files load.
    if (c.req.path.startsWith("/assets/") || /^\/favicon\.(svg|ico)$/.test(c.req.path) || hasKey(c)) return next();
    return c.html(LOCKED_PAGE, 401);
  });

  // The API is for this machine only: refuse DNS-rebound hosts, callers without
  // this launch's key, and cross-site writes.
  app.use("/api/*", async (c, next) => {
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    if (!isLocalHost(host)) {
      return c.json({ error: "NightCrew only answers to localhost." }, 403);
    }
    if (!hasKey(c)) return c.json({ error: LOCKED }, 401);
    if (MUTATING.has(c.req.method)) {
      // A write must come from this very origin, not just any localhost page.
      const origin = c.req.header("origin");
      if (origin !== undefined && origin.toLowerCase() !== `${new URL(c.req.url).protocol}//${host}`.toLowerCase()) {
        return c.json({ error: "Cross-site requests are refused." }, 403);
      }
      const type = c.req.header("content-type");
      const hasBody =
        Number(c.req.header("content-length") ?? 0) > 0 || c.req.header("transfer-encoding") !== undefined;
      if ((type !== undefined || hasBody) && !/^application\/json\b/i.test(type ?? "")) {
        return c.json({ error: "Send JSON with content-type application/json." }, 415);
      }
    }
    await next();
  });
  app.onError((e, c) => c.json({ error: e instanceof Error ? e.message : String(e) }, 500));

  app.get("/api/health", (c) => c.json({ ok: true, version: VERSION }));

  app.get("/api/nights", (c) => c.json(listNights(db)));

  app.get("/api/report", (c) => {
    const report = getReport(db, c.req.query("night") || undefined);
    return report ? c.json(report) : c.json({ error: "No runs yet." }, 404);
  });

  app.get("/api/runs/:id", (c) => {
    const detail = getRun(db, c.req.param("id"));
    return detail ? c.json(detail) : c.json({ error: "Run not found." }, 404);
  });

  app.post("/api/runs/:id/triage", async (c) => {
    const id = c.req.param("id");
    const body = await c.req
      .json<{ action?: string; note?: string }>()
      .catch(() => ({}) as { action?: string; note?: string });
    const action = body.action as TriageAction;
    if (!ACTIONS.includes(action)) return c.json({ error: `Unknown action. Use one of: ${ACTIONS.join(", ")}.` }, 400);
    const detail = getRun(db, id);
    if (!detail) return c.json({ error: "Run not found." }, 404);

    if (action === "merge") {
      if (!detail.run.prUrl) return c.json({ error: "This run has no pull request to merge." }, 400);
      const merged = await mergePr(detail.run.prUrl);
      if (!merged.ok) return c.json({ error: merged.error }, 502);
      db.update(schema.runs).set({ prState: "merged" }).where(eq(schema.runs.id, id)).run();
    }
    const note = body.note?.trim() || null;
    recordTriage(db, id, action, note);

    // Morning decisions feed back into the task itself.
    const task = getTask(db, detail.run.taskId);
    if (task && task.status !== "running") {
      if (action === "send_back") {
        if (note) addNote(db, task.id, "you", note, id);
        updateTask(db, task.id, { status: "queued", runAt: null });
      } else if (action === "again") updateTask(db, task.id, { status: "queued", runAt: null });
      else if (action === "close" || action === "merge") updateTask(db, task.id, { status: "archived" });
      else if (action === "undo") updateTask(db, task.id, { status: "done" });
    }
    void opts.crew.pump();
    return c.json(getRun(db, id));
  });

  mountTaskRoutes(app, { db, crew: opts.crew, engine: opts.engine, dataDir: opts.dataDir });
  mountTrustRoutes(app, { db, publish: opts.publish });

  app.post("/api/sync", async (c) => {
    const result = await syncClassic(db, { root: opts.classicRoot, cwd: opts.cwd, github: true });
    return c.json(result);
  });

  app.notFound(async (c) => {
    if (c.req.path.startsWith("/api/")) return c.json({ error: "Not found." }, 404);
    const asset = await webAsset(c.req.path, opts.webDir);
    if (!asset) {
      return c.text("The dashboard isn't built yet. Run `bun run build`, or use `bun run dev` for development.", 503);
    }
    return new Response(asset.body, {
      headers: {
        "content-type": asset.type,
        "cache-control": asset.immutable ? "public, max-age=31536000, immutable" : "no-cache",
      },
    });
  });

  return app;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const COOKIE = "nc_session";
const TOKEN_HEADER = "x-nightcrew-token";
const LOCKED = "Open NightCrew from the link it printed in your terminal.";
const LOCKED_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>NightCrew</title>
<style>
:root{color-scheme:light dark;--bg:#f7f7f5;--fg:#1c1c1a;--muted:#6b6b66}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ececea;--muted:#9a9a94}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;padding:0 16px}
main{max-width:28rem}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:var(--muted)}
</style></head>
<body><main><h1>NightCrew</h1><p>${LOCKED}</p></main></body></html>
`;

/** Constant-time compare of a presented key with the real one. */
function sameSecret(given: string | undefined, secret: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** "localhost:3721" or "[::1]" is local; anything else, including junk, is not. */
function isLocalHost(host: string): boolean {
  const name = host.match(/^(\[[^\]]*\]|[^:[\]]+)(?::\d+)?$/)?.[1];
  return name !== undefined && LOCAL_HOSTS.has(name.toLowerCase());
}

export const VERSION = "1.0.0-alpha.2";

// ── Static dashboard ────────────────────────────────────────────────────────
// The compiled binary carries the built dashboard (see scripts/embed-web.ts).
// In development we read apps/web/dist from disk instead.

type Embedded = Record<string, string>;
let embedded: Embedded | null | undefined;

async function loadEmbedded(): Promise<Embedded | null> {
  if (embedded !== undefined) return embedded;
  try {
    // @ts-expect-error: generated by scripts/embed-web.ts at build time
    embedded = (await import("./web-assets.gen.ts")).default as Embedded;
  } catch {
    embedded = null;
  }
  return embedded;
}

async function webAsset(path: string, webDir?: string) {
  const files = await loadEmbedded();
  const clean = path === "/" ? "/index.html" : path;
  const isAsset = clean.startsWith("/assets/");
  const resolve = (p: string) => {
    if (files && Object.keys(files).length) return files[p] ?? null;
    if (webDir && !p.includes("..")) {
      const full = join(webDir, p);
      return existsSync(full) ? full : null;
    }
    return null;
  };
  // Unknown routes fall back to index.html so client-side routing works.
  const file = resolve(clean) ?? (isAsset ? null : resolve("/index.html"));
  if (!file) return null;
  const served = resolve(clean) ? clean : "/index.html";
  return { body: Bun.file(file), type: MIME[extname(served)] ?? "application/octet-stream", immutable: isAsset };
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};
