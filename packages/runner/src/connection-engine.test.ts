import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, deleteConnection, openDb, updateSettings } from "@nightcrew/db";
import { ConnectionEngine } from "./connection-engine";
import { type EngineEvent, type PhaseRequest, runEnginePhase, ScriptedEngine } from "./engine";
import { git } from "./git";
import { measuredPhase } from "./phase-usage";
import { RoutedEngine } from "./routed-engine";

let dir: string;
let repo: string;
let server: ReturnType<typeof Bun.serve> | undefined;
const schema = {
  type: "object",
  properties: { verdict: { type: "string", enum: ["ready", "needs_eyes"] } },
  required: ["verdict"],
  additionalProperties: false,
};
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "nc-connection-engine-"));
  repo = join(dir, "project");
  mkdirSync(repo);
  await git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "greet.js"), 'export const greeting = "Hi";\n');
});
afterEach(() => {
  server?.stop(true);
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});
const request = (patch: Partial<PhaseRequest> = {}): PhaseRequest => ({
  phase: "implement",
  cwd: repo,
  isolated: true,
  prompt: "Fix the greeting.",
  systemPrompt: "Make the requested scoped change.",
  model: "fixture",
  guard: { worktree: repo, writableDirs: [], scope: ["greet.js"], protectedBranches: ["main"], readOnly: false },
  maxTokens: 1000,
  maxTurns: 5,
  signal: new AbortController().signal,
  ...patch,
});
function engine(handler: (req: Request) => Response | Promise<Response>) {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  return new ConnectionEngine(
    { baseUrl: `http://127.0.0.1:${server.port}/v1`, model: "fixture", apiKeyEnv: "FIXTURE_KEY" },
    { FIXTURE_KEY: "synthetic-key" },
  );
}
const call = (id: string, name: string, args: unknown) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const response = (calls?: unknown[], extra: Record<string, unknown> = {}) =>
  Response.json({
    choices: [
      {
        message: { role: "assistant", content: calls ? null : "Complete.", ...(calls ? { tool_calls: calls } : {}) },
        finish_reason: calls ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 },
    ...extra,
  });

test("direct execution reads, edits, checks and returns a structured result with exact usage", async () => {
  let turns = 0;
  const e = engine(async (req) => {
    expect(req.headers.get("authorization")).toBe("Bearer synthetic-key");
    const body = await req.json();
    expect(body.model).toBe("fixture");
    expect(body.messages[1].content).toContain(`Working directory: ${repo}`);
    expect(body.max_tokens).toBeLessThanOrEqual(1000);
    const last = body.messages.at(-1);
    turns++;
    if (turns === 1) return response([call("r", "Read", { file_path: "greet.js" })]);
    if (turns === 2) {
      expect(last.content).toContain('"Hi"');
      return response([call("e", "Edit", { file_path: "greet.js", old_string: '"Hi"', new_string: '"Hello"' })]);
    }
    if (turns === 3)
      return response([
        call("b", "Bash", {
          command:
            'bun -e \'import {greeting} from "./greet.js"; if(greeting!=="Hello") process.exit(1); console.log("checked")\'',
        }),
      ]);
    expect(last.content).toContain('"exitCode":0');
    expect(last.content).toContain("checked");
    return response([call("f", "Finish", { verdict: "ready" })]);
  });
  const result = await runEnginePhase(e, request({ outputSchema: schema }), () => {});
  expect(result).toMatchObject({
    ok: true,
    structured: { verdict: "ready" },
    tokensIn: 40,
    tokensOut: 20,
    turns: 4,
    usageStatus: "reported",
    costStatus: "reported",
  });
  expect(readFileSync(join(repo, "greet.js"), "utf8")).toContain('"Hello"');
});

test.each(["missing", "over-budget", "malformed-batch", "truncated"])(
  "%s response executes no requested writes",
  async (mode) => {
    const e = engine(() => {
      const calls = [call("w", "Write", { file_path: "greet.js", content: "changed" })];
      if (mode === "malformed-batch") calls.push(call("bad", "Unknown", {}));
      return response(
        calls,
        mode === "missing"
          ? { usage: null }
          : mode === "over-budget"
            ? { usage: { prompt_tokens: 1001, completion_tokens: 1 } }
            : mode === "truncated"
              ? { choices: [{ message: { tool_calls: calls }, finish_reason: "length" }] }
              : {},
      );
    });
    const r = await runEnginePhase(e, request(), () => {});
    expect(r.ok).toBe(false);
    expect(readFileSync(join(repo, "greet.js"), "utf8")).toContain('"Hi"');
    if (mode === "missing") expect(r.usageStatus).toBe("partial");
  },
);

test("read-only review has no editing tools and a shell stash is denied", async () => {
  let n = 0;
  const events: EngineEvent[] = [];
  const e = engine(async (req) => {
    const body = await req.json();
    expect(body.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(["Read", "Bash", "Finish"]);
    if (n++ === 0) return response([call("s", "Bash", { command: "git stash" })]);
    expect(body.messages.at(-1).content).toContain("Blocked");
    return response([call("f", "Finish", { verdict: "needs_eyes" })]);
  });
  const r = await runEnginePhase(
    e,
    request({ phase: "review", outputSchema: schema, guard: { ...request().guard, readOnly: true } }),
    (event) => events.push(event),
  );
  expect(r.ok).toBe(true);
  expect(events.some((event) => event.kind === "denied")).toBe(true);
});

test("file tools cannot follow symlinks outside the project", async () => {
  writeFileSync(join(dir, "outside.txt"), "synthetic-private-content");
  symlinkSync(join(dir, "outside.txt"), join(repo, "outside.txt"));
  let n = 0;
  const e = engine(async (req) => {
    const body = await req.json();
    if (n++ === 0) return response([call("r", "Read", { file_path: "outside.txt" })]);
    expect(JSON.stringify(body)).not.toContain("synthetic-private-content");
    expect(body.messages.at(-1).content).toContain("could not access");
    return response();
  });
  expect((await runEnginePhase(e, request(), () => {})).ok).toBe(true);
});

test("Bash cannot change into the host project while checking a task", async () => {
  writeFileSync(join(dir, "outside.txt"), "synthetic-private-content");
  let n = 0;
  const e = engine(async (req) => {
    const body = await req.json();
    if (n++ === 0) return response([call("b", "Bash", { command: "cd .. && cat outside.txt" })]);
    expect(body.messages.at(-1).content).toContain("Keep commands in the task workspace");
    expect(JSON.stringify(body)).not.toContain("synthetic-private-content");
    return response();
  });
  expect((await runEnginePhase(e, request(), () => {})).ok).toBe(true);
});

test("Bash runs without the provider credential or ambient keys", async () => {
  const envName = "NIGHTCREW_EXECUTION_TEST_API_KEY";
  process.env[envName] = "synthetic-private-secret";
  let n = 0;
  try {
    const e = engine(async (req) => {
      const body = await req.json();
      if (n++ === 0) return response([call("b", "Bash", { command: "env | sort" })]);
      expect(body.messages.at(-1).content).not.toContain("synthetic-private-secret");
      expect(body.messages.at(-1).content).not.toContain("synthetic-key");
      return response();
    });
    expect((await runEnginePhase(e, request(), () => {})).ok).toBe(true);
  } finally {
    delete process.env[envName];
  }
});

test("provider details and credentials never appear in fixed failures", async () => {
  const e = engine(() =>
    Response.json({ error: { message: "synthetic-key private provider detail" } }, { status: 402 }),
  );
  const r = await runEnginePhase(e, request(), () => {});
  expect(r.ok).toBe(false);
  expect(r.error).toContain("402");
  expect(JSON.stringify(r)).not.toContain("synthetic-key");
  expect(r.usageStatus).toBe("unknown");
});

test("unknown cost stays null in phase measurements despite complete token counters", async () => {
  const e = engine(() => response(undefined, { usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  const costs: (number | null)[] = [];
  const r = await measuredPhase(
    e,
    request(),
    () => {},
    (measurement) => costs.push(measurement.costUsd),
  );
  expect(r.ok).toBe(true);
  expect(r.costStatus).toBe("unknown");
  expect(costs.at(-1)).toBeNull();
  expect(r.usageStatus).toBe("reported");
});

test("cancellation during a provider wait returns without executing tools", async () => {
  const stop = new AbortController();
  const e = engine(async () => {
    stop.abort();
    return response([call("w", "Write", { file_path: "greet.js", content: "wrong" })]);
  });
  const r = await runEnginePhase(e, request({ signal: stop.signal }), () => {});
  expect(r.ok).toBe(false);
  expect(readFileSync(join(repo, "greet.js"), "utf8")).not.toBe("wrong");
});

test("a selected profile routes execution and never silently falls back after deletion", async () => {
  const db = openDb(":memory:");
  const fallback = new ScriptedEngine({ implement: () => ({ text: "Fallback." }) });
  try {
    const routed = new RoutedEngine(db, fallback);
    expect((await runEnginePhase(routed, request(), () => {})).text).toBe("Fallback.");
    let calls = 0;
    engine(() => {
      calls++;
      return response();
    });
    const profile = createConnection(db, {
      name: "Fixture",
      baseUrl: `http://127.0.0.1:${server!.port}/v1`,
      model: "fixture",
      apiKeyEnv: null,
    });
    updateSettings(db, { executionConnectionId: profile.id });
    expect(routed.capabilities.sessionContinuation).toBe(false);
    expect((await runEnginePhase(routed, request(), () => {})).ok).toBe(true);
    expect(calls).toBe(1);
    deleteConnection(db, profile.id, profile.revision);
    expect((await runEnginePhase(routed, request(), () => {})).ok).toBe(false);
    expect(fallback.calls).toHaveLength(1);
  } finally {
    db.$client.close();
  }
});
