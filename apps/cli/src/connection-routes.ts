import type { ModelConnection } from "@nightcrew/core";
import {
  type ConnectionInput,
  createConnection,
  type Db,
  deleteConnection,
  getConnection,
  listConnections,
  saveConnectionCheck,
  updateConnection,
} from "@nightcrew/db";
import { checkConnection, discoverModels, normalizeConnectionUrl } from "@nightcrew/runner";
import type { Hono } from "hono";

const INVALIDATED = "The connection changed. Reload it before checking again.";
type ActiveCheck = { controller: AbortController; revision: number; kind: "models" | "check" };

export function mountConnectionRoutes(app: Hono, { db }: { db: Db }) {
  const active = new Map<string, ActiveCheck>();
  const view = (connection: ModelConnection) => {
    const operation = active.get(connection.id);
    return {
      ...connection,
      credentialConfigured: !connection.apiKeyEnv || Boolean(process.env[connection.apiKeyEnv]),
      active: operation ? { kind: operation.kind, stopping: operation.controller.signal.aborted } : null,
    };
  };
  app.get("/api/connections", (c) => {
    c.header("cache-control", "no-store");
    return c.json(listConnections(db).map(view));
  });
  app.post("/api/connections", async (c) => {
    const parsed = parseProfile(await c.req.json().catch(() => null));
    if (typeof parsed === "string") return c.json({ error: parsed }, 400);
    if (listConnections(db).length >= 20) return c.json({ error: "Keep at most 20 model connections." }, 400);
    return c.json(view(createConnection(db, parsed)), 201);
  });
  app.patch("/api/connections/:id", async (c) => {
    const current = getConnection(db, c.req.param("id"));
    if (!current) return c.json({ error: "Connection not found." }, 404);
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = parseProfile(body, true);
    if (typeof parsed === "string") return c.json({ error: parsed }, 400);
    const revision = (body as { revision: number }).revision;
    const updated = updateConnection(db, current.id, revision, parsed);
    if (!updated) return c.json({ error: INVALIDATED }, 409);
    active.get(current.id)?.controller.abort();
    return c.json(view(updated));
  });
  app.delete("/api/connections/:id", async (c) => {
    const current = getConnection(db, c.req.param("id"));
    if (!current) return c.json({ error: "Connection not found." }, 404);
    const revision = readRevision(await c.req.json().catch(() => null));
    if (revision === null) return c.json({ error: "Provide the saved connection revision." }, 400);
    if (!deleteConnection(db, current.id, revision)) return c.json({ error: INVALIDATED }, 409);
    active.get(current.id)?.controller.abort();
    return c.json({ ok: true });
  });
  app.post("/api/connections/:id/stop", async (c) => {
    const id = c.req.param("id");
    if (!getConnection(db, id)) return c.json({ error: "Connection not found." }, 404);
    active.get(id)?.controller.abort();
    return c.json({ ok: true });
  });
  for (const kind of ["models", "check"] as const) {
    app.post(`/api/connections/:id/${kind}`, async (c) => {
      const current = getConnection(db, c.req.param("id"));
      if (!current) return c.json({ error: "Connection not found." }, 404);
      const revision = readRevision(await c.req.json().catch(() => null));
      if (revision === null) return c.json({ error: "Provide the saved connection revision." }, 400);
      if (revision !== current.revision) return c.json({ error: INVALIDATED }, 409);
      if (active.has(current.id))
        return c.json({ error: "A connection check is already running. Wait or stop it first." }, 409);
      if (active.size >= 2)
        return c.json({ error: "Two connection checks are already running. Wait for one to finish." }, 409);
      const apiKey = current.apiKeyEnv ? process.env[current.apiKeyEnv] : undefined;
      if (current.apiKeyEnv && !apiKey)
        return c.json(
          {
            error:
              "The credential environment variable is unavailable. Set it before starting NightCrew, then restart.",
          },
          400,
        );
      if (kind === "check" && !current.model)
        return c.json({ error: "Choose and save a model before checking its tool support." }, 400);
      const operation: ActiveCheck = { kind, revision, controller: new AbortController() };
      active.set(current.id, operation);
      const signal = AbortSignal.any([operation.controller.signal, c.req.raw.signal]);
      try {
        if (kind === "models") {
          const models = await discoverModels({ baseUrl: current.baseUrl, apiKey }, { signal });
          if (getConnection(db, current.id)?.revision !== revision) return c.json({ error: INVALIDATED }, 409);
          return c.json({ models });
        }
        const result = await checkConnection({ baseUrl: current.baseUrl, model: current.model, apiKey }, { signal });
        const saved = saveConnectionCheck(db, current.id, revision, result);
        if (!saved) return c.json({ error: INVALIDATED }, 409);
        return c.json({ check: result });
      } catch {
        // Transport errors are sanitized, but never propagate unexpected error text from a provider or credential.
        return c.json(
          {
            error: signal.aborted
              ? "Connection check stopped."
              : "Could not complete the connection request. Check its endpoint and credential configuration.",
          },
          400,
        );
      } finally {
        if (active.get(current.id) === operation) active.delete(current.id);
      }
    });
  }
}

function readRevision(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 1 && Number.isSafeInteger(record.revision) && Number(record.revision) > 0
    ? Number(record.revision)
    : null;
}
function parseProfile(value: unknown, updating = false): ConnectionInput | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Provide a connection profile.";
  const p = value as Record<string, unknown>;
  const allowed = ["name", "baseUrl", "model", "apiKeyEnv", ...(updating ? ["revision"] : [])];
  if (Object.keys(p).some((key) => !allowed.includes(key)))
    return "Unknown connection field. Save a credential environment variable name, never a key value.";
  if (updating && !(Number.isSafeInteger(p.revision) && Number(p.revision) > 0))
    return "Provide the saved connection revision.";
  if (typeof p.name !== "string" || !p.name.trim() || p.name.length > 80 || /\p{Cc}/u.test(p.name))
    return "Use a connection name of 1–80 characters.";
  if (typeof p.baseUrl !== "string" || p.baseUrl.length > 2048) return "Provide an API base URL.";
  let baseUrl: string;
  try {
    baseUrl = normalizeConnectionUrl(p.baseUrl);
  } catch {
    return "Use an HTTPS API base URL or loopback HTTP URL, without credentials, query or fragment.";
  }
  if (p.model !== undefined && (typeof p.model !== "string" || p.model.length > 200 || /\p{Cc}/u.test(p.model)))
    return "Use a model ID of up to 200 characters.";
  if (p.apiKeyEnv != null && (typeof p.apiKeyEnv !== "string" || !/^[A-Z_][A-Z0-9_]{0,99}$/.test(p.apiKeyEnv)))
    return "Use an environment variable name such as MODEL_API_KEY, or leave it empty.";
  return {
    name: p.name.trim(),
    baseUrl,
    model: typeof p.model === "string" ? p.model.trim() : "",
    apiKeyEnv: typeof p.apiKeyEnv === "string" ? p.apiKeyEnv : null,
  };
}
