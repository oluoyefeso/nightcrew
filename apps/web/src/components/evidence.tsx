import { clsx } from "clsx";
import { Check, CircleAlert, X } from "lucide-react";
import { type ImgHTMLAttributes, useEffect, useState } from "react";
import { authFetch } from "../api";

interface Shot {
  path: string;
  viewport: "desktop" | "mobile";
  theme: "light" | "dark";
  before: string | null;
  after: string;
  diff: string | null;
  changedPct: number | null;
}

export interface Evidence {
  required: string[];
  screenshots: Shot[];
  a11y: {
    before: number | null;
    after: number;
    newIssues: { id: string; impact: string; help: string; count: number }[];
  } | null;
  consoleErrors: string[];
  testProof: { testFiles: string[]; failsOnBase: boolean | null; passesOnBranch: boolean; log: string } | null;
  missing: string[];
  notes: string[];
}

export function parseEvidence(content: string): Evidence | null {
  try {
    return JSON.parse(content) as Evidence;
  } catch {
    return null;
  }
}

type View = "after" | "before" | "diff";

/** The evidence card: what NightCrew checked itself, with the screenshots to prove it. */
export function EvidenceView({ runId, evidence }: { runId: string; evidence: Evidence }) {
  const [view, setView] = useState<View>("after");
  const [zoom, setZoom] = useState<Shot | null>(null);
  const file = (rel: string) =>
    `/api/runs/${encodeURIComponent(runId)}/files/${rel.split("/").map(encodeURIComponent).join("/")}`;
  const checks = evidenceChecks(evidence);
  const paths = [...new Set(evidence.screenshots.map((s) => s.path))];

  return (
    <div className="grid gap-5">
      <ul className="grid gap-0 overflow-hidden rounded-xl ring-1 ring-line">
        {checks.map((c) => (
          <li
            key={c.label}
            className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-baseline gap-3 border-line border-b px-4 py-2.5 text-[13.5px] last:border-b-0"
          >
            <span className="grid h-4 place-items-center">
              {c.ok === true ? (
                <Check className="size-3.5 text-ok" />
              ) : c.ok === false ? (
                <X className="size-3.5 text-bad" />
              ) : (
                <CircleAlert className="size-3.5 text-dawn" />
              )}
            </span>
            <span className="min-w-0">{c.label}</span>
            <span className="font-mono text-[11.5px] text-muted">{c.value}</span>
          </li>
        ))}
      </ul>

      {evidence.screenshots.length > 0 && (
        <div className="grid gap-3">
          <div className="flex items-center justify-between gap-3">
            <h4 className="font-medium text-[13px] text-muted">Screenshots</h4>
            <div role="radiogroup" aria-label="Show" className="flex rounded-full bg-raised p-0.5 text-[12px]">
              {(["after", "before", "diff"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={view === v}
                  onClick={() => setView(v)}
                  disabled={v !== "after" && !evidence.screenshots.some((s) => (v === "before" ? s.before : s.diff))}
                  className={clsx(
                    "rounded-full px-2.5 py-1 capitalize transition-colors disabled:opacity-40",
                    view === v ? "bg-surface text-fg shadow-sm" : "text-muted",
                  )}
                >
                  {v === "diff" ? "Changes" : v}
                </button>
              ))}
            </div>
          </div>
          {paths.map((path) => (
            <div key={path} className="grid gap-2">
              {paths.length > 1 && <span className="font-mono text-[11.5px] text-faint">{path}</span>}
              <div className="grid grid-cols-[2fr_1fr] gap-2">
                {(["desktop", "mobile"] as const).map((viewport) => (
                  <div key={viewport} className="grid gap-2">
                    {(["light", "dark"] as const).map((theme) => {
                      const s = evidence.screenshots.find(
                        (x) => x.path === path && x.viewport === viewport && x.theme === theme,
                      );
                      if (!s) return null;
                      const src = view === "before" ? s.before : view === "diff" ? s.diff : s.after;
                      return (
                        <button
                          key={theme}
                          type="button"
                          onClick={() => setZoom(s)}
                          className="group grid gap-1 text-left"
                        >
                          <div
                            className={clsx(
                              "overflow-hidden rounded-lg bg-sunken ring-1 ring-line transition-shadow group-hover:ring-line-strong",
                              viewport === "desktop" ? "aspect-[16/10]" : "aspect-[390/844] max-h-[220px]",
                            )}
                          >
                            {src ? (
                              <RunImage
                                src={file(src)}
                                alt={`${path} ${viewport} ${theme} ${view}`}
                                loading="lazy"
                                className="size-full object-cover object-top"
                              />
                            ) : (
                              <span className="grid size-full place-items-center text-[11px] text-faint">
                                No {view} shot
                              </span>
                            )}
                          </div>
                          <span className="flex justify-between font-mono text-[10.5px] text-faint">
                            <span>
                              {viewport} · {theme}
                            </span>
                            {s.changedPct !== null && (
                              <span className={s.changedPct > 0.05 ? "text-dawn" : ""}>{s.changedPct}% changed</span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {evidence.testProof?.log && (
        <details className="rounded-xl ring-1 ring-line">
          <summary className="cursor-pointer px-4 py-2.5 text-[13px] text-muted">Fail-then-pass output</summary>
          <pre className="overflow-x-auto border-line border-t px-4 py-3 font-mono text-[11.5px] leading-relaxed text-muted">
            {evidence.testProof.log}
          </pre>
        </details>
      )}

      {zoom && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-[color-mix(in_srgb,var(--bg)_80%,transparent)] p-6 backdrop-blur-sm"
          onClick={() => setZoom(null)}
          onKeyDown={(e) => e.key === "Escape" && setZoom(null)}
          role="dialog"
          aria-label="Screenshot"
        >
          <div
            className="grid max-h-full max-w-6xl gap-3 overflow-auto"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={() => {}}
          >
            <div className={clsx("grid gap-3", zoom.before ? "md:grid-cols-2" : "")}>
              {zoom.before && (
                <figure className="grid gap-1.5">
                  <RunImage src={file(zoom.before)} alt="Before" className="rounded-lg ring-1 ring-line" />
                  <figcaption className="font-mono text-[11px] text-muted">Before</figcaption>
                </figure>
              )}
              <figure className="grid gap-1.5">
                <RunImage src={file(zoom.after)} alt="After" className="rounded-lg ring-1 ring-line" />
                <figcaption className="font-mono text-[11px] text-muted">
                  After · {zoom.path} · {zoom.viewport} · {zoom.theme}
                </figcaption>
              </figure>
            </div>
            <button
              type="button"
              onClick={() => setZoom(null)}
              className="justify-self-center rounded-full bg-raised px-4 py-1.5 text-[12.5px]"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * A run's screenshot. The API wants the launch key in a header, which an
 * <img src> can't send, so fetch it and show it from a blob URL.
 */
function RunImage({ src, alt, ...rest }: ImgHTMLAttributes<HTMLImageElement> & { src: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    setUrl(null);
    void authFetch(src)
      .then((r) => (r.ok && r.headers.get("content-type")?.startsWith("image/") ? r.blob() : null))
      .then((b) => {
        if (!b || !live) return;
        made = URL.createObjectURL(b);
        setUrl(made);
      })
      .catch(() => {});
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [src]);
  return url ? <img src={url} alt={alt} {...rest} /> : <span role="img" aria-label={alt} className="block size-full" />;
}

export function evidenceChecks(e: Evidence): { label: string; value: string; ok: boolean | null }[] {
  const out: { label: string; value: string; ok: boolean | null }[] = [];
  if (e.testProof) {
    const p = e.testProof;
    out.push({
      label: "A new test fails on the base branch and passes on the fix",
      value: p.testFiles.length
        ? p.failsOnBase === true
          ? "proven"
          : p.failsOnBase === false
            ? "passes on base too"
            : "couldn't run"
        : "no test",
      ok: p.failsOnBase === true && p.passesOnBranch,
    });
  }
  if (e.screenshots.length || e.required.some((r) => r.startsWith("Screenshots"))) {
    out.push({
      label: "Screenshots: desktop and mobile, light and dark",
      value: `${e.screenshots.length} captured`,
      ok: e.screenshots.length >= 4,
    });
    const changed = e.screenshots.filter((s) => (s.changedPct ?? 0) > 0.05).length;
    if (e.screenshots.some((s) => s.before))
      out.push({
        label: "Visual change against the base branch",
        value: `${changed} of ${e.screenshots.length} views`,
        ok: null,
      });
  }
  if (e.a11y)
    out.push({
      label: "Accessibility scan",
      value: e.a11y.newIssues.length
        ? `${e.a11y.newIssues.length} new: ${e.a11y.newIssues.map((i) => i.id).join(", ")}`
        : "no new issues",
      ok: e.a11y.newIssues.length === 0,
    });
  if (e.screenshots.length)
    out.push({
      label: "Console errors on the new pages",
      value: e.consoleErrors.length ? `${e.consoleErrors.length}` : "none",
      ok: e.consoleErrors.length === 0,
    });
  for (const m of e.missing) out.push({ label: m, value: "missing", ok: false });
  return out;
}
