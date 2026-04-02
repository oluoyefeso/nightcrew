# NightCrew TODOs

## Multi-Project Support
**Priority:** P0 | **Effort:** S (human: ~4h / CC: ~20min)
**Depends on:** Nothing (ready to build)

Add a root manifest (`nightcrew.yaml`) that points to per-project task files, each scoped to a repo. Enables overnight runs across multiple repositories in sequence. Wrap the existing `nightcrew_run()` in an outer project loop. Namespace `state/progress.json` by project. Update `nightcrew review` to group results by project.

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

## Server-Backed Dashboard (`nightcrew serve`)
**Priority:** P2 | **Effort:** M (human: ~1 day / CC: ~30min)
**Depends on:** Static dashboard (dashboard.html) proving useful

Local HTTP server with API endpoints for reading status and adding/editing tasks. Upgrades the static dashboard to a full task management UI. Adds a Node/Python dependency.

## Completed

### Gitignore User Config
**Completed:** v0.2.0 (2026-04-02)
Added `.gitignore` for `config.yaml`, `tasks.yaml`, `state/`, `logs/`. Created `.example` files for config and tasks.

### Fix glob-to-regex validation on macOS
**Completed:** v0.2.0 (2026-04-02)
Replaced `\+` (BRE repetition) with `-vF` fixed-string matching. Replaced `\s*` with POSIX `[[:space:]]*`.

### Fix draft PR creation output capture
**Completed:** v0.2.0 (2026-04-02)
Captured `gh pr create` stderr to temp file instead of discarding. Added warning log when PR creation fails.
