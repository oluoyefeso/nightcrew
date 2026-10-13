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
  let liveIn = 0;
  let liveOut = 0;
  let observed = false;
  let savedTokens = -1;
  let savedAt = clock;
  const elapsed = () => Math.max(0, performance.now() - clock);
  const partial = (): Pick<PhaseMeasurement, "tokensIn" | "tokensOut" | "usageStatus" | "tokenOvershoot"> => ({
    tokensIn: observed ? liveIn : null,
    tokensOut: observed ? liveOut : null,
    usageStatus: observed ? "partial" : "unknown",
    tokenOvershoot: observed ? Math.max(0, liveIn + liveOut - request.maxTokens) : null,
  });
  const onEngine = (event: EngineEvent) => {
    if (event.kind !== "usage") return onEvent(event);
    if (![event.tokensIn, event.tokensOut].every((n) => Number.isSafeInteger(n) && n >= 0)) return;
    const changed = !observed || event.tokensIn > liveIn || event.tokensOut > liveOut;
    if (!changed) return;
    observed = true;
    liveIn = Math.max(liveIn, event.tokensIn);
    liveOut = Math.max(liveOut, event.tokensOut);
    // Persist the first observation, then at most once per second unless 10k more tokens arrived.
    // Terminal/throw records below always flush the latest observation.
    const now = performance.now();
    if (savedTokens < 0 || now - savedAt >= 1000 || liveIn + liveOut - savedTokens >= 10_000) {
      savedTokens = liveIn + liveOut;
      savedAt = now;
      record({ ...start, ...partial(), elapsedMs: elapsed() });
    }
  };
  const stoppedStatus = () =>
    request.signal.reason?.name === "TimeoutError" ? ("timed_out" as const) : ("cancelled" as const);
  let result: PhaseResult;
  try {
    result = await engine.runPhase(request, onEngine);
  } catch (error) {
    record({
      ...start,
      ...partial(),
      status: request.signal.aborted ? stoppedStatus() : "failed",
      endedAt: new Date().toISOString(),
      elapsedMs: elapsed(),
    });
    throw error;
  }
  const terminalStatus =
    result.usageStatus ?? (result.ok ? "reported" : result.tokensIn + result.tokensOut > 0 ? "partial" : "unknown");
  const usageStatus =
    observed && (terminalStatus === "unknown" || result.tokensIn < liveIn || result.tokensOut < liveOut)
      ? "partial"
      : terminalStatus;
  // A terminal response is cumulative, never an increment on top of streamed totals.
  result = {
    ...result,
    tokensIn: Math.max(result.tokensIn, liveIn),
    tokensOut: Math.max(result.tokensOut, liveOut),
    usageStatus,
  };
  record({
    ...start,
    status: request.signal.aborted ? stoppedStatus() : result.ok ? "succeeded" : "failed",
    endedAt: new Date().toISOString(),
    elapsedMs: elapsed(),
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
