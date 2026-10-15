import { expect, test } from "bun:test";
import type { PhaseMeasurement } from "@nightcrew/core";
import { addRepo, openDb } from "@nightcrew/db";
import { draftTasks } from "./compose";
import {
  type AgentEngine,
  ENGINE_PHASES,
  type EngineCapabilities,
  type PhaseRequest,
  runEnginePhase,
  ScriptedEngine,
  taskEngineError,
} from "./engine";
import { measuredPhase } from "./phase-usage";

const request = (patch: Partial<PhaseRequest> = {}): PhaseRequest => ({
  phase: "research",
  cwd: "/example",
  prompt: "Synthetic request",
  systemPrompt: "Synthetic instructions",
  model: "example",
  guard: { worktree: "/example", writableDirs: [], scope: [], protectedBranches: [], readOnly: true },
  maxTokens: 1000,
  maxTurns: 2,
  signal: new AbortController().signal,
  ...patch,
});
const limited = (capabilities: Partial<EngineCapabilities>) => {
  const engine = new ScriptedEngine({ research: () => ({ text: "Observed report" }) });
  Object.defineProperty(engine, "capabilities", {
    value: { phases: ENGINE_PHASES, structuredOutput: true, sessionContinuation: true, ...capabilities },
  });
  return engine;
};

test("unsupported phases and request contracts never invoke the engine", async () => {
  for (const [capabilities, patch] of [
    [{ phases: ["research"] }, { phase: "implement" }],
    [{ structuredOutput: false }, { phase: "review", outputSchema: { type: "object" } }],
    [{ sessionContinuation: false }, { resumeSession: "synthetic-session" }],
    [{}, { phase: "review" }],
    [{}, { guard: { ...request().guard, readOnly: false } }],
    [{}, { maxTokens: 0 }],
    [{}, { maxTurns: Number.POSITIVE_INFINITY }],
  ] as [Partial<EngineCapabilities>, Partial<PhaseRequest>][]) {
    const engine = limited(capabilities);
    const result = await runEnginePhase(engine, request(patch), () => {});
    expect(result).toMatchObject({ ok: false, tokensIn: 0, tokensOut: 0, costUsd: 0, usageStatus: "reported" });
    expect(result.error).not.toBeNull();
    expect(engine.calls).toHaveLength(0);
  }
  const undeclared = limited({});
  Object.defineProperty(undeclared, "capabilities", { value: undefined });
  expect((await runEnginePhase(undeclared as AgentEngine, request(), () => {})).ok).toBe(false);
  expect(undeclared.calls).toHaveLength(0);
});

test("a denied measured phase records a terminal zero-use result without an agent-start event", async () => {
  const engine = limited({ phases: [] });
  const rows: PhaseMeasurement[] = [];
  const result = await measuredPhase(
    engine,
    request(),
    () => {},
    (row) => rows.push(row),
  );
  expect(result.ok).toBe(false);
  expect(engine.calls).toHaveLength(0);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    status: "failed",
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    turns: 0,
    usageStatus: "reported",
  });
});

test("supported research preserves the request guard and result; cancellation starts no work", async () => {
  const engine = limited({ phases: ["research"], structuredOutput: false, sessionContinuation: false });
  const req = request();
  expect((await runEnginePhase(engine, req, () => {})).text).toBe("Observed report");
  expect(engine.calls[0]).toBe(req);
  await runEnginePhase(engine, request({ signal: AbortSignal.abort() }), () => {});
  expect(engine.calls).toHaveLength(1);
});

test("the route needs review and repair support before any build; planning and research remain independent", () => {
  const engine = limited({ phases: ["plan", "implement", "research"], structuredOutput: false });
  expect(taskEngineError(engine, { type: "implementation", workflow: "quick" }, "draft_pr")).not.toBeNull();
  expect(taskEngineError(engine, { type: "implementation", workflow: "planned" }, "propose")).toBeNull();
  expect(taskEngineError(engine, { type: "research" }, "ship")).toBeNull();
  expect(
    taskEngineError(
      limited({ phases: ["implement", "repair", "review"] }),
      { type: "implementation", workflow: "quick" },
      "train",
    ),
  ).toBeNull();
  expect(
    taskEngineError(
      limited({ phases: ["implement", "repair", "review"] }),
      { type: "implementation", workflow: "auto" },
      "train",
    ),
  ).not.toBeNull();
});

test("task drafting falls back without contacting an engine that lacks structured results", async () => {
  const db = openDb(":memory:");
  try {
    const repo = addRepo(db, { name: "Example", path: "/nonexistent", defaultBranch: "main" });
    const engine = limited({ structuredOutput: false });
    const result = await draftTasks(engine, { text: "Add an invitation form", repos: [repo], model: "example" });
    expect(result).toMatchObject({ fallback: true, costUsd: 0, drafts: [{ title: "Add an invitation form" }] });
    expect(engine.calls).toHaveLength(0);
  } finally {
    db.$client.close();
  }
});
