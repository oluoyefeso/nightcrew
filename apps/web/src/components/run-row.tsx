import { formatCost, type Run } from "@nightcrew/core";
import { clsx } from "clsx";
import { RotateCw } from "lucide-react";
import { forwardRef } from "react";
import { BUCKET_COLOR, fmtTime } from "../lib";

export const RunRow = forwardRef<
  HTMLButtonElement,
  {
    run: Run;
    selected: boolean;
    highlighted: boolean;
    onSelect: () => void;
    onHover: (hovering: boolean) => void;
  }
>(function RunRow({ run, selected, highlighted, onSelect, onHover }, ref) {
  const note =
    run.bucket === "back" && run.note
      ? `You: ${run.note}`
      : run.status !== "complete"
        ? (run.reason ?? run.summary)
        : run.summary;
  return (
    <button
      ref={ref}
      type="button"
      onClick={onSelect}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      aria-current={selected || undefined}
      className={clsx(
        "group relative grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 py-3.5 pr-4 pl-5 text-left transition-colors duration-150",
        selected
          ? "bg-raised"
          : highlighted
            ? "bg-[color-mix(in_srgb,var(--raised)_60%,transparent)]"
            : "hover:bg-[color-mix(in_srgb,var(--raised)_60%,transparent)]",
      )}
    >
      <span
        className={clsx(
          "absolute inset-y-2 left-0 w-[3px] rounded-r-full transition-opacity",
          selected ? "opacity-100" : "opacity-70",
        )}
        style={{ background: BUCKET_COLOR[run.bucket] }}
      />
      <span className="grid min-w-0 gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-[14.5px] tracking-[-0.005em]">{run.title}</span>
          {run.attempt > 1 && (
            <span
              className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px] text-faint"
              title={`Attempt ${run.attempt}`}
            >
              <RotateCw className="size-3" />
              {run.attempt}
            </span>
          )}
        </span>
        {note && <span className="truncate text-[13px] text-muted">{note}</span>}
      </span>
      <span className="flex items-center gap-4 font-mono text-[12px] text-muted tabular">
        {run.prNumber && <span className="hidden text-faint md:inline">#{run.prNumber}</span>}
        {run.additions != null && (
          <span className="hidden sm:inline">
            <span className="text-ok">+{run.additions}</span> <span className="text-bad">−{run.deletions}</span>
          </span>
        )}
        <span>{formatCost(run.costCents)}</span>
        <span className="hidden text-faint lg:inline">{fmtTime(run.startedAt)}</span>
      </span>
    </button>
  );
});
