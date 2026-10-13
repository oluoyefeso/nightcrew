import type { PhaseMeasurement } from "@nightcrew/core";
import type { AgentEngine, EngineEvent, PhaseRequest, PhaseResult } from "./engine";

/** Record before execution so a process crash leaves an explicit unfinished attempt. */
export async function measuredPhase(
  engine: AgentEngine,
  request: PhaseRequest,
  onEvent: (event: EngineEvent) => void,
  record: (measurement: PhaseMeasurement) => void,
): Promise<PhaseResult> {
  const clock = performance.now();
  const start: PhaseMeasurement = {
    type: "phase_measurement",
    version: 1,
    id: crypto.randomUUID(),
    phase: request.phase,
    model: request.model,
    startedAt: new Date().toISOString(),
    endedAt: null,
    status: "running",
    elapsedMs: null,
    tokenLimit: request.maxTokens,
    turnLimit: request.maxTurns,
    tokensIn: null,
    tokensOut: null,
    turns: null,
    costUsd: null,
    usageStatus: "unknown",
    tokenOvershoot: null,
  };
  record(start);
  const stoppedStatus = () =>
    request.signal.reason?.name === "TimeoutError" ? ("timed_out" as const) : ("cancelled" as const);
  let result: PhaseResult;
  try {
    result = await engine.runPhase(request, onEvent);
  } catch (error) {
    record({
      ...start,
      status: request.signal.aborted ? stoppedStatus() : "failed",
      endedAt: new Date().toISOString(),
      elapsedMs: Math.max(0, performance.now() - clock),
    });
    throw error;
  }
  const usageStatus =
    result.usageStatus ?? (result.ok ? "reported" : result.tokensIn + result.tokensOut > 0 ? "partial" : "unknown");
  record({
    ...start,
    status: request.signal.aborted ? stoppedStatus() : result.ok ? "succeeded" : "failed",
    endedAt: new Date().toISOString(),
    elapsedMs: Math.max(0, performance.now() - clock),
    tokensIn: usageStatus === "unknown" ? null : result.tokensIn,
    tokensOut: usageStatus === "unknown" ? null : result.tokensOut,
    turns: usageStatus === "reported" ? result.turns : null,
    costUsd: usageStatus === "reported" ? result.costUsd : null,
    usageStatus,
    tokenOvershoot:
      usageStatus === "unknown" ? null : Math.max(0, result.tokensIn + result.tokensOut - request.maxTokens),
  });
  return result;
}
