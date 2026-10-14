# NightCrew Design System: "The hour before sunrise"

NightCrew is a conductor's station: you set direction and authority, dispatch work, and resolve the decisions agents bring back, at any hour. The interface should feel calm while agents are busy, and fast when it's time to decide. Neutral charcoal with one warm dawn accent. Restraint does the work: one accent colour, one typeface, mono for every number.

Railway already owns the violet night sky. NightCrew sits at dawn instead. Never use violet or indigo.

The tokens live in `apps/web/src/styles.css`. This file explains how to use them.

## Goals and evidence

The local edition starts with an objective, explicit task planning and human-attested acceptance. The interface brings the goal, decisions and evidence together while keeping execution detail reachable.

- **Keep ordinary use simple.** Home and Goals are the primary destinations. Reveal naming, scheduling and resource controls when needed. Keep pause state and authority understandable.
- **Make delegation inspectable.** Start with the outcome and concise rationale; let the person open checks, previews, changes and execution details. Distinguish verified results, unresolved assumptions and failed attempts.
- **Use sources purposefully.** Link an article or concept when it materially supports a decision. Evidence from the actual work establishes whether it succeeded.
- **Use concrete visual references.** [Linear](https://linear.app/) and its [agent presentation](https://linear.app/ai) inform the type hierarchy, compact navigation, quiet dividers, restrained surfaces and product demonstrations. Check both themes and mobile layouts.

Existing mission records, URLs and API names remain compatible with goal language in the interface. The [product status](docs/roadmap.md) describes current capabilities and limits.

## Themes

Both themes are first-class. The app follows the system setting by default; More → Theme overrides it.

| Token | Night (dark) | Morning (light) | Use |
|---|---|---|---|
| `bg` | `#101012` | `#FAFAFA` | Page |
| `surface` | `#171719` | `#FFFFFF` | Cards, panes |
| `raised` | `#232326` | `#EDEDF0` | Hover, selected, chips |
| `line` | ink at 9% | ink at 10% | Hairlines |
| `fg` | `#F0F0F2` | `#19191D` | Text |
| `muted` | `#A0A0A8` | `#64646F` | Secondary text |
| `faint` | `#81818B` | `#767681` | Labels, timestamps, the second half of two-tone headings, at 12px and up |
| `dawn` | `#F2A65A` | `#B65A12` | The accent: primary buttons, focus, active tab |
| `ok` / `bad` / `sky` | green / red / blue | darker variants | Semantic state only |

`faint` is too light to read at small sizes, so labels and timestamps under 12px use `muted` instead.

Semantic colours mark state (shipped, failed, ready) and are never decoration. `dawn` also means "needs your eyes".

## Type

One family, Inter (variable), following the restrained hierarchy of the Linear reference: weight 500 for headings, tracking that tightens as size grows, and two-tone headings where the elaboration sits in `--faint` at the same size ("Good morning." faint, "Two shipped and three need you." ink).

| Role | Class | Size | Weight | Tracking |
|---|---|---|---|---|
| Display (landing hero) | `t-display` | 72px (40px on phones) | 500 | −0.04em |
| Page and section heads, the greeting | `t-h1` | 46px (30px) | 500 | −0.03em |
| Task and run titles | `t-h2` | 32px (24px) | 500 | −0.025em |
| Card titles | `t-h3` | 19px | 500 | −0.02em |
| Lede | `t-lede` | 18px / 1.6 | 400 | −0.011em |
| Body and UI | none | 14px (13px secondary) | 400 / 500 | −0.011em |
| Eyebrow | `t-eyebrow` | 12px mono, uppercase | 400 | +0.08em, in `--dawn` |

Mono is the system stack (SF Mono, then Menlo and others) for anything that changes: token counts, times, SHAs, PR numbers, logs. Always use `tabular-nums`, and no negative tracking.

## The Horizon

The signature element. A 4px band across the top of the Inbox covering the hours around the day's work, fading from ink to dawn; today's ends a little after a "now" marker. Each task is a tick at the moment it started, coloured by where it landed. Hover a tick to see the task; click it to open it. Don't use the gradient anywhere else.

## Theme switching

The theme control in More has three states: Match system, Night and Morning. The selected one is an inverted pill so it's unmistakable in both themes. The choice is stored locally; Match system clears it. The landing page has an icon-only Light / Dark switch (sun, moon) in its nav that is always visible, embedded or not, and follows the host's theme until you pick one.

## Components

- **Buttons** are pills. Primary is `dawn` on `on-dawn`. Every triage action shows its key (`1`, `2`, `3`, `H`, `U`).
- **Rows** in the Inbox breathe (~64px). A 3px stripe on the left carries the bucket colour.
- **Agent cards** on the Agents page carry a sweeping dawn bar while working, the phase progress, the last step, and Stop.
- **Panes** slide in from the right on desktop and take the screen on mobile.
- **Callouts** ("Crew note", "Your note", "Why it stopped") use a tinted surface, not a border.
- **Icons** come from Lucide at 14–16px with 2px strokes, and are always paired with a label or `aria-label`.

## Motion

150–200ms with ease-out for hover and state changes. One easing curve for entrances: `cubic-bezier(.23, 1, .32, 1)`. No animation longer than 500ms. Respect `prefers-reduced-motion`.

## Keyboard

Keyboard-first everywhere: `J`/`K` to move, `Esc` to close, single-key triage. Merge asks for a second press instead of opening a dialog.

## Copy

Write from the user's side. The crew "shipped", "needs you", or "stopped because…". Errors say what happened and what to do next. Use specific numbers ("98k tokens"), never vague ones.

## Numbers

Talk in tokens, never dollars: per run ("98k tokens"), per day ("1.2M of 20M tokens today"), and in budgets. Format with `formatTokens` (950, 98k, 2.3M).

## Home and Goals

Home surfaces goals and unresolved decisions across all report days. Active agent detail is expandable; integration trains, queued departures, repo authority and recent outcomes remain accessible. Goals starts with an outcome and optional success criteria; naming, scheduling and resource overrides are disclosed under Details & limits. Home and Goals are the primary navigation; More contains Agents, Later, Operations, History, Sync and Theme. Daily reports and the Horizon remain in History. A decision explains why it needs a person and what action moves it forward. Queue entries explain their current wait instead of implying every idle task is about to start.

Use railway language when it describes behaviour: Station, Dispatch, Crew, Route, Train, and Departure. Keep task, PR, test, merge, and evidence explicit. The local open-source runner is the primary experience; managed mode is coming soon.
