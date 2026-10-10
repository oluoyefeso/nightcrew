# NightCrew

Queue it at night. Merge it with coffee.

NightCrew runs your coding tasks overnight with Claude, across all your repos, and hands you a calm **Morning Report** with what shipped, what needs you, and the evidence for each.

> **1.0 is in alpha on the `v1` branch.** This milestone (M0) brings the new dashboard and Morning Report, built on the run history from the classic runner. The new task composer and runner arrive in M1. The original bash runner still works and lives in [`classic/`](classic/README.md).

## Quick start

```bash
bun install
bun run build                 # builds the dashboard and the single nightcrew binary
./apps/cli/dist/nightcrew     # imports classic history, opens http://localhost:3721
```

`nightcrew` finds classic history on its own (a folder with `state/sessions`). Point it somewhere else with `--classic <dir>`. Data lives in `~/.nightcrew/nightcrew.db`.

| Command | What it does |
|---|---|
| `nightcrew` | Import classic runs, then open the dashboard |
| `nightcrew serve` | Start the dashboard without importing |
| `nightcrew import` | Import classic runs and refresh PR state from GitHub |

Options: `--port`, `--no-open`, `--classic <dir>`, `--data <dir>`, `--offline` (skip GitHub lookups).

## The Morning Report

- **The Horizon** shows the night as a time axis, with a tick for each task at the moment it ran.
- **Buckets**: Shipped, Ready to merge, Needs your eyes, Sent back, Failed.
- **One-key triage**: `1` merge (press twice), `2` send back with a note, `3` dismiss, `H` try again tonight, `U` undo. `J`/`K` move between tasks.
- **Detail pane**: the plan, decisions, review and phase logs each task left behind, plus every attempt across nights.

Light ("Morning") and dark ("Night") themes follow your system, or pick one in the header. See [DESIGN.md](DESIGN.md).

## Development

```bash
bun run dev          # Vite on :5173 with the API on :3721
bun test             # TypeScript tests
bun run typecheck
bun run lint
bun run classic:test # the classic bats suite
```

| Path | What lives there |
|---|---|
| `apps/web` | The dashboard: React 19, Vite 8, TanStack Router and Query, Tailwind 4 |
| `apps/cli` | The `nightcrew` binary: Hono API, classic importer, static dashboard |
| `packages/core` | Domain model and report logic shared by everything |
| `packages/db` | SQLite schema (Drizzle) and queries |
| `classic/` | The original bash runner, until the new runner matches it |

## Roadmap

- **M0**: monorepo, design system, Morning Report on classic data (this branch)
- **M1**: Tonight composer, task management, the Agent SDK runner replacing the bash loop
- **M2**: evidence pipeline (screenshots, fail-then-pass tests) and the Skeptic agent
- **M3**: trust ladder (nightly train, ship-to-dev with Undo), foreman workflows, Jev checks
- **M4**: managed mode on Claude Managed Agents, then launch

## License

MIT
