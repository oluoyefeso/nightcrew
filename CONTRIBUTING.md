# Contributing to NightCrew

NightCrew 1.0 is a Bun and TypeScript monorepo. The 0.x bash runner lives in
[`classic/`](classic/README.md) and remains supported.

## Setup

Install Bun 1.4.2, then clone the repo and install dependencies:

```bash
git clone https://github.com/oluoyefeso/nightcrew.git
cd nightcrew
bun install --frozen-lockfile
```

Run the dashboard and API locally with `bun run dev`. To try the agents without
Claude or GitHub, run `bun apps/cli/src/main.ts --demo`.

## Checks

```bash
bun run lint
bun run typecheck
bun test
bun run build
bun run build:site
```

The 0.x suite also needs Bash 4+, bats, jq, yq and envsubst. Run it with
`bun run classic:test` on macOS, or `cd classic && bats tests/` on Linux.

## Project layout

| Path | What lives there |
|---|---|
| `apps/cli` | CLI, local API and compiled binary |
| `apps/web` | Dashboard |
| `apps/site` | Landing page |
| `packages/core` | Domain model, reports and tool guard |
| `packages/db` | SQLite schema and queries |
| `packages/runner` | Agent engines, task pipeline and evidence |
| `classic` | 0.x bash runner and its tests |

Open a focused pull request with tests for behavior changes and update the
relevant docs when a user facing flow changes.
