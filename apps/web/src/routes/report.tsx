import {
  BUCKET_LABEL,
  BUCKET_ORDER,
  formatDuration,
  formatTokens,
  greeting,
  nightIdFor,
  type Run,
  summarize,
} from "@nightcrew/core";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { clsx } from "clsx";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, crewQuery, reportQuery, toast } from "../api";
import { AgentBoard } from "../components/agent-board";
import { Horizon } from "../components/horizon";
import { RunPane } from "../components/run-pane";
import { RunRow } from "../components/run-row";
import { PromotionBanners, TrainCards } from "../components/trust";
import { Kbd } from "../components/ui";
import { BUCKET_COLOR, fmtDay, fmtWeekday, isTypingTarget } from "../lib";

export function ReportPage({ nightId, runId }: { nightId?: string; runId?: string }) {
  const navigate = useNavigate();
  const { data, isPending, error } = useQuery(reportQuery(nightId));
  const [hovered, setHovered] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  const ordered = useMemo(() => {
    if (!data) return [] as Run[];
    return BUCKET_ORDER.flatMap((b) => data.runs.filter((r) => r.status !== "running" && r.bucket === b));
  }, [data]);

  const select = useCallback(
    (id: string | null) => {
      navigate({ to: ".", search: id ? { run: id } : {}, replace: true });
      if (id) rowRefs.current.get(id)?.scrollIntoView({ block: "nearest" });
    },
    [navigate],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target) || ordered.length === 0) return;
      const i = runId ? ordered.findIndex((r) => r.id === runId) : -1;
      if (e.key === "j" || e.key === "ArrowDown") select(ordered[Math.min(ordered.length - 1, i + 1)]?.id ?? null);
      else if (e.key === "k" || e.key === "ArrowUp") select(ordered[Math.max(0, i - 1)]?.id ?? null);
      else if (e.key === "Escape" && runId) select(null);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ordered, runId, select]);

  if (isPending) return <ReportSkeleton />;
  if (error instanceof ApiError && error.status === 404) return <EmptyState />;
  if (error || !data) return <p className="p-10 text-bad">{error?.message ?? "Something went wrong."}</p>;

  // Agents still working appear under "Working now", not in the buckets or the greeting.
  const finished = data.runs.filter((r) => r.status !== "running");
  const summary = summarize(finished);
  const lastEnd = data.runs.reduce<string | null>((m, r) => (r.endedAt && (!m || r.endedAt > m) ? r.endedAt : m), null);

  return (
    <div className={clsx("mx-auto grid max-w-[1440px]", runId && "lg:grid-cols-[minmax(0,1fr)_minmax(420px,560px)]")}>
      <section className={clsx("min-w-0 px-4 pt-8 pb-24 sm:px-8 lg:pt-12", runId && "hidden lg:block")}>
        <div className="mx-auto grid max-w-[820px] gap-7">
          <header className="grid gap-4">
            <div className="flex items-center gap-1 font-mono text-[12px] text-muted">
              <NightLink nightId={data.previousId} label="Previous night">
                <ChevronLeft className="size-3.5" />
              </NightLink>
              <span className="px-1 tabular">{dayLabel(data.night.id, lastEnd ?? data.night.startedAt)}</span>
              <NightLink nightId={data.nextId} label="Next night">
                <ChevronRight className="size-3.5" />
              </NightLink>
            </div>
            <h1 className="t-h1">
              <TwoTone
                text={
                  data.nextId
                    ? greeting(summary).replace(/^Good \w+\./, `${fmtWeekday(lastEnd ?? data.night.startedAt)}.`)
                    : greeting(summary)
                }
              />
            </h1>
            <p className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-[12.5px] text-muted tabular">
              <span>
                <b className="font-medium text-fg">{summary.total}</b> {summary.total === 1 ? "task" : "tasks"}
              </span>
              <span>
                <b className="font-medium text-fg">{summary.prs}</b> {summary.prs === 1 ? "PR" : "PRs"}
              </span>
              <span>
                <b className="font-medium text-fg">{formatTokens(summary.tokens)}</b> tokens
              </span>
              {summary.unattendedMs > 0 && (
                <span>
                  <b className="font-medium text-fg">{formatDuration(summary.unattendedMs)}</b> unattended
                </span>
              )}
            </p>
            <Horizon
              runs={data.runs}
              nightId={data.night.id}
              selectedId={runId ?? null}
              hoveredId={hovered}
              onHover={setHovered}
              onSelect={select}
            />
          </header>

          {!data.nextId && <WorkingNow />}
          <PromotionBanners onToast={toast} />
          <TrainCards nightId={data.night.id} onOpen={select} />

          <div className="grid gap-7">
            {BUCKET_ORDER.map((bucket) => {
              const runs = finished.filter((r) => r.bucket === bucket);
              if (runs.length === 0) return null;
              return (
                <section key={bucket} aria-labelledby={`b-${bucket}`} className="grid gap-2.5">
                  <h2 id={`b-${bucket}`} className="flex items-center gap-2.5 font-medium text-[13px]">
                    <span className="size-2 rounded-full" style={{ background: BUCKET_COLOR[bucket] }} />
                    {BUCKET_LABEL[bucket]}
                    <span className="font-mono text-[12px] text-faint">{runs.length}</span>
                  </h2>
                  <div className="divide-y divide-line overflow-hidden rounded-2xl bg-surface ring-1 ring-line">
                    {runs.map((r) => (
                      <RunRow
                        key={r.id}
                        ref={(el) => {
                          if (el) rowRefs.current.set(r.id, el);
                          else rowRefs.current.delete(r.id);
                        }}
                        run={r}
                        selected={r.id === runId}
                        highlighted={r.id === hovered}
                        onSelect={() => select(r.id)}
                        onHover={(h) => setHovered(h ? r.id : null)}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>

          <p className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-faint">
            <span className="inline-flex items-center gap-1.5">
              <Kbd>J</Kbd>
              <Kbd>K</Kbd> move
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Kbd>1</Kbd> merge
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Kbd>2</Kbd> send back
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Kbd>3</Kbd> dismiss
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Kbd>H</Kbd> run again
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Kbd>U</Kbd> undo
            </span>
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

function NightLink({ nightId, label, children }: { nightId: string | null; label: string; children: React.ReactNode }) {
  const cls = "grid size-6 place-items-center rounded-md transition-colors";
  if (!nightId) return <span className={clsx(cls, "text-faint/50")}>{children}</span>;
  return (
    <Link
      to="/night/$nightId"
      params={{ nightId }}
      aria-label={label}
      title={label}
      className={clsx(cls, "hover:bg-raised hover:text-fg")}
    >
      {children}
    </Link>
  );
}

function ReportSkeleton() {
  return (
    <div className="mx-auto grid max-w-[820px] gap-6 px-4 pt-12 sm:px-8">
      <div className="h-4 w-28 rounded bg-raised" />
      <div className="h-12 w-3/4 rounded-lg bg-raised" />
      <div className="h-1 w-full rounded bg-raised" />
      <div className="h-48 rounded-2xl bg-surface ring-1 ring-line" />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mx-auto grid max-w-[620px] gap-5 px-4 pt-24 sm:px-8">
      <h1 className="t-h1">
        Nothing yet. <span className="text-faint">Your agents report here.</span>
      </h1>
      <p className="text-[15px] text-muted leading-relaxed">
        Send work to your agents and their reports land here as they finish: what shipped, what needs you, and the
        evidence for each.
      </p>
      <div>
        <Link
          to="/agents"
          className="inline-flex h-9 items-center gap-2 rounded-full bg-dawn px-4 font-medium text-[13.5px] text-on-dawn"
        >
          Give the agents work
        </Link>
      </div>
      <p className="text-[13px] text-faint">
        Used the classic runner? Import its history with{" "}
        <span className="font-mono">nightcrew import --classic ~/path/to/nightcrew</span>
      </p>
    </div>
  );
}

/** "Good morning." in faint ink, the result in full ink. */
function TwoTone({ text }: { text: string }) {
  const m = text.match(/^([^.]+\.)\s*(.*)$/);
  if (!m) return <>{text}</>;
  return (
    <>
      <span className="text-faint">{m[1]}</span> {m[2]}
    </>
  );
}

/** "Today", "Yesterday", or the date. */
function dayLabel(dayId: string, fallbackIso: string): string {
  const today = nightIdFor(new Date().toISOString());
  if (dayId === today) return "Today";
  const y = new Date(`${today}T12:00:00`);
  y.setDate(y.getDate() - 1);
  if (dayId === y.toISOString().slice(0, 10)) return "Yesterday";
  return fmtDay(fallbackIso);
}

/** Agents still working, at the top of today's Inbox. */
function WorkingNow() {
  const crew = useQuery(crewQuery);
  const n = crew.data?.active.length ?? 0;
  if (!n) return null;
  return (
    <section className="grid gap-2.5">
      <h2 className="flex items-center gap-2.5 font-medium text-[13px]">
        <span className="size-2 animate-pulse rounded-full bg-dawn" />
        Working now
        <span className="font-mono text-[12px] text-faint">{n}</span>
      </h2>
      <AgentBoard compact />
    </section>
  );
}
