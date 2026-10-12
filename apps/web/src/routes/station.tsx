import { AUTONOMY_LABEL, decisionFor, type Run } from "@nightcrew/core";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { clsx } from "clsx";
import { ArrowRight, CheckCheck, CircleHelp, History, Plus, Route, Signal, TrainFront } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { crewQuery, missionsQuery, reposQuery, stationQuery, tasksQuery, toast } from "../api";
import { AgentBoard, CrewSummary } from "../components/agent-board";
import { Select } from "../components/form";
import { AttentionCard, operationAttentionQuery } from "../components/operation-attention";
import { RunPane } from "../components/run-pane";
import { RunRow } from "../components/run-row";
import { PromotionBanners, TrainCards } from "../components/trust";
import { Button, Kbd } from "../components/ui";
import { isTypingTarget } from "../lib";
import { MissionCard } from "./missions";

export function StationPage({ runId }: { runId?: string }) {
  const station = useQuery(stationQuery);
  const attention = useQuery(operationAttentionQuery);
  const [queueRepo, setQueueRepo] = useState("");
  const [queueKind, setQueueKind] = useState("");
  const [showAllQueue, setShowAllQueue] = useState(false);
  const crew = useQuery(crewQuery);
  const repos = useQuery(reposQuery);
  const drafts = useQuery(tasksQuery(["draft"]));
  const missions = useQuery(missionsQuery);
  const navigate = useNavigate();
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const select = useCallback(
    (id: string | null) => {
      navigate({ to: "/", search: id ? { run: id } : {}, replace: true });
      rows.current.get(id ?? "")?.scrollIntoView({ block: "nearest" });
    },
    [navigate],
  );
  const decisions = station.data?.decisions ?? [];
  const recent = station.data?.recent ?? [];
  const ordered = [...decisions, ...recent];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      if (e.key === "Escape" && runId) {
        select(null);
        return;
      }
      if (!ordered.length) return;
      const at = ordered.findIndex((r) => r.id === runId);
      if (e.key === "j" || e.key === "ArrowDown") select(ordered[Math.min(ordered.length - 1, at + 1)]?.id ?? null);
      else if (e.key === "k" || e.key === "ArrowUp") select(ordered[Math.max(0, at - 1)]?.id ?? null);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const questions = drafts.data ?? [];
  const setupHolds = station.data?.queue.filter((entry) => entry.kind === "setup") ?? [];
  const needsYou = decisions.length + questions.length + setupHolds.length + (attention.data?.total ?? 0);
  const active = crew.data?.active.length ?? 0;
  const queue = station.data?.queue ?? [];
  const filteredQueue = queue.filter(
    (entry) => (!queueRepo || entry.repoName === queueRepo) && (!queueKind || entry.kind === queueKind),
  );

  return (
    <div className={clsx("mx-auto grid max-w-[1440px]", runId && "lg:grid-cols-[minmax(0,1fr)_minmax(420px,560px)]")}>
      <section className={clsx("min-w-0 px-4 pt-8 pb-24 sm:px-8 lg:pt-12", runId && "hidden lg:block")}>
        <div className="mx-auto grid max-w-[980px] gap-8">
          <header className="grid gap-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="t-eyebrow inline-flex items-center gap-2">
                <Signal className="size-3.5" /> Your station
              </span>
              <Link
                to="/agents"
                className="inline-flex items-center gap-2 rounded-full bg-dawn px-4 py-2 font-medium text-[13px] text-on-dawn"
              >
                <Plus className="size-3.5" /> Dispatch work
              </Link>
            </div>
            <h1 className="t-h1">
              {!station.data || !drafts.data || !attention.data || station.error || drafts.error || attention.error
                ? "Your station."
                : needsYou
                  ? `${needsYou} ${needsYou === 1 ? "decision needs" : "decisions need"} you.`
                  : active
                    ? "Your crew is moving."
                    : "Ready when you are."}
            </h1>
            <p className="max-w-[620px] text-[14px] text-muted leading-relaxed">
              Set the direction, inspect the evidence, and decide how far your crew can go.
            </p>
            <CrewSummary />
            <Link to="/operations" className="text-[13px] text-dawn">
              Delivery, setup & activity →
            </Link>
          </header>

          {station.error && (
            <p role="alert" className="rounded-xl bg-surface p-4 text-bad">
              Couldn't load the Station. {station.error.message}{" "}
              <button type="button" onClick={() => station.refetch()} className="underline">
                Try again
              </button>
            </p>
          )}
          <div className="grid grid-cols-3 gap-3">
            <Metric
              label="Need you"
              value={
                station.isPending ||
                drafts.isPending ||
                attention.isPending ||
                station.error ||
                drafts.error ||
                attention.error
                  ? "—"
                  : needsYou
              }
              tone="text-dawn"
            />
            <Metric label="Working" value={crew.data ? active : "—"} />
            <Metric label="In the queue" value={station.data ? queue.length : "—"} />
          </div>

          {repos.data?.length === 0 && (
            <div className="grid gap-2 rounded-2xl bg-surface p-5 ring-1 ring-line">
              <h2 className="t-h3">Give your crew a place to work.</h2>
              <p className="text-[13.5px] text-muted">
                Add a local repository, choose its autonomy level, and dispatch your first task.
              </p>
              <Link to="/settings" className="mt-1 inline-flex items-center gap-1 text-[13px] text-dawn">
                Add a repository <ArrowRight className="size-3.5" />
              </Link>
            </div>
          )}

          <section className="grid gap-3" aria-label="Missions">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="t-h3">Missions</h2>
              <Link to="/missions" className="text-[13px] text-dawn">
                {missions.data?.length ? "All missions" : "Create a mission"} →
              </Link>
            </div>
            {missions.error && (
              <p role="alert" className="text-[13px] text-bad">
                Couldn't load missions. {missions.error.message}
              </p>
            )}
            {missions.data?.length === 0 && (
              <p className="text-[13px] text-muted">
                Group related tasks around an objective and control their departures together.
              </p>
            )}
            <div className="grid gap-3 xl:grid-cols-2">
              {missions.data?.slice(0, 4).map((mission) => (
                <MissionCard key={mission.id} mission={mission} />
              ))}
            </div>
          </section>

          <section className="grid gap-3" aria-labelledby="station-decisions">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="station-decisions" className="t-h3">
                Decisions
              </h2>
              <span className="text-[12px] text-muted">Unresolved work from every day</span>
            </div>
            {drafts.error && (
              <p role="alert" className="text-[13px] text-bad">
                Couldn't load tasks awaiting your input. {drafts.error.message}
              </p>
            )}
            {attention.error && (
              <p role="alert" className="text-[13px] text-bad">
                Couldn’t load operation attention. {attention.error.message}
              </p>
            )}
            {attention.data?.jobs.slice(0, 3).map((job) => (
              <AttentionCard key={job.id} job={job} />
            ))}
            {!!attention.data?.total && (
              <Link to="/operations" hash="attention" className="text-[13px] text-dawn">
                Review {attention.data.total} operations needing attention →
              </Link>
            )}
            {questions.map((task) => (
              <Link
                key={task.id}
                to="/task/$taskId"
                params={{ taskId: task.id }}
                className="grid gap-2 rounded-2xl bg-surface p-5 ring-1 ring-line hover:ring-dawn/50"
              >
                <span className="inline-flex items-center gap-2 text-[12px] text-dawn">
                  <CircleHelp className="size-3.5" />{" "}
                  {task.question ? "Answer before dispatch" : "Brief ready to review"} · {task.repoName}
                </span>
                <span className="font-medium">{task.title}</span>
                <span className="text-[13px] text-muted">
                  {task.question ?? "Review the scope and acceptance criteria, then queue this task."}
                </span>
              </Link>
            ))}
            {setupHolds.map((entry) => (
              <Link
                key={entry.taskId}
                to="/task/$taskId"
                params={{ taskId: entry.taskId }}
                className="grid gap-2 rounded-2xl bg-surface p-5 ring-1 ring-line hover:ring-dawn/50"
              >
                <span className="text-[12px] text-dawn">Setup needed · {entry.repoName}</span>
                <span className="font-medium">{entry.title}</span>
                <span className="text-[13px] text-muted">{entry.reason}</span>
                <span className="text-[12px] text-dawn">Open departure checks →</span>
              </Link>
            ))}
            {station.isPending && <p className="rounded-2xl bg-surface p-5 text-muted">Loading decisions…</p>}
            {decisions.map((run) => (
              <DecisionCard
                key={run.id}
                run={run}
                selected={run.id === runId}
                onSelect={() => select(run.id)}
                buttonRef={(el) => {
                  if (el) rows.current.set(run.id, el);
                  else rows.current.delete(run.id);
                }}
              />
            ))}
            {station.data &&
              drafts.data &&
              attention.data &&
              !station.error &&
              !drafts.error &&
              !attention.error &&
              needsYou === 0 && (
                <div className="flex items-start gap-3 rounded-2xl border border-line border-dashed p-5">
                  <CheckCheck className="mt-0.5 size-5 shrink-0 text-ok" />
                  <div className="grid gap-1">
                    <p className="font-medium text-[14px]">No decisions waiting.</p>
                    <p className="text-[13px] text-muted">
                      The crew will bring you work that needs your judgement here.
                    </p>
                  </div>
                </div>
              )}
          </section>

          {active > 0 && (
            <section className="grid gap-3">
              <h2 className="t-h3">Crew at work</h2>
              <AgentBoard compact={Boolean(runId)} />
            </section>
          )}

          <TrainCards onOpen={select} />
          <PromotionBanners onToast={toast} />

          {queue.length > 0 && (
            <section className="grid gap-3" aria-label="Next departures">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="t-h3">Next departures</h2>
                <Link to="/agents" className="inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-fg">
                  Manage queue <ArrowRight className="size-3" />
                </Link>
              </div>
              <div className="flex flex-wrap gap-3">
                <Select
                  aria-label="Departure repository"
                  value={queueRepo}
                  onChange={(e) => {
                    setQueueRepo(e.target.value);
                    setShowAllQueue(false);
                  }}
                >
                  <option value="">All repositories</option>
                  {[...new Set([...queue.map((entry) => entry.repoName), ...(queueRepo ? [queueRepo] : [])])]
                    .sort()
                    .map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                </Select>
                <Select
                  aria-label="Departure reason"
                  value={queueKind}
                  onChange={(e) => {
                    setQueueKind(e.target.value);
                    setShowAllQueue(false);
                  }}
                >
                  <option value="">All departure reasons</option>
                  {[...new Set([...queue.map((entry) => entry.kind), ...(queueKind ? [queueKind] : [])])]
                    .sort()
                    .map((kind) => (
                      <option key={kind} value={kind}>
                        {kind.charAt(0).toUpperCase() + kind.slice(1)}
                      </option>
                    ))}
                </Select>
              </div>
              <p className="text-[12px] text-muted">
                {filteredQueue.length} of {queue.length} queued tasks match these filters.
              </p>
              <div className="divide-y divide-line overflow-hidden rounded-2xl bg-surface ring-1 ring-line">
                {filteredQueue.slice(0, showAllQueue ? filteredQueue.length : 6).map((entry) => (
                  <Link
                    key={entry.taskId}
                    to="/task/$taskId"
                    params={{ taskId: entry.taskId }}
                    className="grid gap-1.5 px-5 py-4 hover:bg-raised"
                  >
                    <span className="flex items-center gap-2 font-mono text-[11px] text-muted">
                      <TrainFront className="size-3.5" />
                      {entry.repoName}
                      <span
                        className={entry.kind === "dependency" || entry.kind === "budget" ? "text-dawn" : "text-muted"}
                      >
                        ·{" "}
                        {entry.kind === "ready"
                          ? "Ready"
                          : entry.kind === "dependency"
                            ? "Dependency"
                            : entry.kind.charAt(0).toUpperCase() + entry.kind.slice(1)}
                      </span>
                    </span>
                    <span className="font-medium text-[14px]">{entry.title}</span>
                    <span className="text-[12.5px] text-muted">
                      {entry.reason}
                      {entry.runAt && entry.kind === "scheduled"
                        ? ` ${new Date(entry.runAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`
                        : ""}
                    </span>
                  </Link>
                ))}
              </div>
              {!filteredQueue.length && <p className="text-[13px] text-muted">No queued tasks match these filters.</p>}
              {filteredQueue.length > 6 && (
                <div>
                  <Button variant="ghost" onClick={() => setShowAllQueue(!showAllQueue)}>
                    {showAllQueue ? "Show fewer departures" : `Show all ${filteredQueue.length} matching departures`}
                  </Button>
                </div>
              )}
            </section>
          )}

          {repos.data && repos.data.length > 0 && (
            <section className="grid gap-3">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="t-h3">Routes & authority</h2>
                <Link to="/settings" className="text-[12.5px] text-muted hover:text-fg">
                  Configure
                </Link>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {repos.data.map((repo) => (
                  <Link
                    key={repo.id}
                    to="/settings"
                    className="grid gap-2 rounded-xl bg-surface p-4 ring-1 ring-line hover:bg-raised"
                  >
                    <span className="inline-flex items-center gap-2 text-[13px] font-medium">
                      <Route className="size-3.5 text-dawn" />
                      {repo.name}
                    </span>
                    <span className="text-[12.5px] text-muted">
                      {AUTONOMY_LABEL[repo.level]} ·{" "}
                      {repo.level === "ship"
                        ? `May merge to ${repo.shipBranch ?? "a configured branch"}`
                        : repo.level === "propose"
                          ? "Stops after planning"
                          : "You make the merge decision"}
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          )}

          <section className="grid gap-3">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="t-h3">Recent outcomes</h2>
              <Link to="/history" className="inline-flex items-center gap-1.5 text-[12.5px] text-muted hover:text-fg">
                <History className="size-3.5" /> Daily reports
              </Link>
            </div>
            {recent.length > 0 ? (
              <div className="divide-y divide-line overflow-hidden rounded-2xl bg-surface ring-1 ring-line">
                {recent.map((run) => (
                  <RunRow
                    key={run.id}
                    ref={(el) => {
                      if (el) rows.current.set(run.id, el);
                      else rows.current.delete(run.id);
                    }}
                    run={run}
                    selected={run.id === runId}
                    highlighted={false}
                    onSelect={() => select(run.id)}
                    onHover={() => {}}
                  />
                ))}
              </div>
            ) : (
              <p className="text-[13px] text-muted">Completed and resolved work will appear here.</p>
            )}
          </section>
          <p className="flex items-center gap-2 text-[12px] text-faint">
            <Kbd>J</Kbd>
            <Kbd>K</Kbd> Move between decisions and outcomes. <Kbd>Esc</Kbd> Close.
          </p>
        </div>
      </section>
      {runId && (
        <div className="lg:sticky lg:top-14 lg:h-[calc(100dvh-3.5rem)] lg:border-line lg:border-l">
          <div className="h-[calc(100dvh-3.5rem)] lg:h-full">
            <RunPane runId={runId} onClose={() => select(null)} onToast={toast} />
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, tone = "text-fg" }: { label: string; value: number | string; tone?: string }) {
  return (
    <div className="grid gap-2 rounded-2xl bg-surface p-4 ring-1 ring-line sm:p-5">
      <span className={clsx("font-mono text-[28px] tabular", tone)}>{value}</span>
      <span className="text-[12px] text-muted">{label}</span>
    </div>
  );
}

function DecisionCard({
  run,
  selected,
  onSelect,
  buttonRef,
}: {
  run: Run;
  selected: boolean;
  onSelect: () => void;
  buttonRef: (el: HTMLButtonElement | null) => void;
}) {
  const decision = decisionFor(run);
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={clsx(
        "grid w-full gap-2 rounded-2xl bg-surface p-5 text-left ring-1 transition-colors hover:bg-raised",
        selected ? "ring-dawn" : "ring-line",
      )}
    >
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
        <span className={run.bucket === "failed" ? "text-bad" : "text-dawn"}>{decision.label}</span>
        <span className="font-mono text-muted">
          {run.repo} · {run.nightId}
        </span>
      </span>
      <span className="font-medium text-[16px] tracking-[-0.015em]">{run.title}</span>
      <span className="line-clamp-2 text-[13px] text-muted leading-relaxed">{decision.reason}</span>
      <span className="text-[12px] text-muted">{decision.action}</span>
      <span className="mt-1 inline-flex items-center gap-1.5 text-[12px] text-dawn">
        {run.artifactKinds.includes("evidence") ? "Inspect evidence" : "Inspect result"}{" "}
        <ArrowRight className="size-3" />
      </span>
    </button>
  );
}
