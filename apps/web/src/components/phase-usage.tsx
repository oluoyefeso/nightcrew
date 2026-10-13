import { formatDuration, formatTokens, phaseMeasurements } from "@nightcrew/core";
import type { RunEvent } from "../api";

const LABEL: Record<string, string> = {
  research: "Research",
  plan: "Plan",
  implement: "Build",
  repair: "Repair",
  review: "Review",
  compose: "Compose",
};

export function PhaseUsage({ events, live }: { events: RunEvent[]; live: boolean }) {
  const phases = phaseMeasurements(events, live);
  if (!phases.length) return null;
  return (
    <section aria-label="Agent usage by phase" className="grid min-w-0 gap-3">
      <h2 className="text-[13px] font-medium text-muted">Agent usage by phase</h2>
      <div className="overflow-x-auto rounded-xl ring-1 ring-line">
        <table className="w-full text-left text-[12px]">
          <thead className="bg-raised text-faint">
            <tr>
              {["Phase / model", "Outcome", "Time", "Input / output", "Cost", "Turns"].map((label) => (
                <th key={label} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="bg-surface">
            {phases.map((p) => (
              <tr key={p.id} className="border-t border-line align-top">
                <th scope="row" className="px-3 py-2 font-medium">
                  {LABEL[p.phase] ?? p.phase}
                  <span className="block max-w-44 break-words text-[11px] font-normal text-faint">{p.model}</span>
                </th>
                <td className="px-3 py-2 capitalize">{p.status.replaceAll("_", " ")}</td>
                <td className="whitespace-nowrap px-3 py-2 font-mono">
                  {p.elapsedMs === null ? "—" : p.elapsedMs < 1000 ? "<1s" : formatDuration(p.elapsedMs)}
                </td>
                <td className="whitespace-nowrap px-3 py-2 font-mono">
                  {p.tokensIn === null || p.tokensOut === null
                    ? "Unknown"
                    : `${formatTokens(p.tokensIn)} / ${formatTokens(p.tokensOut)}`}
                  <span className="block text-[10px] text-faint">
                    Limit {formatTokens(p.tokenLimit)}
                    {p.usageStatus === "partial" ? " · partial" : ""}
                  </span>
                  {p.tokenOvershoot !== null && p.tokenOvershoot > 0 && (
                    <span className="block text-[10px] text-dawn">{formatTokens(p.tokenOvershoot)} over limit</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2 font-mono">
                  {p.costUsd === null ? "Unknown" : `$${p.costUsd.toFixed(4)}`}
                </td>
                <td className="whitespace-nowrap px-3 py-2 font-mono">
                  {p.turns ?? "?"} / {p.turnLimit}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11.5px] leading-relaxed text-faint">
        Input includes cached tokens. Live checkpoints retain observed tokens; partial or interrupted calls may still
        leave usage and cost unknown. Model names are those requested for each phase. A successful agent phase still
        needs the task’s checks and acceptance.
        {phases.some((p) => p.usageStatus !== "reported") &&
          " Run totals contain only recorded usage and may be incomplete."}
      </p>
    </section>
  );
}
