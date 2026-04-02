# NightCrew TODOs

## Multi-Project Support
**Priority:** P0 | **Effort:** S (human: ~4h / CC: ~20min)
**Depends on:** Nothing (ready to build)

Add a root manifest (`nightcrew.yaml`) that points to per-project task files, each scoped to a repo. Enables overnight runs across multiple repositories in sequence. Wrap the existing `nightcrew_run()` in an outer project loop. Namespace `state/progress.json` by project. Update `nightcrew review` to group results by project.

## Gitignore User Config (prevent accidental path leaks)
**Priority:** P0 | **Effort:** S (human: ~30min / CC: ~5min)
**Depends on:** Nothing (ready to build)

Add `.gitignore` for `config.yaml`, `tasks.yaml`, `state/`, `logs/`. Rename existing `config.yaml` to `config.yaml.example`. Users copy examples to real files. Prevents accidentally committing personal paths (like `repo_path: /Users/mac/...`) to the public repo. Optionally add a pre-commit hook that rejects absolute paths in YAML files.

## Fix glob-to-regex validation on macOS
**Priority:** P1 | **Effort:** XS (human: ~30min / CC: ~5min)
**Depends on:** Nothing (ready to build)

`validate.sh:45` converts `files_in_scope` glob patterns (like `**`) to regex via sed, but the resulting regex triggers `grep: repetition-operator operand invalid` on macOS grep. Validation still passes (non-blocking), but the warning is noisy and the scope check is silently skipped for affected patterns. Fix the sed conversion or switch to a glob-native matching approach.

## Fix draft PR creation output capture
**Priority:** P1 | **Effort:** XS (human: ~30min / CC: ~5min)
**Depends on:** Nothing (ready to build)

After a successful push, `create_draft_pr()` in `git-ops.sh` doesn't surface the PR URL in the run output. The `gh pr create` call's output may be swallowed by `2>/dev/null` or the URL variable isn't propagated back to the log. First successful run pushed the branch but showed no PR URL. Verify `gh pr create` runs and its output reaches the summary log.

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
