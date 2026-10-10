# NightCrew Design System: "The hour before sunrise"

NightCrew is used at two moments: handing off work in the evening and clearing the report in the morning. The interface should feel calm at both. Blue-black ink with one warm dawn accent. Restraint does the work: one accent colour, a serif only for big moments, mono for every number.

Railway already owns the violet night sky. NightCrew sits at dawn instead. Never use violet or indigo.

The tokens live in `apps/web/src/styles.css`. This file explains how to use them.

## Themes

Both themes are first-class. The app follows the system setting by default, and the header toggle overrides it.

| Token | Night (dark) | Morning (light) | Use |
|---|---|---|---|
| `bg` | `#0A0E16` | `#F3F5F8` | Page |
| `surface` | `#111723` | `#FFFFFF` | Cards, panes |
| `raised` | `#18202F` | `#EAEEF3` | Hover, selected, chips |
| `line` | ink at 9% | ink at 10% | Hairlines |
| `fg` | `#ECE8E1` | `#141A26` | Text |
| `muted` | `#8B92A3` | `#5E6676` | Secondary text |
| `faint` | `#5C6475` | `#9AA1AE` | Labels, timestamps, the second half of two-tone headings |
| `dawn` | `#F2A65A` | `#B65A12` | The accent: primary buttons, focus, active tab |
| `ok` / `bad` / `sky` | green / red / blue | darker variants | Semantic state only |

Semantic colours mark state (shipped, failed, ready) and are never decoration. `dawn` also means "needs your eyes".

## Type

- **Instrument Serif**: greetings, page titles, the first heading of a rendered plan. Never in UI chrome.
- **Geist**: all UI and body text. 14px base, 13px secondary.
- **Geist Mono**: anything that changes, such as costs, times, SHAs, PR numbers, token counts, logs. Always `tabular-nums`.

Large serif headings get tight tracking (-0.01em). Uppercase labels are rare, mono at 11px, with +0.08em tracking.

## The Horizon

The signature element. A 4px band across the top of the Morning Report, from 22:00 to 07:00 (or the hours around daytime runs), fading from ink to dawn. Each task is a tick at the moment it started, coloured by where it landed. Hover a tick to see the task; click it to open it. Don't use the gradient anywhere else.

## Components

- **Buttons** are pills. Primary is `dawn` on `on-dawn`. Every triage action shows its key (`1`, `2`, `3`, `H`, `U`).
- **Rows** in the Morning Report breathe (~64px). A 3px stripe on the left carries the bucket colour.
- **Panes** slide in from the right on desktop and take the screen on mobile.
- **Callouts** ("Crew note", "Your note", "Why it stopped") use a tinted surface, not a border.
- **Icons** come from Lucide at 14–16px with 2px strokes, and are always paired with a label or `aria-label`.

## Motion

150–200ms with ease-out for hover and state changes. One easing curve for entrances: `cubic-bezier(.23, 1, .32, 1)`. No animation longer than 500ms. Respect `prefers-reduced-motion`.

## Keyboard

Keyboard-first everywhere: `J`/`K` to move, `Esc` to close, single-key triage. Merge asks for a second press instead of opening a dialog.

## Copy

Write from the user's side. The crew "shipped", "needs you", or "stopped because…". Errors say what happened and what to do next. Use specific numbers ("$3.12 spent"), never vague ones.
