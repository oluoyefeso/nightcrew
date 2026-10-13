/** Versioned numerical measurements stored in the existing run event stream. */
export interface PhaseMeasurement {
  type: "phase_measurement";
  version: 1;
  id: string;
  phase: string;
  model: string;
  startedAt: string;
  endedAt: string | null;
  status: "running" | "succeeded" | "failed" | "cancelled" | "timed_out";
  elapsedMs: number | null;
  tokenLimit: number;
  turnLimit: number;
  /** Input includes cache reads and writes; never add them again to this value. */
  tokensIn: number | null;
  tokensOut: number | null;
  turns: number | null;
  costUsd: number | null;
  usageStatus: "reported" | "partial" | "unknown";
  tokenOvershoot: number | null;
}

export type PhaseMeasurementView = Omit<PhaseMeasurement, "status"> & {
  status: PhaseMeasurement["status"] | "interrupted";
};

const numberOrNull = (n: unknown) => n === null || (typeof n === "number" && Number.isFinite(n) && n >= 0);

function isMeasurement(value: unknown): value is PhaseMeasurement {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === "phase_measurement" &&
    v.version === 1 &&
    [v.id, v.phase, v.model, v.startedAt].every((s) => typeof s === "string" && s.length > 0) &&
    (v.endedAt === null || typeof v.endedAt === "string") &&
    ["running", "succeeded", "failed", "cancelled", "timed_out"].includes(String(v.status)) &&
    ["reported", "partial", "unknown"].includes(String(v.usageStatus)) &&
    typeof v.tokenLimit === "number" &&
    typeof v.turnLimit === "number" &&
    [v.tokenLimit, v.turnLimit, v.elapsedMs, v.tokensIn, v.tokensOut, v.turns, v.costUsd, v.tokenOvershoot].every(
      numberOrNull,
    )
  );
}

/** Old runs remain readable; duplicate events cannot count the same phase twice. */
export function phaseMeasurements(events: { data?: unknown }[], runIsActive: boolean): PhaseMeasurementView[] {
  const phases = new Map<string, PhaseMeasurement>();
  for (const { data } of events) {
    if (!isMeasurement(data)) continue;
    const previous = phases.get(data.id);
    // A delayed/replayed start must not overwrite a terminal measurement.
    if (previous && previous.status !== "running" && data.status === "running") continue;
    if (
      previous?.status === "running" &&
      data.status === "running" &&
      (previous.elapsedMs ?? -1) > (data.elapsedMs ?? -1)
    )
      continue;
    phases.set(data.id, data);
  }
  return [...phases.values()].map((p) => ({
    ...p,
    status: p.status === "running" && !runIsActive ? "interrupted" : p.status,
  }));
}
