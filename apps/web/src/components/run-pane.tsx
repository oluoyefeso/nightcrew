import {
  type ArtifactKind,
  BUCKET_LABEL,
  formatCost,
  formatDuration,
  type Run,
  type TriageAction,
} from "@nightcrew/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { ArrowLeft, ExternalLink, GitBranch, GitPullRequest, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { api, runQuery, useTriage } from "../api";
import { BUCKET_COLOR, durationMs, fmtModel, fmtTime, fmtTokens, isTypingTarget } from "../lib";
import { EvidenceView, parseEvidence } from "./evidence";
import { Button, Chip, Kbd, Pill } from "./ui";

const TAB_LABEL: Record<ArtifactKind, string> = {
  evidence: "Evidence",
  plan: "Plan",
  decisions: "Decisions",
  review: "Review",
  tests: "Checks",
  report: "Report",
  log: "Logs",
};

export function RunPane({
  runId,
  onClose,
  onToast,
}: {
  runId: string;
  onClose: () => void;
  onToast: (msg: string) => void;
}) {
  const { data, isPending, error } = useQuery(runQuery(runId));
  const [tab, setTab] = useState<ArtifactKind | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the tab when the run changes
  useEffect(() => setTab(null), [runId]);

  if (isPending)
    return (
      <PaneFrame onClose={onClose}>
        <div className="p-6 text-muted">Loading…</div>
      </PaneFrame>
    );
  if (error || !data)
    return (
      <PaneFrame onClose={onClose}>
        <div className="p-6 text-bad">{error?.message ?? "Run not found."}</div>
      </PaneFrame>
    );

  const { run, artifacts, attempts } = data;
  const active = tab ?? artifacts[0]?.kind ?? null;
  const artifact = artifacts.find((a) => a.kind === active);
  const dur = durationMs(run.startedAt, run.endedAt);

  return (
    <PaneFrame onClose={onClose}>
      <div className="grid gap-5 px-6 pt-5 pb-6 [&>*]:min-w-0">
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Pill color={BUCKET_COLOR[run.bucket]}>{BUCKET_LABEL[run.bucket]}</Pill>
            <span className="font-mono text-[11.5px] text-faint">
              {run.repo} · {fmtTime(run.startedAt)}
              {dur ? ` · ${formatDuration(dur)}` : ""}
            </span>
          </div>
          <h2 className="t-h3 text-balance">{run.title}</h2>
          <div className="flex flex-wrap items-center gap-1.5">
            {run.branch && (
              <Chip title="Branch">
                <GitBranch className="size-3 text-faint" />
                {run.branch}
              </Chip>
            )}
            {run.prUrl && (
              <a href={run.prUrl} target="_blank" rel="noreferrer" className="group">
                <Chip className="transition-colors group-hover:bg-[color-mix(in_srgb,var(--raised)_70%,var(--fg)_8%)]">
                  <GitPullRequest className="size-3 text-faint" />#{run.prNumber}
                  {run.prState && <span className="text-faint">{run.prState}</span>}
                  <ExternalLink className="size-3 text-faint" />
                </Chip>
              </a>
            )}
            {run.additions != null && (
              <Chip>
                <span className="text-ok">+{run.additions}</span>
                <span className="text-bad">−{run.deletions}</span>
                <span className="text-faint">· {run.changedFiles} files</span>
              </Chip>
            )}
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-line ring-1 ring-line sm:grid-cols-4">
          <Stat label="Cost" value={formatCost(run.costCents)} />
          <Stat label="Confidence" value={run.confidence === null ? "—" : `${Math.round(run.confidence * 100)}%`} />
          <Stat label="Model" value={fmtModel(run.model)} />
          <Stat label="Tokens" value={`${fmtTokens(run.tokensIn)} in · ${fmtTokens(run.tokensOut)} out`} />
        </dl>

        {run.shipSha && (
          <Callout
            tone={run.undoneAt ? "dawn" : "ok"}
            label={run.undoneAt ? "Shipped, then undone" : `Shipped to ${run.shipBranch}`}
          >
            {run.undoneAt
              ? `You undid this. NightCrew reverted ${run.shipSha.slice(0, 7)} on ${run.shipBranch}.`
              : `The crew merged this into ${run.shipBranch} itself (${run.shipSha.slice(0, 7)}) because the evidence, the Skeptic and the ship rules all agreed. Press U to undo.`}
          </Callout>
        )}
        {run.trainId && !run.shipSha && (
          <Callout label="On tonight's train">
            This task is merged into the nightly train with the night's other work and tested together. You merge the
            train's one PR, or press 3 to take this task off it.
          </Callout>
        )}

        {run.status !== "complete" && run.reason && (
          <Callout tone="bad" label="Why it stopped">
            {run.reason}
          </Callout>
        )}
        {run.summary && <Callout label="Crew note">{run.summary}</Callout>}
        {run.note && (
          <Callout tone="dawn" label="Your note">
            {run.note}
          </Callout>
        )}

        {attempts.length > 1 && (
          <div className="grid gap-2">
            <h3 className="font-mono text-[11px] text-faint uppercase tracking-[0.08em]">Attempts</h3>
            <ol className="grid gap-1.5">
              {attempts.map((a, i) => (
                <li key={a.id} className="flex items-baseline gap-3 text-[13px]">
                  <span className="w-14 shrink-0 font-mono text-[11.5px] text-faint">
                    #{i + 1} {fmtTime(a.startedAt)}
                  </span>
                  <span className={clsx(a.status === "complete" ? "text-fg" : "text-muted")}>
                    {a.status === "complete" ? "Completed" : a.status === "failed" ? "Failed" : a.status}
                    {a.reason && a.status !== "complete" ? ` · ${a.reason}` : ""}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {artifacts.length > 0 && (
          <div className="grid gap-3">
            <div role="tablist" className="flex gap-1 border-line border-b">
              {artifacts.map((a) => (
                <button
                  key={a.kind}
                  type="button"
                  role="tab"
                  aria-selected={a.kind === active}
                  onClick={() => setTab(a.kind)}
                  className={clsx(
                    "-mb-px border-b-2 px-2.5 pt-1 pb-2 text-[13px] transition-colors",
                    a.kind === active ? "border-dawn text-fg" : "border-transparent text-muted hover:text-fg",
                  )}
                >
                  {TAB_LABEL[a.kind]}
                </button>
              ))}
            </div>
            {artifact?.kind === "evidence" ? (
              (() => {
                const ev = parseEvidence(artifact.content);
                return ev ? <EvidenceView runId={run.id} evidence={ev} /> : null;
              })()
            ) : artifact ? (
              <div className="prose-nc">
                <Markdown>{artifact.content}</Markdown>
              </div>
            ) : null}
          </div>
        )}
      </div>
      <TriageBar run={run} onToast={onToast} />
    </PaneFrame>
  );
}

function PaneFrame({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <aside className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex h-11 shrink-0 items-center justify-between border-line border-b px-4">
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center gap-1.5 text-[12.5px] text-muted hover:text-fg lg:hidden"
        >
          <ArrowLeft className="size-3.5" /> Back
        </button>
        <span className="hidden items-center gap-1.5 text-[12px] text-faint lg:inline-flex">
          <Kbd>J</Kbd>
          <Kbd>K</Kbd> to move
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="grid size-7 place-items-center rounded-full text-muted hover:bg-raised hover:text-fg"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">{children}</div>
    </aside>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5 bg-surface px-3.5 py-2.5">
      <dt className="text-[11.5px] text-faint">{label}</dt>
      <dd className="truncate font-mono text-[12.5px] tabular">{value}</dd>
    </div>
  );
}

function Callout({
  label,
  children,
  tone,
}: {
  label: string;
  children: React.ReactNode;
  tone?: "bad" | "dawn" | "ok";
}) {
  return (
    <div
      className="grid gap-1 rounded-xl px-4 py-3"
      style={{
        background: tone ? `color-mix(in srgb, var(--${tone}) 9%, var(--surface))` : "var(--raised)",
      }}
    >
      <span
        className="font-mono text-[11px] uppercase tracking-[0.08em]"
        style={{ color: tone ? `var(--${tone})` : "var(--faint)" }}
      >
        {label}
      </span>
      <p className="text-[13.5px] leading-relaxed">{children}</p>
    </div>
  );
}

/** One-key triage. Merge asks for a second press; send back asks for a note. */
function TriageBar({ run, onToast }: { run: Run; onToast: (msg: string) => void }) {
  const triage = useTriage();
  const [armed, setArmed] = useState(false);
  const [composing, setComposing] = useState(false);
  const [note, setNote] = useState("");
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const canMerge = Boolean(run.prUrl) && (run.bucket === "ready" || run.bucket === "eyes");
  const shipped = Boolean(run.shipSha && !run.undoneAt);
  const onTrain = Boolean(run.trainId && !run.shipSha && run.triage !== "close" && run.triage !== "send_back");
  // A merged PR can't be taken back from here; a ship can (it's reverted on the ship branch).
  const canUndo = shipped || (run.triage !== null && run.triage !== "merge");
  const qc = useQueryClient();
  const unship = useMutation({
    mutationFn: () => api.post<{ demoted: boolean }>(`/api/runs/${encodeURIComponent(run.id)}/unship`),
    onSuccess: (r) => {
      onToast(r.demoted ? "Undone. The repo goes back to the nightly train for now." : "Undone.");
      qc.invalidateQueries({ queryKey: ["run", run.id] });
      qc.invalidateQueries({ queryKey: ["report"] });
    },
    onError: (e) => onToast(e.message),
  });
  const pull = useMutation({
    mutationFn: () => api.post(`/api/runs/${encodeURIComponent(run.id)}/pull`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["trains"] });
    },
    onError: (e) => onToast(e.message),
  });
  const undo = () => (shipped ? unship.mutate() : act("undo", "Undone."));
  const dismiss = () => {
    if (onTrain) pull.mutate(undefined, { onSuccess: () => act("close", "Taken off the train.") });
    else act("close", "Dismissed.");
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the run changes
  useEffect(() => {
    setArmed(false);
    setComposing(false);
    setNote("");
  }, [run.id]);

  useEffect(() => {
    if (composing) noteRef.current?.focus();
  }, [composing]);

  const act = (action: TriageAction, message: string, withNote?: string) => {
    triage.mutate(
      { id: run.id, action, note: withNote },
      {
        onSuccess: () => onToast(message),
        onError: (e) => onToast(e.message),
      },
    );
  };

  const merge = () => {
    if (!canMerge) return;
    if (!armed) {
      setArmed(true);
      clearTimeout(armTimer.current);
      armTimer.current = setTimeout(() => setArmed(false), 3500);
      return;
    }
    setArmed(false);
    act("merge", `Merged #${run.prNumber}.`);
  };

  const sendBack = () => {
    if (!note.trim()) return;
    if (onTrain) pull.mutate();
    act("send_back", "Sent back. It goes into tonight's queue with your note.", note);
    setComposing(false);
    setNote("");
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === "1") merge();
      else if (k === "2") setComposing(true);
      else if (k === "3" && run.bucket !== "failed" && !shipped) dismiss();
      else if (k === "h") act("tonight", "Queued to try again tonight.");
      else if (k === "u" && canUndo) undo();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (composing) {
    return (
      <div className="shrink-0 border-line border-t bg-surface p-4">
        <label htmlFor="sendback-note" className="mb-2 block font-medium text-[13px]">
          What should the crew do differently?
        </label>
        <textarea
          id="sendback-note"
          ref={noteRef}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) sendBack();
            if (e.key === "Escape") setComposing(false);
          }}
          rows={3}
          placeholder="Use the existing pagination helper instead of a new one."
          className="w-full resize-none rounded-xl bg-bg px-3.5 py-2.5 text-[13.5px] outline-none ring-1 ring-line placeholder:text-faint focus:ring-dawn/60"
        />
        <div className="mt-2.5 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setComposing(false)} kbd="Esc">
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={sendBack} disabled={!note.trim() || triage.isPending} kbd="⌘↵">
            Send back
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-line border-t bg-surface px-4 py-3">
      {canMerge && (
        <Button variant="primary" onClick={merge} disabled={triage.isPending} kbd="1">
          {armed ? `Press 1 again to merge #${run.prNumber}` : "Merge"}
        </Button>
      )}
      {run.bucket !== "back" && (
        <Button onClick={() => setComposing(true)} kbd="2">
          Send back
        </Button>
      )}
      {run.bucket !== "failed" && run.bucket !== "shipped" && (
        <Button variant="ghost" onClick={dismiss} kbd="3">
          {onTrain ? "Take off the train" : "Dismiss"}
        </Button>
      )}
      {(run.bucket === "failed" || run.bucket === "eyes") && (
        <Button variant="ghost" onClick={() => act("tonight", "Queued to try again tonight.")} kbd="H">
          Try again tonight
        </Button>
      )}
      {canUndo && (
        <Button variant={shipped ? "secondary" : "ghost"} onClick={undo} disabled={unship.isPending} kbd="U">
          {shipped ? (unship.isPending ? "Reverting…" : `Undo ship to ${run.shipBranch}`) : "Undo"}
        </Button>
      )}
    </div>
  );
}
