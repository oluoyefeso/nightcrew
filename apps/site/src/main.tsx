import "../../web/src/styles.css";
import "./site.css";
import { formatTokens } from "@nightcrew/core";
import { clsx } from "clsx";
import { Check, Copy, Moon, Sun } from "lucide-react";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { StationExample } from "./station-example";

const REPO = "https://github.com/oluoyefeso/nightcrew";
const INSTALL = "curl -fsSL https://raw.githubusercontent.com/oluoyefeso/nightcrew/main/install.sh | sh";

// ── The replay ──────────────────────────────────────────────────────────────
// An example day in the daily report design. The first three tasks
// and their token counts are real runs from building NightCrew (October 2026); the
// last two are illustrative, priced inside the range those runs measured.

type Bucket = "shipped" | "ready" | "eyes" | "failed";
const DAY: { at: number; title: string; note: string; bucket: Bucket; tokens: number; diff: string }[] = [
  {
    at: 0.09,
    title: "Add widgetCount helper",
    note: "Counts widgets with a non-blank title; 2 new tests pass.",
    bucket: "ready",
    tokens: 99_220,
    diff: "+17 −1",
  },
  {
    at: 0.21,
    title: "Add widgetTitles helper with test",
    note: "Maps each widget through widgetLabel; empty list returns [].",
    bucket: "shipped",
    tokens: 123_135,
    diff: "+18 −1",
  },
  {
    at: 0.38,
    title: "Dark mode that follows the system",
    note: "CSS variables with a prefers-color-scheme override. 4 screenshots, no new a11y issues.",
    bucket: "ready",
    tokens: 98_522,
    diff: "+5 −2",
  },
  {
    at: 0.57,
    title: "Fix the crash when a widget has no title",
    note: "New test fails on main and passes on the fix.",
    bucket: "eyes",
    tokens: 112_000,
    diff: "+12 −3",
  },
  {
    at: 0.78,
    title: "Detect 429s in JSON output, not just stderr",
    note: "Backoff now uses the 5/10/20 minute schedule. Skeptic: 6 challenges, 0 held.",
    bucket: "shipped",
    tokens: 131_000,
    diff: "+41 −6",
  },
];
const COLOR: Record<Bucket, string> = {
  shipped: "var(--ok)",
  ready: "var(--sky)",
  eyes: "var(--dawn)",
  failed: "var(--bad)",
};
const LABEL: Record<Bucket, string> = {
  shipped: "Shipped",
  ready: "Ready to merge",
  eyes: "Needs your eyes",
  failed: "Failed",
};

function useReplay(durationMs = 7000) {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setT(1);
      return;
    }
    let raf = 0;
    let start = 0;
    let hold: ReturnType<typeof setTimeout> | undefined;
    const loop = (now: number) => {
      if (!start) start = now;
      const p = Math.min(1, (now - start) / durationMs);
      setT(p);
      if (p < 1) raf = requestAnimationFrame(loop);
      else
        hold = setTimeout(() => {
          start = 0;
          raf = requestAnimationFrame(loop);
        }, 6000);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(hold);
    };
  }, [durationMs]);
  return t;
}

function Replay() {
  const t = useReplay();
  const done = DAY.filter((n) => n.at <= t);
  const shipped = done.filter((n) => n.bucket === "shipped").length;
  const needYou = done.filter((n) => n.bucket === "ready" || n.bucket === "eyes").length;
  const tokens = done.reduce((s, n) => s + n.tokens, 0);
  const clock = 9 * 60 + Math.round(t * 9 * 60);
  const hh = String(Math.floor(clock / 60) % 24).padStart(2, "0");
  const mm = String(clock % 60).padStart(2, "0");
  const morning = t >= 1; // every agent has reported

  return (
    <div className="overflow-hidden rounded-[18px] bg-surface text-left shadow-[var(--shadow)] ring-1 ring-line">
      <div className="flex items-center justify-between gap-3 border-line border-b px-4 py-2.5">
        <div className="flex gap-1 text-[12px]">
          <span className="whitespace-nowrap rounded-md bg-raised px-2 py-1">History</span>
          <span className="hidden px-2 py-1 text-muted sm:inline">Agents</span>
          <span className="hidden px-2 py-1 text-muted sm:inline">Later</span>
        </div>
        <span className="flex items-center gap-2 whitespace-nowrap font-mono text-[11px] text-muted tabular">
          <span className={clsx("size-1.5 rounded-full", morning ? "bg-ok" : "animate-pulse bg-dawn")} />
          {morning ? "18:00" : `${hh}:${mm}`}
          <span className="hidden sm:inline">
            · {morning ? "all agents reported" : `${Math.max(1, Math.min(3, DAY.length - done.length))} agents working`}
          </span>
        </span>
      </div>
      <div className="grid gap-4 px-5 pt-6 pb-5 sm:px-7">
        <div className="min-h-[2.3em] font-medium text-[24px] leading-[1.12] tracking-[-0.03em] sm:text-[30px]">
          {morning ? (
            <>
              <span className="text-faint">Good afternoon.</span> {shipped === 2 ? "Two" : shipped} shipped and{" "}
              {needYou === 3 ? "three" : needYou} need you.
            </>
          ) : (
            <span className="text-muted">Agents are working…</span>
          )}
        </div>
        <p className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11.5px] text-muted tabular">
          <span>
            <b className="font-medium text-fg">{done.length}</b> tasks
          </span>
          <span>
            <b className="font-medium text-fg">{formatTokens(tokens)}</b> tokens
          </span>
          <span>
            <b className="font-medium text-fg">0</b> files outside scope
          </span>
        </p>
        <div className="relative pt-2 pb-1">
          <div className="relative h-6">
            <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-raised" />
            <div
              className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full"
              style={{
                background:
                  "linear-gradient(90deg, var(--horizon-from) 0%, var(--horizon-from) 34%, var(--dawn-soft) 86%, var(--dawn) 100%)",
                clipPath: `inset(0 ${(1 - t) * 100}% 0 0 round 4px)`,
              }}
            />
            {done.map((n) => (
              <span
                key={n.title}
                className="nc-tick absolute top-0 h-6 w-[3px] -translate-x-1/2 rounded-full"
                style={{ left: `${n.at * 100}%`, background: COLOR[n.bucket], boxShadow: "0 0 0 2px var(--surface)" }}
              />
            ))}
          </div>
          <div className="mt-1.5 flex justify-between font-mono text-[11px] text-muted tabular">
            <span>09:00</span>
            <span>12:00</span>
            <span>15:00</span>
            <span>18:00</span>
          </div>
        </div>
        <div className="divide-y divide-line overflow-hidden rounded-xl ring-1 ring-line">
          {DAY.map((n) => {
            const visible = n.at <= t;
            return (
              <div
                key={n.title}
                className={clsx(
                  "grid grid-cols-[3px_minmax(0,1fr)_auto] items-center gap-3 py-2.5 pr-3.5 transition-[opacity,transform] duration-500",
                  visible ? "opacity-100" : "translate-y-1 opacity-0",
                )}
              >
                <span className="h-full rounded-r-full" style={{ background: COLOR[n.bucket] }} />
                <span className="grid min-w-0 gap-0.5">
                  <span className="truncate font-medium text-[13px]">{n.title}</span>
                  <span className="truncate text-[11.5px] text-muted">{n.note}</span>
                </span>
                <span className="flex items-center gap-3 font-mono text-[11px] text-muted tabular">
                  <span className="hidden sm:inline" style={{ color: COLOR[n.bucket] }}>
                    {LABEL[n.bucket]}
                  </span>
                  <span>{formatTokens(n.tokens)}</span>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function InstallButton({ large }: { large?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {}
  };
  return (
    <button
      type="button"
      onClick={copy}
      className={clsx(
        "group inline-flex max-w-full items-center gap-3 rounded-full bg-fg font-mono text-bg transition-transform active:scale-[0.99]",
        large ? "px-6 py-3.5 text-[13px]" : "px-5 py-3 text-[12px]",
      )}
      aria-label="Copy the install command"
    >
      <span className="text-bg/50">$</span>
      <span className="truncate">{copied ? "Copied. Paste it into a terminal." : "curl -fsSL …/install.sh | sh"}</span>
      {copied ? (
        <Check className="size-3.5 shrink-0" />
      ) : (
        <Copy className="size-3.5 shrink-0 opacity-60 group-hover:opacity-100" />
      )}
    </button>
  );
}

function currentTheme(): "light" | "dark" {
  const set = document.documentElement.dataset.theme;
  if (set === "light" || set === "dark") return set;
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

const NAV = [
  ["#how", "How it works"],
  ["#station", "Station"],
  ["#evidence", "Evidence"],
  ["#trust", "Trust"],
  ["#tokens", "Tokens"],
] as const;

/** Nav links and ghost buttons: Aster's 38px pill, ink at 72%, a faint tint on hover. */
const NAV_LINK =
  "h-[38px] items-center rounded-full px-[13px] font-medium text-[14px] text-[color-mix(in_srgb,var(--fg)_72%,transparent)] transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--fg)_6%,transparent)] hover:text-fg";

/** Always-visible Light / Dark switch. Stays in sync if a host frame changes the theme. */
function ThemeSwitch() {
  const [theme, setTheme] = useState(currentTheme);
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setTheme(currentTheme());
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    const media = matchMedia("(prefers-color-scheme: light)");
    media.addEventListener("change", sync);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", sync);
    };
  }, []);
  const choose = (t: "light" | "dark") => {
    document.documentElement.dataset.theme = t;
    setTheme(t);
  };
  return (
    <div role="radiogroup" aria-label="Theme" className="flex rounded-full bg-bg p-[3px] ring-1 ring-line">
      {(
        [
          ["light", "Light", Sun],
          ["dark", "Dark", Moon],
        ] as const
      ).map(([value, label, Icon]) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          aria-label={label}
          title={label}
          onClick={() => choose(value)}
          className={clsx(
            "grid size-8 place-items-center rounded-full transition-colors",
            theme === value ? "bg-fg text-bg" : "text-muted hover:text-fg",
          )}
        >
          <Icon className="size-4" />
        </button>
      ))}
    </div>
  );
}

function H2({ claim, rest }: { claim: string; rest: string }) {
  return (
    <h2 className="t-h1 max-w-[860px]">
      {claim} <span className="text-faint">{rest}</span>
    </h2>
  );
}

function Eyebrow({ children }: { children: string }) {
  return <p className="t-eyebrow">{children}</p>;
}

/** Section wrapper. Content is always visible: no scroll-triggered hiding, so screenshots, link previews and crawlers see the whole page. */
function Reveal({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={className}>{children}</div>;
}

// ── Page ────────────────────────────────────────────────────────────────────

function Site() {
  return (
    <div className="min-h-full">
      <main id="top">
        <section className="nc-hero relative mx-2 mt-2 overflow-hidden rounded-[28px] bg-surface ring-1 ring-line sm:mx-3 sm:mt-3 sm:rounded-[32px]">
          <header className="z-10">
            <nav className="mx-auto flex max-w-[1120px] items-center px-5 py-[22px]">
              <a href="#top" className="flex items-center gap-2.5 font-semibold text-[16px] tracking-[-0.02em]">
                <svg viewBox="0 0 32 32" className="size-6" aria-hidden="true">
                  <clipPath id="m">
                    <circle cx="16" cy="16" r="15" />
                  </clipPath>
                  <g clipPath="url(#m)">
                    <rect width="32" height="32" fill="var(--horizon-from)" />
                    <rect y="17" width="32" height="15" fill="var(--dawn)" />
                  </g>
                </svg>
                NightCrew
              </a>
              <div className="ml-[34px] hidden items-center gap-1 md:flex">
                {NAV.map(([href, label]) => (
                  <a key={href} href={href} className={clsx(NAV_LINK, "inline-flex")}>
                    {label}
                  </a>
                ))}
              </div>
              <div className="ml-auto flex items-center gap-2">
                <a href={REPO} className={clsx(NAV_LINK, "hidden sm:inline-flex")}>
                  GitHub
                </a>
                <ThemeSwitch />
                <a
                  href="#start"
                  className="inline-flex h-10 items-center whitespace-nowrap rounded-full bg-dawn px-4 sm:px-[18px] font-medium text-[14px] text-on-dawn transition-transform duration-150 hover:brightness-[1.06] active:scale-[0.96]"
                >
                  Get started
                </a>
              </div>
            </nav>
          </header>
          <div className="mx-auto grid max-w-[1120px] justify-items-center gap-14 px-5 pt-12 pb-16 text-center sm:pt-20">
            <div className="grid max-w-[860px] justify-items-center gap-6">
              <Eyebrow>Open source · runs on your machine</Eyebrow>
              <h1 className="t-display">
                Dispatch the work. <span className="text-faint">Judge the evidence.</span>
              </h1>
              <p className="t-lede max-w-[560px]">
                NightCrew is your conductor's station for coding agents. Dispatch work, set the crew's authority, and
                inspect the evidence. Group related tasks into missions across your repos and see the decisions that
                need you, day or night.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-3" id="start">
                <InstallButton />
                <a
                  href={REPO}
                  className="rounded-full px-4 py-3 text-[13.5px] text-muted ring-1 ring-line hover:text-fg"
                >
                  Read the code
                </a>
              </div>
              <p className="font-mono text-[12px] text-faint">
                A small task, end to end: <span className="text-fg">~100k tokens</span> · measured, not estimated
              </p>
            </div>
            <div className="grid w-full max-w-[920px] gap-2.5">
              <Replay />
              <p className="text-center font-mono text-[11px] text-faint">An example day in the daily report</p>
            </div>
          </div>
        </section>

        <section id="how" className="mx-auto grid max-w-[1120px] gap-10 px-5 py-24 [&>*]:min-w-0">
          <Reveal className="grid gap-4">
            <Eyebrow>How it works</Eyebrow>
            <H2
              claim="You run the crew."
              rest="Agents do the work, inside your guardrails, and report back with proof."
            />
          </Reveal>
          <Reveal>
            <div className="grid gap-px overflow-hidden rounded-[18px] bg-line ring-1 ring-line md:grid-cols-3">
              {[
                [
                  "Any time · Dispatch",
                  "Tell the crew",
                  "Give the crew an objective. Group tasks into a mission, describe the work in plain English, or pull in GitHub issues. Departure checks surface missing setup, prerequisites, possible scope overlap and available budget before an agent starts.",
                ],
                [
                  "In parallel · Agents work",
                  "Inside guardrails",
                  "Several agents at once, each in its own clone of the repo and an isolated, sandboxed Claude session, within your per-repo limits and daily budget. Every tool call passes a guard: no pushes, no secrets, nothing outside scope.",
                ],
                [
                  "As they finish · Report back",
                  "Judge the evidence",
                  "The Station keeps unresolved decisions visible across days. Decision briefs explain stop reasons, missing evidence and next steps. Your repo settings decide whether the crew stops at a plan, opens a PR, joins a train, or merges to dev.",
                ],
              ].map(([time, title, body]) => (
                <div key={title} className="grid content-start gap-3 bg-surface p-7">
                  <span className="font-mono text-[12px] text-dawn">{time}</span>
                  <h3 className="font-medium text-[22px] leading-tight tracking-[-0.025em]">{title}</h3>
                  <p className="text-[14.5px] text-muted leading-relaxed">{body}</p>
                </div>
              ))}
            </div>
          </Reveal>
        </section>

        <section id="station" className="mx-auto grid max-w-[1120px] gap-10 px-5 py-24 [&>*]:min-w-0">
          <Reveal className="grid gap-4">
            <Eyebrow>Your conductor's station</Eyebrow>
            <H2
              claim="Keep the objective in view."
              rest="See what is moving, what is held and what needs your judgement."
            />
            <p className="max-w-[700px] text-[15px] text-muted leading-relaxed">
              Missions connect work across repos with shared acceptance criteria, priorities and token limits. Recover
              saved work, verify the combined result, and follow delivery under the authority you choose.
            </p>
          </Reveal>
          <StationExample />
          <p className="text-[13px] text-muted">
            Available in the local open-source runner. Verification templates support up to three independent reviews.
            Merge authority and delivery authority are configured separately; managed mode remains coming soon.
          </p>
        </section>

        <section id="evidence" className="mx-auto grid max-w-[1120px] gap-10 px-5 py-24 [&>*]:min-w-0">
          <Reveal className="grid gap-4">
            <Eyebrow>Evidence, not claims</Eyebrow>
            <H2
              claim="It has to prove it."
              rest="NightCrew gathers the evidence itself, then a Skeptic tries to tear it down."
            />
          </Reveal>
          <Reveal>
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
              <figure className="grid gap-3 rounded-[18px] bg-surface p-5 ring-1 ring-line">
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <img
                      src="/evidence/before-dark.png"
                      alt="Before: the site ignores dark mode"
                      className="aspect-[16/10] w-full rounded-lg object-cover object-top ring-1 ring-line"
                    />
                    <span className="font-mono text-[11px] text-faint">Before · desktop · dark</span>
                  </div>
                  <div className="grid gap-1.5">
                    <img
                      src="/evidence/after-dark.png"
                      alt="After: dark background with readable cards"
                      className="aspect-[16/10] w-full rounded-lg object-cover object-top ring-1 ring-line"
                    />
                    <span className="font-mono text-[11px] text-dawn">After · 99.8% changed</span>
                  </div>
                </div>
                <figcaption className="text-[13px] text-muted">
                  A real UI task from testing NightCrew: an agent added system dark mode in 98k tokens. NightCrew
                  started the site on both branches and took these itself.
                </figcaption>
              </figure>
              <ul className="grid content-start gap-0 overflow-hidden rounded-[18px] ring-1 ring-line">
                {[
                  [
                    "UI changes",
                    "Before and after screenshots at desktop and mobile, light and dark, with a pixel diff, an accessibility scan and console errors.",
                  ],
                  [
                    "Bug fixes",
                    "A new test that fails on the base branch and passes on the fix. A test that passes either way is called out.",
                  ],
                  ["Every task", "Its own checks, independent of what the agent says: scope, tests, protected paths."],
                  [
                    "The Skeptic",
                    "A separate reviewer gets the evidence and has to make concrete challenges. Missing evidence always means a person looks.",
                  ],
                ].map(([k, v]) => (
                  <li key={k} className="grid gap-1 border-line border-b bg-surface px-5 py-4 last:border-b-0">
                    <b className="font-medium text-[14.5px]">{k}</b>
                    <span className="text-[14px] text-muted leading-relaxed">{v}</span>
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
        </section>

        <section id="trust" className="mx-auto grid max-w-[1120px] gap-10 px-5 py-24 [&>*]:min-w-0">
          <Reveal className="grid gap-4">
            <Eyebrow>The trust ladder</Eyebrow>
            <H2
              claim="Trust is earned per repo."
              rest="The record decides how far the work goes, and a revert moves it back."
            />
          </Reveal>
          <Reveal>
            <div className="grid items-end gap-2 md:grid-cols-5">
              {[
                ["Propose", "Plans only. No code.", 0],
                ["Draft PR", "One PR per task. You merge.", 1],
                [
                  "Daily train",
                  "The day's finished tasks merge into one branch, tested together. You merge one PR.",
                  2,
                ],
                [
                  "Ship to dev",
                  "The crew merges to dev itself when evidence, the Skeptic and your rules agree. Undo is one key.",
                  3,
                ],
                ["Never", "main, release branches, workflows, secrets. Always yours.", 3],
              ].map(([name, body, h], i) => (
                <div
                  key={name as string}
                  className={clsx(
                    "grid content-start gap-2 rounded-2xl p-5",
                    i === 4 ? "border border-line-strong border-dashed" : "bg-surface ring-1",
                    i === 3 ? "ring-[color-mix(in_srgb,var(--dawn)_55%,transparent)]" : i < 4 && "ring-line",
                  )}
                  style={{ minHeight: `${120 + (h as number) * 36}px` }}
                >
                  <span className="font-mono text-[11px] text-faint uppercase tracking-[0.08em]">
                    {i === 4 ? "Never" : `Level ${i}`}
                  </span>
                  <b className="font-medium text-[15px]">{name}</b>
                  <span className="text-[13px] text-muted leading-relaxed">{body}</span>
                </div>
              ))}
            </div>
          </Reveal>
          <Reveal>
            <pre className="overflow-x-auto rounded-2xl bg-surface p-5 font-mono text-[13px] leading-[1.8] text-muted ring-1 ring-line">
              <span className="text-fg">ship_to:</span> dev{"\n"}
              <span className="text-ok">allow_ship:</span> [src/components/**, docs/**]{"\n"}
              <span className="text-dawn">always_ask:</span> [migrations/**, src/auth/**, package.json]{"\n"}
              <span className="text-faint"># "8 of the last 10 tasks merged unchanged. Promote to Ship to dev?"</span>
            </pre>
          </Reveal>
        </section>

        <section id="tokens" className="mx-auto grid max-w-[1120px] gap-10 px-5 py-24 [&>*]:min-w-0">
          <Reveal className="grid gap-4">
            <Eyebrow>Tokens</Eyebrow>
            <H2
              claim="Lean on tokens."
              rest="Each agent runs in a clean, isolated harness with only the tools its task needs."
            />
          </Reveal>
          <Reveal>
            <div className="grid gap-px overflow-hidden rounded-[18px] bg-line ring-1 ring-line sm:grid-cols-3">
              {[
                ["~100k", "tokens for a small task, end to end: build, check, review, commit"],
                [
                  "20–40×",
                  "fewer tokens than the same task in a session that loads every skill, plugin and connector on the machine (2.3M–4.4M measured)",
                ],
                [
                  "20M",
                  "tokens a day by default. Agents wait rather than pass it, and every task has its own token cap.",
                ],
              ].map(([n, l]) => (
                <div key={n} className="grid gap-2 bg-surface p-7">
                  <span className="font-medium text-[44px] leading-none tracking-[-0.035em] tabular">{n}</span>
                  <span className="text-[14px] text-muted leading-relaxed">{l}</span>
                </div>
              ))}
            </div>
          </Reveal>
          <Reveal>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid gap-2 rounded-2xl bg-surface p-6 ring-1 ring-line">
                <b className="font-medium text-[15px]">Open source, on your machine</b>
                <p className="text-[14px] text-muted leading-relaxed">
                  One binary on your machine. The dashboard runs at localhost, the crew uses the Claude Agent SDK with
                  your own key or Claude Code login. You control the repos, evidence requirements, budgets, and merge
                  authority.
                </p>
              </div>
              <div className="grid gap-2 rounded-2xl bg-surface p-6 ring-1 ring-line">
                <b className="font-medium text-[15px]">Managed · Coming soon</b>
                <p className="text-[14px] text-muted leading-relaxed">
                  The local open-source runner is the core NightCrew experience. Managed mode is coming soon.
                </p>
              </div>
            </div>
          </Reveal>
        </section>

        <section className="mx-auto grid max-w-[1120px] justify-items-center gap-6 px-5 pt-16 pb-28 text-center">
          <h2 className="text-balance font-medium text-[40px] leading-[1.04] tracking-[-0.035em] sm:text-[64px]">
            Hand off the work. <span className="text-faint">Keep the judgement.</span>
          </h2>
          <InstallButton large />
          <p className="font-mono text-[12px] text-faint">macOS and Linux · needs git, gh and Claude Code</p>
        </section>
      </main>

      <footer className="border-line border-t">
        <div className="mx-auto flex max-w-[1120px] flex-wrap items-center justify-between gap-4 px-5 py-8 text-[13px] text-muted">
          <span>NightCrew · MIT licensed · powered by Claude</span>
          <div className="flex gap-5">
            <a href={REPO} className="hover:text-fg">
              GitHub
            </a>
            <a href={`${REPO}/blob/main/DESIGN.md`} className="hover:text-fg">
              Design
            </a>
            <a href={`${REPO}/blob/main/CHANGELOG.md`} className="hover:text-fg">
              Changelog
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <Site />
    </StrictMode>,
  );
