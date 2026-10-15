import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ModelConnection } from "@nightcrew/core";
import { type Db, getConnection, listConnections, openDb, updateSettings } from "@nightcrew/db";
import { Crew, ScriptedEngine } from "@nightcrew/runner";
import { createApp } from "./server";

let db: Db;
let app: ReturnType<typeof createApp>;
const servers: ReturnType<typeof Bun.serve>[] = [];
const token = "synthetic-dashboard-key";
const credentialName = `NIGHTCREW_TEST_${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`;
const credential = "synthetic-provider-credential";
beforeEach(() => {
  db = openDb(":memory:");
  updateSettings(db, { dispatch: false });
  const engine = new ScriptedEngine({});
  const crew = new Crew({ db, engine, dataDir: "/demo/data", publish: false });
  app = createApp({ db, crew, engine, dataDir: "/demo/data", cwd: "/demo", publish: false, token });
});
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  delete process.env[credentialName];
  db.$client.close();
});
const send = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json", "x-nightcrew-token": token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const profile = { name: "Example model", baseUrl: "http://localhost:11434/v1", model: "example", apiKeyEnv: null };
const create = async (patch: Partial<Pick<ModelConnection, "name" | "baseUrl" | "model" | "apiKeyEnv">> = {}) => {
  const response = await send("POST", "/api/connections", { ...profile, ...patch });
  expect(response.status).toBe(201);
  return (await response.json()) as ModelConnection;
};
function serve(handler: (req: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(server);
  return `http://127.0.0.1:${server.port}/v1`;
}
const path = (c: ModelConnection) => `/api/connections/${c.id}`;

test("connections require the launch key for reads, changes and provider requests", async () => {
  const c = await create();
  for (const [method, route] of [
    ["GET", "/api/connections"],
    ["POST", "/api/connections"],
    ["PATCH", path(c)],
    ["DELETE", path(c)],
    ["POST", `${path(c)}/models`],
    ["POST", `${path(c)}/check`],
    ["POST", `${path(c)}/stop`],
  ] as const)
    expect((await app.request(route, { method, body: method === "GET" ? undefined : "{}" })).status).toBe(401);
  expect(listConnections(db)).toHaveLength(1);
});

test("profiles accept references only, normalize URLs, and enforce revisions", async () => {
  for (const invalid of [
    null,
    [],
    { ...profile, apiKey: credential },
    { ...profile, name: "" },
    { ...profile, apiKeyEnv: "sk-key-value" },
    { ...profile, model: "invalid\nmodel" },
    { ...profile, baseUrl: "https://user:secret@example.com/v1" },
    { ...profile, baseUrl: "http://example.com/v1" },
    { ...profile, baseUrl: "https://example.com/v1?key=secret" },
  ])
    expect((await send("POST", "/api/connections", invalid)).status).toBe(400);
  expect(listConnections(db)).toHaveLength(0);
  const c = await create({ baseUrl: "https://example.com/v1/" });
  expect(c.baseUrl).toBe("https://example.com/v1");
  expect((await send("PATCH", path(c), { ...profile, revision: 2 })).status).toBe(409);
  expect((await send("PATCH", path(c), { ...profile, name: "Updated", revision: 1 })).status).toBe(200);
  expect(getConnection(db, c.id)).toMatchObject({ name: "Updated", revision: 2, lastCheck: null });
  expect((await send("DELETE", path(c), { revision: 1 })).status).toBe(409);
  expect((await send("DELETE", path(c), { revision: 2 })).status).toBe(200);
  expect(getConnection(db, c.id)).toBeNull();
});

test("discovers and checks using a server credential without exposing or persisting its value", async () => {
  process.env[credentialName] = credential;
  let calls = 0;
  const baseUrl = serve(async (req) => {
    calls++;
    expect(req.headers.get("authorization")).toBe(`Bearer ${credential}`);
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ data: [{ id: "example" }] });
    const body = (await req.json()) as { messages: { role: string; content: string }[] };
    const tool = body.messages.find((m) => m.role === "tool");
    return Response.json({
      choices: [
        {
          message: tool
            ? { content: tool.content }
            : {
                tool_calls: [
                  { id: "read", type: "function", function: { name: "Read", arguments: '{"file_path":"probe.txt"}' } },
                ],
              },
        },
      ],
    });
  });
  const c = await create({ baseUrl, apiKeyEnv: credentialName });
  const list = await send("GET", "/api/connections");
  expect(list.headers.get("cache-control")).toBe("no-store");
  expect(await list.json()).toMatchObject([{ apiKeyEnv: credentialName, credentialConfigured: true }]);
  expect(await (await send("POST", `${path(c)}/models`, { revision: 1 })).json()).toEqual({ models: ["example"] });
  const check = await send("POST", `${path(c)}/check`, { revision: 1 });
  expect(await check.json()).toMatchObject({ check: { status: "passed", usage: { status: "unknown" } } });
  expect(calls).toBe(3);
  expect(getConnection(db, c.id)?.lastCheck?.status).toBe("passed");
  expect(JSON.stringify(db.$client.query("SELECT * FROM model_connections").all())).not.toContain(credential);
  expect(await (await send("GET", "/api/connections")).text()).not.toContain(credential);
  await send("PATCH", path(c), { ...profile, baseUrl, revision: 1 });
  expect(getConnection(db, c.id)?.lastCheck).toBeNull();
});

test("missing credentials, models, and stale revisions cannot contact an endpoint", async () => {
  let calls = 0;
  const baseUrl = serve(() => {
    calls++;
    return Response.json({ data: [] });
  });
  const c = await create({ baseUrl, apiKeyEnv: credentialName });
  expect((await send("POST", `${path(c)}/models`, { revision: 1 })).status).toBe(400);
  expect((await send("POST", `${path(c)}/check`, { revision: 1 })).status).toBe(400);
  expect((await send("POST", `${path(c)}/models`, { revision: 2 })).status).toBe(409);
  expect((await send("POST", `${path(c)}/check`, { revision: 1, apiKey: credential })).status).toBe(400);
  const empty = await create({ baseUrl, model: "" });
  expect((await send("POST", `${path(empty)}/check`, { revision: 1 })).status).toBe(400);
  expect(calls).toBe(0);
});

test("discovery exposes only the fixed failure category, while tool refusals persist as evidence", async () => {
  let checking = false;
  const c = await create({
    baseUrl: serve(() =>
      Response.json(
        { error: { message: checking ? `${credential} does not support tools` : credential } },
        { status: checking ? 400 : 401 },
      ),
    ),
  });
  const discovery = await send("POST", `${path(c)}/models`, { revision: 1 });
  expect(discovery.status).toBe(400);
  expect(await discovery.json()).toEqual({
    error: "The endpoint refused access. Check the credential and its permissions.",
  });
  checking = true;
  expect((await send("POST", `${path(c)}/check`, { revision: 1 })).status).toBe(200);
  expect(getConnection(db, c.id)?.lastCheck?.summary).toContain("does not support tool calls");
  expect(JSON.stringify(getConnection(db, c.id))).not.toContain(credential);
});

test("stop settles a pending check and saves cancellation evidence", async () => {
  const started = Promise.withResolvers<void>();
  const c = await create({
    baseUrl: serve(() => {
      started.resolve();
      return new Promise<Response>(() => {});
    }),
  });
  const checking = send("POST", `${path(c)}/check`, { revision: 1 });
  await started.promise;
  expect(await (await send("GET", "/api/connections")).json()).toMatchObject([
    { active: { kind: "check", stopping: false } },
  ]);
  expect((await send("POST", `${path(c)}/check`, { revision: 1 })).status).toBe(409);
  expect((await send("POST", `${path(c)}/stop`)).status).toBe(200);
  expect(await (await checking).json()).toMatchObject({ check: { status: "cancelled" } });
  expect(getConnection(db, c.id)?.lastCheck?.status).toBe("cancelled");
  expect(await (await send("GET", "/api/connections")).json()).toMatchObject([{ active: null }]);
});

test("editing or removing a connection aborts old work and discards stale evidence", async () => {
  for (const action of ["PATCH", "DELETE"]) {
    const started = Promise.withResolvers<void>();
    const c = await create({
      baseUrl: serve(() => {
        started.resolve();
        return new Promise<Response>(() => {});
      }),
    });
    const checking = send("POST", `${path(c)}/check`, { revision: 1 });
    await started.promise;
    expect(
      (await send(action, path(c), action === "PATCH" ? { ...profile, revision: 1 } : { revision: 1 })).status,
    ).toBe(200);
    expect((await checking).status).toBe(409);
    expect(getConnection(db, c.id)?.lastCheck ?? null).toBeNull();
  }
});

test("limits simultaneous provider requests across connections", async () => {
  const c = await create({ baseUrl: serve(() => new Promise<Response>(() => {})) });
  const second = await create({ baseUrl: c.baseUrl });
  const third = await create({ baseUrl: c.baseUrl });
  const firstRequest = send("POST", `${path(c)}/models`, { revision: 1 });
  const secondRequest = send("POST", `${path(second)}/check`, { revision: 1 });
  // app.request starts route bodies asynchronously; wait for both active slots.
  for (let n = 0; n < 100; n++) {
    const rows = (await (await send("GET", "/api/connections")).json()) as { active: unknown }[];
    if (rows.filter((r) => r.active).length === 2) break;
    await Bun.sleep(1);
  }
  expect((await send("POST", `${path(third)}/check`, { revision: 1 })).status).toBe(409);
  await send("POST", `${path(c)}/stop`);
  await send("POST", `${path(second)}/stop`);
  expect((await firstRequest).status).toBe(400);
  expect((await secondRequest).status).toBe(200);
});
