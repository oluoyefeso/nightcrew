import { formatTokens } from "@nightcrew/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { clsx } from "clsx";
import { ArrowUpRight, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { type ActiveAgent, api, crewQuery, toast } from "../api";

export const PHASES = [
  { key: "plan", label: "Plan" },
  { key: "implement", label: "Build" },
  { key: "validate", label: "Check" },
  { key: "review", label: "Review" },
  { key: "publish", label: "Land" },
];

const PHASE_LABEL: Record<string, string> = {
  setup: "Setting up",
  plan: "Planning",
  implement: "Building",
  validate: "Checking",
  repair: "Repairing",
  evidence: "Gathering evidence",
  review: "Reviewing",
  publish: "Landing",
  research: "Researching",
};

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function elapsed(from: string, now: number) {
  const s = Math.max(0, Math.round((now - new Date(from).getTime()) / 1000));
  const m = Math.floor(s / 60);
  return m ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

/** Every agent working right now, as a card. */
export function AgentBoard({ compact }: { compact?: boolean }) {
  const crew = useQuery(crewQuery);
  const active = crew.data?.active ?? [];
  if (!active.length) return null;
  return (
    <div className={clsx("grid gap-3", !compact && active.length > 1 && "md:grid-cols-2")}>
      {active.map((a) => (
        <AgentCard key={a.taskId} agent={a} compact={compact} />
      ))}
    </div>
  );
}

function AgentCard({ agent, compact }: { agent: ActiveAgent; compact?: boolean }) {
  const now = useNow();
  const stop = useMutation({
    mutationFn: () => api.post(`/api/crew/stop/${agent.taskId}`),
    onSuccess: () => toast(`Stopping "${agent.title}". Its work so far stays on its branch.`),
  });
  const phase =
    agent.phase === "repair" || agent.phase === "evidence"
      ? agent.phase === "repair"
        ? "validate"
        : "review"
      : agent.phase;
  const idx = PHASES.findIndex((p) => p.key === phase);
  return (
    <article className="relative grid gap-3 overflow-hidden rounded-2xl bg-surface p-4 ring-1 ring-[color-mix(in_srgb,var(--dawn)_30%,transparent)]">
      <div className="absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-raised">
        <div className="h-full w-1/3 animate-[nc-sweep_2.4s_ease-in-out_infinite] bg-dawn" />
      </div>
      <div className="flex items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <span className="flex items-center gap-2 font-mono text-[11px] text-muted">
            <span className="size-1.5 animate-pulse rounded-full bg-dawn" />
            {PHASE_LABEL[agent.phase ?? ""] ?? "Working"} · {agent.repoName} · {elapsed(agent.startedAt, now)}
          </span>
          <span className="truncate font-medium text-[15px] tracking-[-0.015em]">{agent.title}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {agent.runId && (
            <Link
              to="/run/$runId"
              params={{ runId: agent.runId }}
              className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] text-muted hover:bg-raised hover:text-fg"
            >
              Watch <ArrowUpRight className="size-3" />
            </Link>
          )}
          <button
            type="button"
            onClick={() => stop.mutate()}
            disabled={stop.isPending}
            title="Stop this agent"
            aria-label={`Stop ${agent.title}`}
            className="grid size-7 place-items-center rounded-full text-faint hover:bg-[color-mix(in_srgb,var(--bad)_14%,transparent)] hover:text-bad"
          >
            <Square className="size-3" />
          </button>
        </div>
      </div>
      {!compact && (
        <ol className="grid grid-cols-5 gap-1" aria-label="Progress">
          {PHASES.map((p, i) => (
            <li key={p.key} className="grid gap-1">
              <span
                className={clsx(
                  "h-1 rounded-full",
                  i < idx ? "bg-[color-mix(in_srgb,var(--ok)_70%,transparent)]" : i === idx ? "bg-dawn" : "bg-raised",
                )}
              />
              <span
                className={clsx(
                  "font-mono text-[10px]",
                  i === idx ? "text-dawn" : i < idx ? "text-muted" : "text-faint",
                )}
              >
                {p.label}
              </span>
            </li>
          ))}
        </ol>
      )}
      {agent.lastEvent && <p className="truncate font-mono text-[11.5px] text-faint">{agent.lastEvent}</p>}
    </article>
  );
}

/** "2 working · 3 queued · 1.2M of 20M tokens today", plus Pause/Resume. */
export function CrewSummary() {
  const qc = useQueryClient();
  const crew = useQuery(crewQuery);
  const s = crew.data;
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["crew"] });
    qc.invalidateQueries({ queryKey: ["station"] });
  };
  const pause = useMutation({
    mutationFn: () => api.post("/api/crew/pause"),
    onSuccess: refresh,
    onError: (e) => toast(e.message),
  });
  const resume = useMutation({
    mutationFn: () => api.post("/api/crew/resume"),
    onSuccess: refresh,
    onError: (e) => toast(e.message),
  });
  if (!s) return null;
  const pct = Math.min(100, (s.tokensToday / s.dailyTokenBudget) * 100);
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
      <div className="grid gap-2">
        <p className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[12.5px] text-muted tabular">
          <span>
            <b className="font-medium text-fg">{s.active.length + (s.coordinating ?? 0)}</b>/{s.maxAgents} working
          </span>
          <span>
            <b className="font-medium text-fg">{s.queued}</b> queued
          </span>
          {s.scheduled > 0 && (
            <span>
              <b className="font-medium text-fg">{s.scheduled}</b> scheduled
              {s.nextAt
                ? ` (next ${new Date(s.nextAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })})`
                : ""}
            </span>
          )}
          <span>
            <b className="font-medium text-fg">{formatTokens(s.tokensToday)}</b> of {formatTokens(s.dailyTokenBudget)}{" "}
            tokens accounted today
          </span>
        </p>
        <div className="h-1 w-56 max-w-full overflow-hidden rounded-full bg-raised">
          {/* Clip a full-width bar instead of scaling it, so the rounded end keeps its shape at low values. */}
          <div
            className="h-full w-full rounded-full bg-dawn transition-[clip-path] duration-200 ease-out motion-reduce:transition-none"
            style={{ clipPath: `inset(0 ${100 - pct}% 0 0 round 999px)` }}
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        {s.state === "paused" ? (
          <button
            type="button"
            onClick={() => resume.mutate()}
            disabled={resume.isPending}
            className="inline-flex h-8 items-center gap-2 rounded-full bg-dawn px-3.5 font-medium text-[13px] text-on-dawn"
          >
            Resume dispatch
          </button>
        ) : (
          <button
            type="button"
            onClick={() => pause.mutate()}
            disabled={pause.isPending}
            className="inline-flex h-8 items-center gap-2 rounded-full px-3.5 text-[13px] text-muted ring-1 ring-line hover:text-fg"
            title="Running agents finish; nothing new starts"
          >
            Pause dispatch
          </button>
        )}
      </div>
      {s.message && <p className="w-full text-[12.5px] text-faint">{s.message}</p>}
    </div>
  );
}
