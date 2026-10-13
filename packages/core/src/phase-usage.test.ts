import { expect, test } from "bun:test";
import { type PhaseMeasurement, phaseMeasurements } from "./phase-usage";

const start: PhaseMeasurement = {
  type: "phase_measurement",
  version: 1,
  id: "phase-1",
  phase: "review",
  model: "example-model",
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: null,
  status: "running",
  elapsedMs: null,
  tokenLimit: 1000,
  turnLimit: 5,
  tokensIn: null,
  tokensOut: null,
  turns: null,
  costUsd: null,
  usageStatus: "unknown",
  tokenOvershoot: null,
};

test("an unfinished phase becomes interrupted only after its run ends", () => {
  expect(phaseMeasurements([{ data: start }], true)[0]?.status).toBe("running");
  expect(phaseMeasurements([{ data: start }], false)[0]).toMatchObject({
    status: "interrupted",
    tokensIn: null,
    costUsd: null,
  });
});

test("repeated events do not double-count usage or erase a finished review", () => {
  const end: PhaseMeasurement = {
    ...start,
    status: "succeeded",
    tokensIn: 100,
    tokensOut: 20,
    costUsd: 0.01,
    turns: 2,
    elapsedMs: 500,
    usageStatus: "reported",
    tokenOvershoot: 0,
    endedAt: "2026-01-01T00:00:00.500Z",
  };
  const rows = phaseMeasurements(
    [{ data: start }, { data: end }, { data: end }, { data: start }, { data: { ...end, id: "phase-2" } }],
    false,
  );
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.status)).toEqual(["succeeded", "succeeded"]);
  expect(rows.reduce((sum, row) => sum + (row.tokensIn ?? 0), 0)).toBe(200);
});

test("legacy and malformed measurements are ignored without breaking run history", () => {
  const events = [
    null,
    {},
    { tokens: 100 },
    { ...start, version: 2 },
    { ...start, tokensIn: -1 },
    { ...start, costUsd: Number.NaN },
    { ...start, tokenLimit: null },
    start,
  ].map((data) => ({ data }));
  expect(phaseMeasurements(events, true)).toEqual([start]);
});
