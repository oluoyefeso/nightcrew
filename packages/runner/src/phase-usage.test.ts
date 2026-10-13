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

test("engines without usage metadata do not present failed zero-usage calls as complete accounting", async () => {
  const rows: PhaseMeasurement[] = [];
  const engine = new ScriptedEngine({ research: () => ({ ok: false, tokensIn: 0, tokensOut: 0, costUsd: 0 }) });
  await measuredPhase(
    engine,
    request(),
    () => {},
    (row) => rows.push(row),
  );
  expect(rows[1]).toMatchObject({ usageStatus: "unknown", costUsd: null, tokensIn: null });
});

test("a time limit is distinguished from manual cancellation", async () => {
  const stop = new AbortController();
  const rows: PhaseMeasurement[] = [];
  const engine = new ScriptedEngine({
    research: () => {
      stop.abort(new DOMException("Time limit", "TimeoutError"));
      return { ok: false, usageStatus: "partial" };
    },
  });
  await measuredPhase(
    engine,
    request(stop.signal),
    () => {},
    (row) => rows.push(row),
  );
  expect(rows[1]?.status).toBe("timed_out");
});

test("stream snapshots are cumulative, throttled and reconciled without double counting", async () => {
  const rows: PhaseMeasurement[] = [];
  const engine = new ScriptedEngine({
    research: (_req, emit) => {
      emit({ kind: "usage", text: "PRIVATE CONTENT", tokensIn: 100, tokensOut: 10 });
      expect(rows.at(-1)).toMatchObject({
        status: "running",
        tokensIn: 100,
        tokensOut: 10,
        usageStatus: "partial",
        costUsd: null,
        turns: null,
      });
      emit({ kind: "usage", text: "PRIVATE CONTENT", tokensIn: 100, tokensOut: 10 });
      emit({ kind: "usage", text: "PRIVATE CONTENT", tokensIn: 50, tokensOut: 5 });
      emit({ kind: "usage", text: "PRIVATE CONTENT", tokensIn: 200, tokensOut: 20 });
      expect(rows).toHaveLength(2);
      emit({ kind: "usage", text: "PRIVATE CONTENT", tokensIn: 10_100, tokensOut: 20 });
      expect(rows).toHaveLength(3);
      return { tokensIn: 10_200, tokensOut: 30, usageStatus: "reported", costUsd: 0.1, turns: 2 };
    },
  });
  const result = await measuredPhase(
    engine,
    request(),
    () => {},
    (row) => rows.push(row),
  );
  expect(rows).toHaveLength(4);
  expect(rows.at(-1)).toMatchObject({
    tokensIn: 10_200,
    tokensOut: 30,
    usageStatus: "reported",
    costUsd: 0.1,
    turns: 2,
  });
  expect(result.tokensIn).toBe(10_200);
  expect(JSON.stringify(rows)).not.toContain("PRIVATE");
});

test("throwing after a stream flushes its latest observed floor without fabricating cost", async () => {
  const rows: PhaseMeasurement[] = [];
  const engine = new ScriptedEngine({
    research: (_req, emit) => {
      emit({ kind: "usage", text: "Usage", tokensIn: 100, tokensOut: 10 });
      emit({ kind: "usage", text: "Usage", tokensIn: 200, tokensOut: 20 });
      throw Error("PRIVATE ERROR");
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
  expect(rows.at(-1)).toMatchObject({
    status: "failed",
    tokensIn: 200,
    tokensOut: 20,
    usageStatus: "partial",
    costUsd: null,
    turns: null,
  });
  expect(JSON.stringify(rows)).not.toContain("PRIVATE");
});

test("incomplete terminal accounting cannot reduce streamed usage", async () => {
  const rows: PhaseMeasurement[] = [];
  const engine = new ScriptedEngine({
    research: (_req, emit) => {
      emit({ kind: "usage", text: "Usage", tokensIn: 500, tokensOut: 50 });
      emit({ kind: "usage", text: "Usage", tokensIn: Number.NaN, tokensOut: -1 });
      return { tokensIn: 300, tokensOut: 30, usageStatus: "reported" };
    },
  });
  const result = await measuredPhase(
    engine,
    request(),
    () => {},
    (row) => rows.push(row),
  );
  expect(result).toMatchObject({ tokensIn: 500, tokensOut: 50, usageStatus: "partial" });
  expect(rows.at(-1)).toMatchObject({
    tokensIn: 500,
    tokensOut: 50,
    usageStatus: "partial",
    costUsd: null,
    turns: null,
  });
});

test("a small usage increase is checkpointed once the time interval has elapsed", async () => {
  const rows: PhaseMeasurement[] = [];
  const engine = new ScriptedEngine({
    research: async (_req, emit) => {
      emit({ kind: "usage", text: "Usage", tokensIn: 100, tokensOut: 10 });
      await Bun.sleep(1050);
      emit({ kind: "usage", text: "Usage", tokensIn: 101, tokensOut: 11 });
      expect(rows.at(-1)).toMatchObject({ status: "running", tokensIn: 101, tokensOut: 11 });
      return { tokensIn: 101, tokensOut: 11 };
    },
  });
  await measuredPhase(
    engine,
    request(),
    () => {},
    (row) => rows.push(row),
  );
  expect(rows).toHaveLength(4);
});
