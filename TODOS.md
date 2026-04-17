# NightCrew TODOs

## Controlled Benchmark Fixture
**Priority:** P3 | **Effort:** S (human: ~4h / CC: ~15min)
**Depends on:** Token compression benchmark subcommand (v0.3.4)

Create a frozen tasks.yaml + test repo for reproducible A/B benchmark comparisons. Currently `nightcrew benchmark` compares two arbitrary sessions, but task complexity differences make token comparisons noisy. A controlled fixture (same tasks, same codebase state) would produce trustworthy numbers for the blog post.

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

**Precursor shipped:** Smart retry (v0.3.3) handles single-retry with error context injection.
The `diagnosis` field in `progress.json` builds the failure catalog this TODO was waiting for.
The full repair loop remains for multi-attempt diagnosis by a separate session.


## Completed

### Per-Project Protected Branches
**Completed:** v0.3.x (2026-04-17)
Added optional `protected_branches` field to task schema. `is_protected_branch()` now accepts a third argument (per-task list, newline-separated); the union of global + per-task is checked. README.md and tasks.yaml.example updated with per-task examples. 6 new bats tests covering union, de-dup, empty-extra, and yaml-driven cases.

### Preflight gitignore check
**Completed:** v0.3.x (2026-04-17)
Added `lib/preflight-gitignore.sh` with `check_files_in_scope_gitignored()`. Wired into `preflight_check` + `preflight_json` in `lib/run.sh`. Fails fast with per-task, per-glob, gitignore-line-referenced error messages. 6 bats tests in `tests/preflight-gitignore.bats` covering literal paths, glob expansion, multi-project, and no-op cases. Prevents the token-burn-on-doomed-task failure mode from the first self-dogfood run.

### Broaden default tool whitelist
**Completed:** v0.3.x (2026-04-17)
Expanded `implementation`, `refactor`, and `test` default tool whitelists in `lib/tool-router.sh` to include `git mv`, `git rm`, `bats`, and read-side shell helpers (`test`, `grep`, `ls`, `cat`, `find`, `wc`). `research` stays narrow. Custom overrides still take precedence. 6 new bats tests in `tests/tool-routing.bats`.

### Promote DESIGN.md to Project Root
**Completed:** v0.3.x (2026-04-17)
Copied `design/nocturnal_command/DESIGN.md` to `DESIGN.md` at project root (design/ stays gitignored for local mockups). Added design-system pointer to README.md and CONTRIBUTING.md. Completed out-of-band because the worktree can't see gitignored source files.

### Run Lockfile
**Completed:** v0.3.x (2026-04-17)
Added mkdir-based lockfile at `state/.nightcrew.lock`. Global scope (one `nightcrew run` at a time). Stale-PID detection with automatic reclaim. Trap-based release on INT/TERM/EXIT. Five bats tests covering acquire, fail, release, stale reclaim, and SIGINT trap.

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
