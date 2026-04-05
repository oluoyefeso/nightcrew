# NightCrew TODOs

## Per-Project Protected Branches
**Priority:** P3 | **Effort:** XS (human: ~30min / CC: ~5min)
**Depends on:** Multi-project support (v0.3.2)

Currently `protected_branches` from config.yaml applies uniformly to all projects. For real multi-project use, users may need per-project branch protection (e.g., repo A protects `main`, repo B protects `production`). Consider adding optional `protected_branches` to the per-task `project_path` config or a separate projects section in config.yaml.

## Promote DESIGN.md to Project Root
**Priority:** P3 | **Effort:** XS (human: ~15min / CC: ~2min)
**Depends on:** Nothing

The design system spec ("The Silent Sentinel") lives at `design/nocturnal_command/DESIGN.md`. Move or symlink it to the project root as `DESIGN.md` so contributors can find it. The design system applies to all UI, not just the original mockup directory.

## v2: Pipeline-First Task Format
**Priority:** P2 | **Effort:** S (human: ~30min / CC: ~10min)
**Depends on:** Real overnight usage data from v1

Write the spec for pipeline-first task format where tasks define which phases to run (plan, implement, review, QA) with per-phase model and template configuration. The v1 flat format is a strict subset of the pipeline format, so this is backward-compatible.

## Self-Review Loop
**Priority:** P2 | **Effort:** M (human: ~1 day / CC: ~30min)
**Depends on:** v1 working reliably overnight

After a task completes, spawn a second Claude session to review the draft PR. By morning, PRs have already been through one round of self-review.

## Self-Healing Repair Loop
**Priority:** P2 | **Effort:** M (human: ~1 day / CC: ~30min)
**Depends on:** Pipeline hardening + failure taxonomy from ~20 real overnight runs

When a task fails validation, spawn a repair Claude session that reads the validation errors, diagnoses root cause, attempts a fix, and re-validates. Distinct from the Self-Review Loop (which reviews PRs). The repair loop handles pipeline failures: wrong branch, out-of-scope files, failing tests. Requires a catalog of real failure modes before designing the retry logic. Don't build speculatively.

## Run Lockfile
**Priority:** P3 | **Effort:** XS (human: ~30min / CC: ~5min)
**Depends on:** Nothing

Add a flock-based lockfile (e.g., `.worktrees/.nightcrew.lock`) to prevent concurrent NightCrew runs colliding on the same repo. Two runs targeting the same `.worktrees/` directory would corrupt worktree state. Check for lock at startup, fail with a clear message if another run is active.

## Completed

### Multi-Project Support
**Completed:** v0.3.2 (2026-04-05)
Implemented via per-task `project_path` field in tasks.yaml (replacing the originally proposed manifest approach). Each task can target a different git repo. Worktrees created under each project's own `.worktrees/` directory. Schema, preflight, run loop, CLI, web UI, and server all updated. 20 new tests added.


### Gitignore User Config
**Completed:** v0.2.0 (2026-04-02)
Added `.gitignore` for `config.yaml`, `tasks.yaml`, `state/`, `logs/`. Created `.example` files for config and tasks.

### Fix glob-to-regex validation on macOS
**Completed:** v0.2.0 (2026-04-02)
Replaced `\+` (BRE repetition) with `-vF` fixed-string matching. Replaced `\s*` with POSIX `[[:space:]]*`.

### Server-Backed Dashboard (`nightcrew serve`)
**Completed:** v0.3.0 (2026-04-02)
Node.js HTTP server with 11 API endpoints. Full SPA web UI with 4 pages (Dashboard, Queue Manager, Log Archive, System Health) + run confirmation overlay. Session archiving to `state/sessions/`. New CLI subcommands: `serve`, `preflight --json`, `config --json`. Task `enabled` field for disable/enable from the UI.

### Fix draft PR creation output capture
**Completed:** v0.2.0 (2026-04-02)
Captured `gh pr create` stderr to temp file instead of discarding. Added warning log when PR creation fails.
