import { horizonPosition, horizonWindow, nightIdFor, type Run } from "@nightcrew/core";
import { clsx } from "clsx";
import { BUCKET_COLOR, fmtTime } from "../lib";

/**
 * The Horizon: the day as a time axis, ink fading to dawn, with a tick for
 * each task at the moment it started, coloured by where it landed.
 */
export function Horizon({
  runs,
  nightId,
  selectedId,
  hoveredId,
  onHover,
  onSelect,
}: {
  runs: Run[];
  nightId: string;
  selectedId: string | null;
  hoveredId: string | null;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
}) {
  const now = new Date();
  const w = horizonWindow(runs, nightId, now);
  const nowPct = nightIdFor(now.toISOString()) === nightId ? horizonPosition(now.toISOString(), w) : null;
  const hours = Math.round((w.end.getTime() - w.start.getTime()) / 3_600_000);
  const step = hours > 6 ? 3 : 1;
  const labels: { pct: number; text: string }[] = [];
  for (let h = 0; h <= hours; h += step) {
    const t = new Date(w.start.getTime() + h * 3_600_000);
    labels.push({ pct: (h / hours) * 100, text: fmtTime(t.toISOString()) });
  }

  return (
    <div className="relative select-none pt-3 pb-1">
      <div className="relative h-7">
        <div
          className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full"
          style={{
            background:
              "linear-gradient(90deg, var(--horizon-from) 0%, var(--horizon-from) 34%, var(--dawn-soft) 86%, var(--dawn) 100%)",
          }}
        />
        {nowPct !== null && (
          <span
            className="absolute top-[-2px] bottom-[-2px] w-px bg-fg/50"
            style={{ left: `${nowPct}%` }}
            aria-hidden="true"
          >
            <span className="absolute -top-3 left-1/2 -translate-x-1/2 font-mono text-[9.5px] text-faint uppercase tracking-[0.08em]">
              now
            </span>
          </span>
        )}
        {runs.map((r) => {
          if (!r.startedAt) return null;
          const active = r.id === selectedId || r.id === hoveredId;
          const left = horizonPosition(r.startedAt, w);
          return (
            <button
              key={r.id}
              type="button"
              aria-label={`${fmtTime(r.startedAt)} · ${r.title}`}
              onMouseEnter={() => onHover(r.id)}
              onMouseLeave={() => onHover(null)}
              onFocus={() => onHover(r.id)}
              onBlur={() => onHover(null)}
              onClick={() => onSelect(r.id)}
              className="group absolute top-0 h-7 w-4 -translate-x-1/2"
              style={{ left: `${left}%` }}
            >
              <span
                className={clsx(
                  "absolute top-0.5 left-1/2 h-6 w-[3px] -translate-x-1/2 rounded-full transition-transform duration-150 ease-out",
                  active ? "scale-y-[1.3]" : "group-hover:scale-y-[1.3]",
                )}
                style={{ background: BUCKET_COLOR[r.bucket], boxShadow: "0 0 0 2px var(--bg)" }}
              />
              {r.id === hoveredId && (
                <span
                  className={clsx(
                    "pointer-events-none absolute bottom-full z-10 mb-1.5 whitespace-nowrap rounded-md bg-raised px-2 py-1 font-mono text-[11px] text-fg shadow-[var(--shadow)] ring-1 ring-line",
                    left > 70 ? "right-0" : left < 30 ? "left-0" : "left-1/2 -translate-x-1/2",
                  )}
                >
                  {fmtTime(r.startedAt)} · {r.title.length > 42 ? `${r.title.slice(0, 40)}…` : r.title}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="relative mt-1.5 h-4 font-mono text-[10.5px] text-faint tabular">
        {labels.map((l, i) => (
          <span
            key={l.pct}
            className="absolute"
            style={{
              left: `${l.pct}%`,
              transform: i === 0 ? "none" : i === labels.length - 1 ? "translateX(-100%)" : "translateX(-50%)",
            }}
          >
            {l.text}
          </span>
        ))}
      </div>
    </div>
  );
}
