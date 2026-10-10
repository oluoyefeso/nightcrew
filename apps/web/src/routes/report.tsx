import { BUCKET_LABEL, BUCKET_ORDER, formatCost, formatDuration, greeting, type Run, summarize } from "@nightcrew/core";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { clsx } from "clsx";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, reportQuery } from "../api";
import { Horizon } from "../components/horizon";
import { RunPane } from "../components/run-pane";
import { RunRow } from "../components/run-row";
import { Kbd } from "../components/ui";
import { BUCKET_COLOR, fmtDay, fmtWeekday, isTypingTarget } from "../lib";

export function ReportPage({ nightId, runId }: { nightId?: string; runId?: string }) {
  const navigate = useNavigate();
  const { data, isPending, error } = useQuery(reportQuery(nightId));
  const [hovered, setHovered] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  const ordered = useMemo(() => {
    if (!data) return [] as Run[];
    return BUCKET_ORDER.flatMap((b) => data.runs.filter((r) => r.bucket === b));
  }, [data]);

  const select = useCallback(
    (id: string | null) => {
      navigate({ to: ".", search: id ? { run: id } : {}, replace: true });
      if (id) rowRefs.current.get(id)?.scrollIntoView({ block: "nearest" });
    },
    [navigate],
  );

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

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

  const summary = summarize(data.runs);
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
              <span className="px-1 tabular">{fmtDay(lastEnd ?? data.night.startedAt)}</span>
              <NightLink nightId={data.nextId} label="Next night">
                <ChevronRight className="size-3.5" />
              </NightLink>
            </div>
            <h1 className="text-balance font-serif text-[34px] leading-[1.08] tracking-[-0.01em] sm:text-[44px]">
              {/* Only the latest night gets a greeting; older ones read as a dated record. */}
              {data.nextId
                ? greeting(summary).replace(/^Good \w+\./, `${fmtWeekday(lastEnd ?? data.night.startedAt)}.`)
                : greeting(summary)}
            </h1>
            <p className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-[12.5px] text-muted tabular">
              <span>
                <b className="font-medium text-fg">{summary.total}</b> {summary.total === 1 ? "task" : "tasks"}
              </span>
              <span>
                <b className="font-medium text-fg">{summary.prs}</b> {summary.prs === 1 ? "PR" : "PRs"}
              </span>
              <span>
                <b className="font-medium text-fg">{formatCost(summary.costCents)}</b> spent
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

          <div className="grid gap-7">
            {BUCKET_ORDER.map((bucket) => {
              const runs = data.runs.filter((r) => r.bucket === bucket);
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
              <Kbd>H</Kbd> try again tonight
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
            <RunPane runId={runId} onClose={() => select(null)} onToast={setToast} />
          </div>
        </div>
      )}

      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
        {toast && (
          <div className="pointer-events-auto rounded-full bg-fg px-4 py-2 text-[13px] text-bg shadow-[var(--shadow)] motion-safe:animate-[nc-rise_.24s_var(--ease-out-quint)]">
            {toast}
          </div>
        )}
      </div>
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
      <h1 className="font-serif text-[44px] leading-[1.05] tracking-[-0.01em]">No nights yet.</h1>
      <p className="text-[15px] text-muted leading-relaxed">
        Queue some work for tonight and the crew's results land here in the morning: what shipped, what needs you, and
        the evidence for each.
      </p>
      <div>
        <Link
          to="/tonight"
          className="inline-flex h-9 items-center gap-2 rounded-full bg-dawn px-4 font-medium text-[13.5px] text-on-dawn"
        >
          Plan tonight
        </Link>
      </div>
      <p className="text-[13px] text-faint">
        Used the classic runner? Import its history with{" "}
        <span className="font-mono">nightcrew import --classic ~/path/to/nightcrew</span>
      </p>
    </div>
  );
}
