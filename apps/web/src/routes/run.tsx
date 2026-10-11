import { BUCKET_LABEL, formatDuration, formatTokens } from "@nightcrew/core";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { clsx } from "clsx";
import { ArrowLeft, Ban, Check, ChevronRight, CircleAlert, Terminal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { eventsQuery, type RunEvent, runQuery } from "../api";
import { Pill } from "../components/ui";
import { BUCKET_COLOR, durationMs, fmtTime } from "../lib";

const STEPS = [
  { key: "plan", label: "Plan" },
  { key: "implement", label: "Build" },
  { key: "validate", label: "Check" },
  { key: "review", label: "Review" },
  { key: "publish", label: "Publish" },
];

export function RunPage({ runId }: { runId: string }) {
  const run = useQuery({
    ...runQuery(runId),
    refetchInterval: (q) => (q.state.data?.run.status === "running" ? 5000 : false),
  });
  const events = useQuery({
    ...eventsQuery(runId),
    refetchInterval: run.data?.run.status === "running" ? 4000 : false,
  });
  const r = run.data?.run;
  const list = events.data ?? [];
  const live = r?.status === "running";

  const groups = useMemo(() => groupByPhase(list), [list]);
  const seen = new Set(
    list.filter((e) => e.kind === "phase").map((e) => (e.phase === "repair" ? "validate" : e.phase)),
  );
  const current = r?.phase === "repair" ? "validate" : r?.phase;

  const bottom = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when new events arrive
  useEffect(() => {
    if (live && follow) bottom.current?.scrollIntoView({ block: "end" });
  }, [list.length, live, follow]);

  if (run.error) return <p className="p-10 text-bad">{run.error.message}</p>;
  if (!r) return <div className="p-10 text-muted">Loading…</div>;

  return (
    <div className="mx-auto grid max-w-[920px] gap-7 px-4 pt-6 pb-28 sm:px-8 lg:pt-10">
      <Link
        to="/"
        search={{ run: r.id }}
        className="inline-flex w-fit items-center gap-1.5 text-[12.5px] text-muted hover:text-fg"
      >
        <ArrowLeft className="size-3.5" /> Station
      </Link>

      <header className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {live ? (
            <Pill color="var(--dawn)">Running</Pill>
          ) : (
            <Pill color={BUCKET_COLOR[r.bucket]}>{BUCKET_LABEL[r.bucket]}</Pill>
          )}
          <span className="font-mono text-[11.5px] text-faint">
            {r.repo} · started {fmtTime(r.startedAt)}
            {r.endedAt ? ` · took ${formatDuration(durationMs(r.startedAt, r.endedAt))}` : ""} ·{" "}
            {formatTokens(r.tokensIn + r.tokensOut)} tokens
          </span>
        </div>
        <h1 className="t-h2">{r.title}</h1>
        {r.taskId.startsWith("task_") && (
          <Link
            to="/task/$taskId"
            params={{ taskId: r.taskId }}
            className="w-fit text-[12.5px] text-muted hover:text-fg"
          >
            Open the task →
          </Link>
        )}
      </header>

      <ol className="grid grid-cols-5 gap-1.5" aria-label="Progress">
        {STEPS.map((s) => {
          const done = seen.has(s.key) && s.key !== current;
          const active = live && s.key === current;
          return (
            <li key={s.key} className="grid gap-2">
              <div
                className={clsx(
                  "h-1 rounded-full",
                  active ? "bg-dawn" : done ? "bg-[color-mix(in_srgb,var(--ok)_70%,transparent)]" : "bg-raised",
                )}
              >
                {active && <div className="h-full w-full animate-pulse rounded-full bg-dawn-soft/60" />}
              </div>
              <span className={clsx("font-mono text-[11px]", active ? "text-dawn" : done ? "text-fg" : "text-faint")}>
                {s.label}
              </span>
            </li>
          );
        })}
      </ol>

      {!live && r.reason && r.status !== "complete" && (
        <div className="grid gap-1 rounded-xl bg-[color-mix(in_srgb,var(--bad)_9%,var(--surface))] px-4 py-3">
          <span className="font-mono text-[11px] text-bad uppercase tracking-[0.08em]">Why it stopped</span>
          <p className="text-[13.5px]">{r.reason}</p>
        </div>
      )}
      {!live && r.summary && (
        <div className="grid gap-1 rounded-xl bg-raised px-4 py-3">
          <span className="font-mono text-[11px] text-faint uppercase tracking-[0.08em]">Crew note</span>
          <p className="text-[13.5px]">{r.summary}</p>
        </div>
      )}

      <section className="grid gap-2" onWheel={() => setFollow(false)}>
        <div className="flex items-center justify-between">
          <h2 className="font-medium text-[13px] text-muted">What the crew did</h2>
          {live && !follow && (
            <button type="button" onClick={() => setFollow(true)} className="text-[12px] text-dawn">
              Follow live
            </button>
          )}
        </div>
        {list.length === 0 ? (
          <p className="text-[13px] text-faint">
            {r.source === "classic"
              ? "Classic runs didn't record step-by-step activity. See the logs in the Station."
              : "No activity yet."}
          </p>
        ) : (
          <div className="overflow-hidden rounded-2xl bg-surface ring-1 ring-line">
            {groups.map((g, i) => (
              <PhaseGroup key={`${g.phase.id}`} group={g} open={i === groups.length - 1 || g.events.length < 14} />
            ))}
            <div ref={bottom} />
          </div>
        )}
      </section>
    </div>
  );
}

interface Group {
  phase: RunEvent;
  events: RunEvent[];
}

function groupByPhase(events: RunEvent[]): Group[] {
  const out: Group[] = [];
  for (const e of events) {
    if (e.kind === "phase" || out.length === 0) out.push({ phase: e, events: [] });
    else out.at(-1)?.events.push(e);
  }
  return out;
}

function PhaseGroup({ group, open: initiallyOpen }: { group: Group; open: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const tools = group.events.filter((e) => e.kind === "tool").length;
  return (
    <div className="border-line border-b last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left hover:bg-raised/50"
      >
        <ChevronRight className={clsx("size-3.5 text-faint transition-transform", open && "rotate-90")} />
        <span className="font-medium text-[13.5px]">{group.phase.text}</span>
        <span className="font-mono text-[11px] text-faint">
          {tools ? `${tools} steps · ` : ""}
          {fmtTime(group.phase.at)}
        </span>
      </button>
      {open && group.events.length > 0 && (
        <ul className="grid gap-px pb-2">
          {group.events.map((e) => (
            <EventLine key={e.id} e={e} />
          ))}
        </ul>
      )}
    </div>
  );
}

function EventLine({ e }: { e: RunEvent }) {
  const icon =
    e.kind === "denied" ? (
      <Ban className="size-3 text-bad" />
    ) : e.kind === "error" ? (
      <CircleAlert className="size-3 text-bad" />
    ) : e.kind === "result" ? (
      <Check className="size-3 text-ok" />
    ) : e.kind === "tool" ? (
      <Terminal className="size-3 text-faint" />
    ) : (
      <span className="size-1 rounded-full bg-faint" />
    );
  return (
    <li
      className={clsx(
        "grid grid-cols-[16px_minmax(0,1fr)] items-baseline gap-2 px-4 py-1 pl-10",
        e.kind === "text" && "py-1.5",
      )}
    >
      <span className="grid h-4 place-items-center">{icon}</span>
      <span
        className={clsx(
          "min-w-0 break-words",
          e.kind === "text" ? "text-[13.5px] leading-relaxed" : "font-mono text-[12px] text-muted",
          e.kind === "denied" && "text-bad",
          e.kind === "result" && "text-ok",
          e.kind === "error" && "text-bad",
        )}
      >
        {e.kind === "text" && e.text.length > 600 ? `${e.text.slice(0, 600)}…` : e.text}
      </span>
    </li>
  );
}
