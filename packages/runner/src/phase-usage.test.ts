import { expect, test } from "bun:test";
import type { PhaseMeasurement } from "@nightcrew/core";
import { type PhaseRequest, ScriptedEngine } from "./engine";
import { measuredPhase } from "./phase-usage";

const request = (signal = new AbortController().signal): PhaseRequest => ({
  phase: "research",
  cwd: "/example",
  prompt: "PRIVATE PROMPT",
  systemPrompt: "PRIVATE INSTRUCTIONS",
  model: "example-model",
  guard: { worktree: "/example", writableDirs: [], scope: [], protectedBranches: [], readOnly: true },
  maxTokens: 1000,
  maxTurns: 5,
  signal,
  resumeSession: "PRIVATE SESSION",
});

test("records the start before execution and keeps cached input within the reported total", async () => {
  const rows: PhaseMeasurement[] = [];
  const engine = new ScriptedEngine({
    research: () => {
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "running", tokensIn: null });
      return {
        tokensIn: 1000,
        tokensOut: 50,
        costUsd: 0.12,
        turns: 4,
        usage: {
          "example-model": { input: 100, output: 50, thinking: 0, cacheRead: 800, cacheWrite: 100, costUsd: 0.12 },
        },
      };
    },
  });
  await measuredPhase(
    engine,
    request(),
    () => {},
    (row) => rows.push(row),
  );
  expect(rows[1]).toMatchObject({
    id: rows[0]?.id,
    status: "succeeded",
    tokensIn: 1000,
    tokensOut: 50,
    tokenOvershoot: 50,
    costUsd: 0.12,
    turns: 4,
    usageStatus: "reported",
  });
  expect(rows[1]?.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(rows)).not.toContain("PRIVATE");
});

test("a cancelled stream retains partial tokens but leaves unreported cost and turns unknown", async () => {
  const stop = new AbortController();
  const rows: PhaseMeasurement[] = [];
  const engine = new ScriptedEngine({
    research: () => {
      stop.abort();
      return { ok: false, tokensIn: 40, tokensOut: 10, usageStatus: "partial", costUsd: 0, turns: 0 };
    },
  });
  await measuredPhase(
    engine,
    request(stop.signal),
    () => {},
    (row) => rows.push(row),
  );
  expect(rows[1]).toMatchObject({
    status: "cancelled",
    tokensIn: 40,
    tokensOut: 10,
    costUsd: null,
    turns: null,
    usageStatus: "partial",
  });
});

test("a thrown engine error is recorded without inventing usage or storing its private message", async () => {
  const rows: PhaseMeasurement[] = [];
  const engine = new ScriptedEngine({
    research: () => {
      throw new Error("PRIVATE ERROR");
    },
  });
  await expect(
    measuredPhase(
      engine,
      request(),
      () => {},
      (row) => rows.push(row),
    ),
  ).rejects.toThrow("PRIVATE ERROR");
  expect(rows[1]).toMatchObject({
    status: "failed",
    tokensIn: null,
    tokensOut: null,
    costUsd: null,
    usageStatus: "unknown",
  });
  expect(JSON.stringify(rows)).not.toContain("PRIVATE");
});

test("a failed phase with no usage evidence is unknown, not a free attempt", async () => {
  const rows: PhaseMeasurement[] = [];
  const engine = new ScriptedEngine({
    research: () => ({ ok: false, usageStatus: "unknown", tokensIn: 0, tokensOut: 0 }),
  });
  await measuredPhase(
    engine,
    request(),
    () => {},
    (row) => rows.push(row),
  );
  expect(rows[1]).toMatchObject({
    status: "failed",
    tokensIn: null,
    tokensOut: null,
    costUsd: null,
    tokenOvershoot: null,
  });
});
