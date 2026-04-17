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

## Rate-limit retry detection reads wrong stream
**Priority:** P2 | **Effort:** XS (human: ~30min / CC: ~5min)
**Depends on:** Nothing

`lib/run.sh:464` greps `$stderr_content` for rate-limit keywords (`rate limit|too many requests|429|capacity|exceeded.*limit`). But when `--output-format json` is in use (the default path now), Claude CLI emits the 429 inside the JSON *stdout* as `api_error_status:429`, not stderr. The retry loop therefore never detects the rate limit and burns through all 5 attempts in under 2 seconds instead of applying the specced 5m/10m/20m/40m/60m exponential backoff.

Observed during self-dogfood run #2: a burst of Opus 4.7 plan requests tripped a rate limit, Task 3 hit `api_error_status:429` on plan → fallback impl → 429 → 5 retries in 2 seconds → marked failed. A manual retry 55 minutes later succeeded on the first try.

Fix: in the retry-detection block, also parse the JSON output file (when `JSON_OUTPUT_SUPPORTED == true`) and check `.api_error_status == 429` or `.is_error == true && .subtype == "error"`. Emit the same backoff path. Add a bats test that simulates a 429-in-stdout-JSON response and verifies the sleep schedule.

## Opus 4.7 plan phase occasionally exits 1
**Priority:** P3 | **Effort:** S (human: ~2h / CC: ~15min)
**Depends on:** Reproduce the failure mode

Observed during self-dogfood run #2: Opus 4.7 plan phase exited 1 twice out of four attempts. Once after 7 minutes (Task 2: preflight-gitignore-check — a long, detailed prompt) and once after 32 seconds (Task 3: per-project-protected-branches, first attempt — actually a 429 disguised as exit 1, see the rate-limit TODO). Nightcrew's fallback-to-direct-impl saved both: Task 2 shipped PR #12 via Sonnet-only, Task 3's retry succeeded on Opus a session later.

The long-plan failure is the one worth investigating. Hypotheses: (a) Opus hit max-turn limit while assembling the very detailed plan, (b) a safety trip on some prompt content, (c) a transient Claude CLI / API issue. Capture the full stderr + JSON output for failed plan phases into the session archive (`state/sessions/<ts>/logs/<task>-plan.log` already captures some — verify it includes stderr on non-zero exit) and log the exit context (JSON `.is_error`, `.subtype`, any `.error` field). Enough signal to triage when this happens again.

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
