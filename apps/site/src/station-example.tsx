import { clsx } from "clsx";
import { useState } from "react";

const VIEWS = [
  "Mission",
  "Departure checks",
  "Decision brief",
  "Recovery",
  "Acceptance",
  "Delivery",
  "Attention",
] as const;

/** Synthetic product example. Controls change this illustration only. */
export function StationExample() {
  const [view, setView] = useState<(typeof VIEWS)[number]>("Mission");
  const [paused, setPaused] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  return (
    <div className="overflow-hidden rounded-[18px] bg-surface ring-1 ring-line shadow-[var(--shadow)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line p-4">
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Explore the station">
          {VIEWS.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              id={`example-tab-${VIEWS.indexOf(name)}`}
              aria-controls="station-example-panel"
              aria-selected={view === name}
              onClick={() => setView(name)}
              onKeyDown={(event) => {
                const index = VIEWS.indexOf(name);
                const next =
                  event.key === "ArrowRight"
                    ? (index + 1) % VIEWS.length
                    : event.key === "ArrowLeft"
                      ? (index + VIEWS.length - 1) % VIEWS.length
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? VIEWS.length - 1
                          : null;
                if (next === null) return;
                event.preventDefault();
                setView(VIEWS[next]!);
                document.getElementById(`example-tab-${next}`)?.focus();
              }}
              tabIndex={view === name ? 0 : -1}
              className={clsx(
                "rounded-lg px-3 py-2 text-[13px] transition-colors",
                view === name ? "bg-raised text-fg" : "text-muted hover:text-fg",
              )}
            >
              {name}
            </button>
          ))}
        </div>
        <span className="text-[11px] text-faint">Interactive example · synthetic tasks</span>
      </div>
      <div
        id="station-example-panel"
        role="tabpanel"
        aria-labelledby={`example-tab-${VIEWS.indexOf(view)}`}
        className="grid min-h-[360px] content-start gap-5 p-5 sm:p-7"
      >
        {view === "Mission" ? (
          <>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="grid gap-2">
                <span className="font-mono text-[11px] text-dawn">MISSION · {paused ? "PAUSED" : "ACTIVE"}</span>
                <h3 className="text-[24px] font-medium tracking-[-0.025em]">Make onboarding reliable</h3>
              </div>
              <button
                type="button"
                onClick={() => setPaused(!paused)}
                className="rounded-full px-4 py-2 text-[13px] ring-1 ring-line hover:bg-raised"
              >
                {paused ? "Resume example" : "Pause example"}
              </button>
            </div>
            <p className="text-[14px] text-muted">
              New users can create a workspace and invite their team without getting stuck.
            </p>
            <div className="grid gap-2">
              {[
                ["API", "Handle an empty invitation list", "Working"],
                ["Web", "Explain the first step", paused ? "Mission paused" : "Setup hold"],
                ["API", "Cover duplicate invitations", "Needs your judgement"],
              ].map(([repo, task, state]) => (
                <div
                  key={task}
                  className="flex flex-wrap justify-between gap-2 rounded-xl bg-raised/60 px-4 py-3 text-[13px]"
                >
                  <span>
                    <span className="mr-3 text-[11px] text-muted">{repo}</span>
                    {task}
                  </span>
                  <span className="text-dawn">{state}</span>
                </div>
              ))}
            </div>
            <p className="text-[12px] text-muted">
              Priority: High · Mission limit: 5M tokens · Acceptance: not yet verified
            </p>
            <p className="text-[12px] text-muted">
              Start paused while you plan. Link tasks to acceptance criteria and inspect missing coverage before
              dispatch. Links describe the plan; evidence and combined checks determine acceptance.
            </p>
            <p className="text-[12px] text-muted" aria-live="polite">
              {paused
                ? "New starts are held. The agent already working continues under its repository rules."
                : "One objective across repos. Each task keeps its own scope, dependencies and verification route."}
            </p>
          </>
        ) : view === "Departure checks" ? (
          <>
            <span className="font-mono text-[11px] text-dawn">BEFORE AN AGENT STARTS</span>
            <h3 className="text-[24px] font-medium tracking-[-0.025em]">Catch missing setup early.</h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {[
                ["Used today", "2M"],
                ["Running reservations", "3M"],
                ["Available from a 20M limit", "15M"],
              ].map(([label, value]) => (
                <div key={label} className="rounded-xl bg-raised/60 p-3">
                  <p className="text-[11.5px] text-muted">{label}</p>
                  <p className="mt-1 font-mono text-[20px]">{value}</p>
                </div>
              ))}
            </div>
            <div className="grid gap-2 rounded-xl bg-raised/60 p-4 text-[13px]">
              <b className="font-medium">Explain the first step · UI task</b>
              <p className="text-dawn">
                Setup hold: the route requires visual evidence. Add a preview command in repository settings.
              </p>
              <p className="text-muted">Queued without starting an agent. Fix the setup and dispatch can pick it up.</p>
            </div>
            <p className="text-[12px] text-muted">
              Departure checks inspect configuration. Rehearse repository setup and tests separately before spending
              agent tokens; task verification still runs on each change.
            </p>
          </>
        ) : view === "Decision brief" ? (
          <>
            <span className="font-mono text-[11px] text-dawn">WHEN THE CREW NEEDS YOU</span>
            <h3 className="text-[24px] font-medium tracking-[-0.025em]">A reason, evidence and a next step.</h3>
            <div className="grid gap-3 rounded-xl bg-raised/60 p-5 text-[14px]">
              <b className="font-medium text-dawn">Complete the evidence</b>
              <p>The invitation fix needs regression proof before it can move forward.</p>
              <p className="text-muted">
                Inspect the test results, correct the task or repository settings, then retry to gather fresh evidence.
              </p>
              <div className="flex flex-wrap gap-2 text-[12px] text-muted">
                {["Evidence", "Route", "Checks", "Review"].map((label) => (
                  <span key={label} className="rounded-full px-3 py-1 ring-1 ring-line">
                    {label}
                  </span>
                ))}
              </div>
            </div>
            <p className="text-[12px] text-muted">
              Retry uses saved work where available and reruns verification under current rules.
            </p>
          </>
        ) : view === "Recovery" ? (
          <>
            <span className="font-mono text-[11px] text-dawn">PICK UP THE SAVED WORK</span>
            <h3 className="text-[24px] font-medium tracking-[-0.025em]">Retry the check. Keep the build.</h3>
            <div className="grid gap-3 rounded-xl bg-raised/60 p-5 text-[14px]">
              <b className="font-medium">Build checkpoint saved</b>
              <p className="text-muted">
                The verification command timed out. Resume from compatible saved work, verify without agent edits, or
                rebuild when the approach needs to change.
              </p>
              <div className="flex flex-wrap gap-2">
                {["Resume", "Verify saved build", "Rebuild"].map((label) => (
                  <span key={label} className="rounded-full px-3 py-1 text-[12px] ring-1 ring-line">
                    {label}
                  </span>
                ))}
              </div>
            </div>
            <p className="text-[12px] text-muted">
              Checkpoint reuse requires matching task intent and commit. Automatic retries are bounded; evidence and
              authority are checked again.
            </p>
          </>
        ) : view === "Acceptance" ? (
          <>
            <span className="font-mono text-[11px] text-dawn">VERIFY THE OBJECTIVE</span>
            <h3 className="text-[24px] font-medium tracking-[-0.025em]">Finished tasks. A verified result.</h3>
            <div className="grid gap-3 rounded-xl bg-raised/60 p-5 text-[14px]">
              <b className="font-medium">Mission acceptance criteria</b>
              <p>✓ A new user can create a workspace.</p>
              <p>✓ Duplicate invitations give a clear response.</p>
              <p className="text-dawn">Next: record your evidence and run combined tests on the pinned branches.</p>
            </div>
            <p className="text-[12px] text-muted">
              Acceptance combines your criterion evidence with passing checks. Objective, task or branch changes make
              the previous acceptance outdated.
            </p>
          </>
        ) : view === "Delivery" ? (
          <>
            <span className="font-mono text-[11px] text-dawn">FOLLOW THE DELIVERY</span>
            <h3 className="text-[24px] font-medium tracking-[-0.025em]">Check. Deploy. Release.</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              {[
                ["Check", "Passed on the pinned commit"],
                ["Deploy", "Running command · 2m 14s"],
                ["Release", "Requires successful deployment"],
              ].map(([stage, state]) => (
                <div key={stage} className="grid gap-2 rounded-xl bg-raised/60 p-4">
                  <b className="text-[14px] font-medium">{stage}</b>
                  <p className="text-[13px] text-muted">{state}</p>
                </div>
              ))}
            </div>
            <p className="text-[13px] text-muted">
              Configure your own commands and choose how far the crew can proceed automatically. Manual control is the
              default. Failed or interrupted delivery waits for you.
            </p>
            <p className="text-[12px] text-muted">
              See why each stage is ready or held for the current commit and settings. Open the exact saved result from
              an earlier operation, even after later checks run. A runner restart marks unfinished actions interrupted
              for inspection.
            </p>
          </>
        ) : (
          <>
            <span className="font-mono text-[11px] text-dawn">KEEP OUTCOMES IN VIEW</span>
            <h3 className="text-[24px] font-medium tracking-[-0.025em]">An interruption stays visible.</h3>
            <div className="grid gap-3 rounded-xl bg-raised/60 p-5 text-[14px]">
              <b className="font-medium">API · interrupted deployment</b>
              <p className="text-muted">
                The command stopped before recording its outcome. Inspect the saved result and the external deployment.
              </p>
              <p className="text-dawn" aria-live="polite">
                {reviewed
                  ? "Reviewed in this example. Delivery retry remains held."
                  : "Needs attention until you mark it reviewed."}
              </p>
              <div>
                <button
                  type="button"
                  onClick={() => setReviewed(!reviewed)}
                  className="rounded-full px-4 py-2 text-[13px] ring-1 ring-line hover:bg-raised"
                >
                  {reviewed ? "Reset example" : "Mark example reviewed"}
                </button>
              </div>
            </div>
            <p className="text-[12px] text-muted">
              Filter failed and interrupted operations across repos, or narrow queued departures by repository and hold
              reason. Reviewing clears attention; it does not execute work or approve a delivery retry.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
