// biome-ignore-all lint/a11y/noNoninteractiveTabindex: The tab panel is a keyboard focus target for its text content.
import { clsx } from "clsx";
import { ArrowUpRight, Check, Circle, FileText, Pause, Play } from "lucide-react";
import { useState } from "react";

const VIEWS = ["Goal", "Decision", "Evidence"] as const;

/** A walkthrough of existing goal, decision and evidence features using synthetic data. */
export function StationExample() {
  const [view, setView] = useState<(typeof VIEWS)[number]>("Goal");
  const [paused, setPaused] = useState(false);
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface text-left">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
        <span className="text-[12px] text-muted">
          NightCrew <span className="mx-2 text-faint">/</span> Make onboarding reliable
        </span>
        <span className="text-[10px] text-muted">Interactive walkthrough · synthetic data</span>
      </div>
      <div className="grid md:grid-cols-[180px_minmax(0,1fr)]">
        <div
          className="flex gap-1 border-b border-line p-3 md:flex-col md:border-r md:border-b-0"
          role="tablist"
          aria-label="Explore the goal"
        >
          {VIEWS.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              id={`example-tab-${name}`}
              aria-controls="station-example-panel"
              aria-selected={view === name}
              tabIndex={view === name ? 0 : -1}
              onClick={() => setView(name)}
              onKeyDown={(event) => {
                const index = VIEWS.indexOf(name);
                const next =
                  event.key === "ArrowRight" || event.key === "ArrowDown"
                    ? (index + 1) % VIEWS.length
                    : event.key === "ArrowLeft" || event.key === "ArrowUp"
                      ? (index + VIEWS.length - 1) % VIEWS.length
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? VIEWS.length - 1
                          : null;
                if (next === null) return;
                event.preventDefault();
                setView(VIEWS[next]!);
                document.getElementById(`example-tab-${VIEWS[next]}`)?.focus();
              }}
              className={clsx(
                "flex items-center gap-2 rounded-md px-3 py-2 text-left text-[12px] transition-colors",
                view === name ? "bg-raised text-fg" : "text-muted hover:text-fg",
              )}
            >
              {name === "Goal" ? (
                <Circle className="size-3.5" />
              ) : name === "Decision" ? (
                <ArrowUpRight className="size-3.5" />
              ) : (
                <FileText className="size-3.5" />
              )}
              {name}
              {name === "Decision" && <span className="ml-auto text-[10px] text-dawn">1</span>}
            </button>
          ))}
        </div>
        <div
          id="station-example-panel"
          role="tabpanel"
          tabIndex={0}
          aria-labelledby={`example-tab-${view}`}
          className="grid min-h-[360px] content-start gap-5 p-5 sm:p-8"
        >
          {view === "Goal" ? (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="grid gap-2">
                  <span className="text-[11px] text-muted">
                    {paused ? "Paused" : "In progress"} · Acceptance not yet verified
                  </span>
                  <h3 className="text-[23px] font-medium tracking-[-0.025em]">Make onboarding reliable</h3>
                </div>
                <button
                  type="button"
                  onClick={() => setPaused(!paused)}
                  className="inline-flex items-center gap-2 rounded-md border border-line px-3 py-1.5 text-[12px] text-muted hover:text-fg"
                >
                  {paused ? <Play className="size-3" /> : <Pause className="size-3" />}
                  {paused ? "Resume example" : "Pause example"}
                </button>
              </div>
              <p className="max-w-[580px] text-[13px] text-muted">
                New users can create a workspace and invite their team without getting stuck.
              </p>
              <div className="divide-y divide-line border-y border-line">
                {[
                  ["Handle an empty invitation list", "Working"],
                  ["Explain the first step", paused ? "Paused" : "Queued"],
                  ["Cover duplicate invitations", "Needs evidence"],
                ].map(([title, state]) => (
                  <div key={title} className="flex flex-wrap items-center justify-between gap-2 py-3 text-[12px]">
                    <span>{title}</span>
                    <span className={state === "Needs evidence" ? "text-dawn" : "text-muted"}>{state}</span>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-muted" aria-live="polite">
                {paused
                  ? "New starts are paused. The agent already working continues."
                  : "One goal across repositories. Each task keeps its scope and verification rules."}
              </p>
            </>
          ) : view === "Decision" ? (
            <>
              <span className="text-[11px] text-dawn">Needs your judgment</span>
              <h3 className="text-[23px] font-medium tracking-[-0.025em]">The fix needs regression evidence.</h3>
              <p className="max-w-[580px] text-[13px] text-muted">
                The duplicate-invitation change passed its unit checks. It still needs a test showing the original
                failure and the corrected behaviour.
              </p>
              <div className="grid gap-2 border-y border-line py-4 text-[12px]">
                <span>Next step</span>
                <p className="text-muted">
                  Inspect the checks, then send the task back with the missing test requirement.
                </p>
              </div>
              <div>
                <button
                  type="button"
                  onClick={() => {
                    setView("Evidence");
                    document.getElementById("example-tab-Evidence")?.focus();
                  }}
                  className="inline-flex items-center gap-2 rounded-md bg-fg px-3 py-2 text-[12px] text-bg"
                >
                  Inspect example evidence <ArrowUpRight className="size-3.5" />
                </button>
              </div>
              <p className="text-[11px] text-muted">Retry gathers fresh evidence under the current repository rules.</p>
            </>
          ) : (
            <>
              <span className="text-[11px] text-muted">Cover duplicate invitations · latest example attempt</span>
              <h3 className="text-[23px] font-medium tracking-[-0.025em]">See what supports the result.</h3>
              <div className="divide-y divide-line border-y border-line text-[12px]">
                <div className="flex items-center justify-between gap-3 py-4">
                  <span>Unit checks</span>
                  <span className="inline-flex items-center gap-1.5 text-ok">
                    <Check className="size-3.5" />
                    Passed
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3 py-4">
                  <span>Regression proof</span>
                  <span className="text-dawn">Missing</span>
                </div>
                <div className="flex items-center justify-between gap-3 py-4">
                  <span>Review</span>
                  <span className="text-dawn">Needs your eyes</span>
                </div>
              </div>
              <p className="max-w-[580px] text-[12px] text-muted">
                Passing a check does not establish that the goal is complete. Review criterion evidence and verify the
                combined result before accepting it.
              </p>
              <details className="text-[12px] text-muted">
                <summary className="cursor-pointer hover:text-fg">What can I inspect?</summary>
                <p className="pt-3">
                  Run details retain test output, reviewer findings, decision notes and available visual evidence. Each
                  attempt keeps its own record.
                </p>
              </details>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
