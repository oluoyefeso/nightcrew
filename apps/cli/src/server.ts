import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, sep } from "node:path";
import type { TriageAction } from "@nightcrew/core";
import {
  addNote,
  type Db,
  getRepo,
  getReport,
  getRun,
  getStation,
  getTask,
  getTrain,
  listNights,
  recordTriage,
  schema,
  setCarState,
  updateTask,
} from "@nightcrew/db";
import { type AgentEngine, type Crew, pullCar, taskRef } from "@nightcrew/runner";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { mergePr } from "./github";
import { mountMissionRoutes } from "./mission-routes";
import { mountOperationsRoutes } from "./operations-routes";
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
   * The per-launch key from the link `nightcrew` prints. When set, the API
   * answers only callers sending it in X-NightCrew-Token: the dashboard reads
   * it from the link once and keeps it per origin. The page shell itself is
   * public; it holds no data. Unset: no key check (tests, development).
   */
  token?: string;
}

export function createApp(opts: ServerOptions) {
  const { db } = opts;
  const app = new Hono();

  const { token } = opts;
  // The key travels only in a header. A cookie would reach every localhost
  // port, so any other local server could pick it up and replay it.
  const hasKey = (c: Context) => token === undefined || sameSecret(c.req.header(TOKEN_HEADER), token);

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
  /** Where NightCrew keeps its data; workDir (task clones) is for display, with $HOME as ~. */
  app.get("/api/info", (c) =>
    c.json({ version: VERSION, dataDir: opts.dataDir, workDir: tildePath(join(opts.dataDir, "work")) }),
  );

  app.get("/api/nights", (c) => c.json(listNights(db)));

  app.get("/api/station", (c) => {
    c.header("cache-control", "no-store");
    return c.json({ ...getStation(db), queue: opts.crew.getQueue() });
  });

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
      // Merge only the commit the crew checked: a branch changed since then is refused by GitHub.
      // Classic runs predate the gate and have no recorded commit.
      const sha = detail.run.source === "classic" ? null : await gatedSha(db, id);
      if (detail.run.source !== "classic" && !sha)
        return c.json({ error: "Can't find the commit NightCrew checked for this run, so it won't merge it." }, 409);
      const merged = await mergePr(detail.run.prUrl, sha);
      if (!merged.ok) return c.json({ error: merged.error }, 502);
      db.update(schema.runs).set({ prState: "merged" }).where(eq(schema.runs.id, id)).run();
    }

    // Sending back a task that's still on its train takes it off first, so the
    // train never carries work you rejected.
    if (action === "send_back" && detail.run.trainId && !detail.run.shipSha) {
      const train = getTrain(db, detail.run.trainId);
      const car = train?.cars.find((x) => x.runId === id);
      if (train && car?.state === "on") {
        const repo = getRepo(db, train.repoId);
        if (!repo) return c.json({ error: "Repo not found." }, 404);
        const pulled = await pullCar(repo, train, car.mergeSha, opts.publish);
        if (!pulled.ok)
          return c.json({ error: `Couldn't take it off the train, so it wasn't sent back: ${pulled.error}` }, 409);
        setCarState(db, train.id, id, "pulled");
      }
    }
    const note = body.note?.trim() || null;
    recordTriage(db, id, action, note);

    // Morning decisions feed back into the task itself.
    const task = getTask(db, detail.run.taskId);
    if (task && task.status !== "running") {
      if (action === "send_back") {
        if (note) addNote(db, task.id, "you", note, id);
        updateTask(db, task.id, { status: "queued", runAt: null, autoRetries: 0, recoveryMode: "rebuild" });
      } else if (action === "again") updateTask(db, task.id, { status: "queued", runAt: null, autoRetries: 0 });
      else if (action === "close" || action === "merge") updateTask(db, task.id, { status: "archived" });
      else if (action === "undo") updateTask(db, task.id, { status: "done" });
    }
    void opts.crew.pump();
    return c.json(getRun(db, id));
  });

  mountTaskRoutes(app, { db, crew: opts.crew, engine: opts.engine, dataDir: opts.dataDir });
  mountOperationsRoutes(app, { db, crew: opts.crew, dataDir: opts.dataDir, publish: opts.publish });
  mountMissionRoutes(app, { db, crew: opts.crew });
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
        // The launch link carries the key in ?t= until the app strips it; don't pass it on.
        "referrer-policy": "no-referrer",
      },
    });
  });

  return app;
}

/** The commit the crew's final gate accepted for this run's task, read from your repo. */
async function gatedSha(db: Db, runId: string): Promise<string | null> {
  const row = db
    .select({ taskId: schema.runs.taskId, repoPath: schema.runs.repoPath })
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))
    .get();
  if (!row) return null;
  const task = getTask(db, row.taskId);
  const path = (task && getRepo(db, task.repoId)?.path) ?? row.repoPath;
  if (!path) return null;
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--verify", "--quiet", `${taskRef(row.taskId)}^{commit}`], {
      cwd: path,
      stdout: "pipe",
      stderr: "ignore",
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 && /^[0-9a-f]{40,64}$/.test(out.trim()) ? out.trim() : null;
  } catch {
    return null;
  }
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const TOKEN_HEADER = "x-nightcrew-token";
const LOCKED = "Open NightCrew from the link it printed in your terminal.";

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

export const VERSION = "1.0.0-alpha.15";

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

/** /Users/me/.nightcrew → ~/.nightcrew. */
export function tildePath(path: string, home = homedir()): string {
  if (!home || home === sep) return path;
  if (path === home) return "~";
  return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}
