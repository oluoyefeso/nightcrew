# Changelog

All notable changes to NightCrew are documented here.

## [0.4.0.0] - 2026-04-17

### Added
- **Run lockfile** at `state/.nightcrew.lock` prevents two concurrent `nightcrew run` invocations from corrupting shared state. Global scope (one run at a time), atomic `mkdir`-based acquisition (no `flock` dependency), stale-PID reclaim for dead holders, trap-based release on normal exit plus SIGINT/SIGTERM/SIGHUP.
- **Preflight gitignore validation**: `files_in_scope` globs are checked against `git check-ignore` before a task runs. Gitignored sources fail preflight with a per-glob, per-path error that references the exact `.gitignore:<line>` pattern responsible. Prevents the "doomed plan phase burns tokens before failing validation" failure mode.
- **Per-project protected branches**: tasks accept an optional `protected_branches: [...]` field that is merged (union) with the config-level list, never replaced. Repo A can protect `main`, repo B can protect `production`, in the same overnight queue.
- **Design system spec at project root**: `DESIGN.md` ("The Silent Sentinel") promoted from `design/nocturnal_command/` to the project root for discoverability. README.md and CONTRIBUTING.md updated with pointers.

### Changed
- **Default tool whitelists broadened** for `implementation`, `refactor`, and `test` task types. Added `git mv`, `git rm`, `bats`, and read-side shell helpers (`test`, `grep`, `ls`, `cat`, `find`, `wc`) so realistic file-level refactors no longer require every task to hand-build a per-task `allowed_tools` override. `research` stays narrow (read-only); custom overrides still win when specified.

### Tests
- 23 new bats tests across lockfile (5), gitignore preflight (6), protected branches (6), and tool routing (6).

### Notes
- This release was produced by two self-dogfood runs in which NightCrew shipped its own features. Four draft PRs (#10, #11, #12, #13) were generated autonomously by `./nightcrew.sh run` and merged into main after human review.

## [0.3.4] - 2026-04-15

### Added
- Terse output directives: all three pipeline templates now instruct Claude to skip narration and produce structured output only (estimated 20-40% output token reduction)
- Section-aware plan compression: `compress_plan_for_impl()` strips review-only sections (NOT In Scope, Decisions Log) before injecting the plan into the implementation prompt, reducing inter-phase token transfer
- `nightcrew benchmark` subcommand: compares token usage between two archived sessions with a per-phase, per-task breakdown table
- Per-phase token tracking: `plan_in_tokens`, `plan_out_tokens`, `impl_in_tokens`, `impl_out_tokens`, `review_in_tokens`, `review_out_tokens` fields in progress.json
- 10 new bats tests covering plan compression and benchmark subcommand

## [0.3.3] - 2026-04-14

### Added
- Smart retry: when implementation fails, NightCrew retries once with the error log injected into the prompt. Controlled per-task via `retry_strategy` field in tasks.yaml (default: "once")
- Failure diagnosis: `extract_diagnosis()` parses stderr and implementation logs to produce a one-line failure summary stored in `progress.json`
- Enhanced `nightcrew review` output: failed tasks now show a "Diagnosis:" line and retry status
- Web dashboard: failed task cards show DIAGNOSIS and RETRY badges
- New `is_retryable()` function skips retry for segfaults, OOM kills, and safety refusals
- `LAST_STDERR_FILE` global preserves stderr across the `run_with_retry()` boundary for caller-side diagnosis
- 20 new bats tests covering `is_retryable`, `extract_diagnosis`, and `build_error_context`
- `retry_strategy` field added to task schema (`"none"` or `"once"`, default `"once"`)

### Changed
- Retry resets worktree to pre-implementation commit for a clean-slate second attempt
- Cost cap is checked before retry to prevent budget overruns
- Retry gets half the original timeout (minimum 10 minutes)
- TODOS.md updated: Self-Healing Repair Loop now references smart retry as its precursor

## [0.3.2] - 2026-04-05

### Added
- Multi-project support: per-task `project_path` field lets you queue tasks across different repos in a single overnight run
- CLI `enable` / `disable` commands to toggle tasks from the terminal
- CLI `sessions` command to list archived sessions (supports `--json`)
- Web UI: PROJECT_PATH input in Queue Manager editor, grouped with BRANCH
- Web UI: PROJECT_TARGETS summary in run confirmation overlay shows which repos will be targeted
- Web UI: DRY_RUN toggle in run confirmation overlay
- Web UI: VERSION display on System Health page via new `GET /api/version` endpoint
- Web UI: task cards show project repo name when project_path is set
- README screenshots for all 4 web UI pages
- README multi-project usage section with example tasks.yaml

### Fixed
- Schema bug: `enabled` field was used in code but missing from `task.schema.json` (additionalProperties: false rejected it)
- Signal handler now uses per-task repo dir (`CURRENT_TASK_REPO_DIR`) instead of global `REPO_DIR`, preventing worktree corruption on interrupt during multi-project runs
- JSON preflight path now validates required fields, type/complexity enums, and project_path (previously only checked task count)
- Dry-run from web UI now correctly passes `--dry-run` flag to the server spawn

### Changed
- Form layout restructured: git fields (BRANCH, PROJECT_PATH) grouped together, ENABLED moved to config row
- Preflight field validation extracted to shared `validate_task_fields()` function (DRY)
- Version bumped to 0.3.2 across VERSION, package.json, nightcrew.sh

## [0.3.1] - 2026-04-03

### Fixed
- Preflight crash on empty tasks.yaml: `validate_dependencies()` no longer fails on macOS when task count is zero (macOS `seq 0 -1` counts down instead of producing nothing)
- `/api/status` now returns consistent shape `{tasks:{}, total_cost_cents:0, session_started:null}` when progress.json is empty or missing
- `/api/tasks` returns `{tasks:[]}` instead of `{tasks:null}` when tasks.yaml has no entries

## [0.3.0] - 2026-04-02

### Added
- Web UI: run `nightcrew serve` to open a 4-page operations console at http://127.0.0.1:3721
  - **Dashboard** with stats grid, task cards, click-to-expand logs, and empty state
  - **Queue Manager** with split-pane task list + editor form (add, edit, duplicate, delete, enable/disable tasks)
  - **Log Archive** with session history and full terminal-style log viewer per task/phase
  - **System Health** with live preflight checks, config viewer, and lifetime cost summary
  - **Run Confirmation overlay** with task count, estimated time, model routing preview, and warnings
- Session archiving: each run is archived to `state/sessions/{timestamp}/` with its own progress.json and logs
- `nightcrew preflight --json` for structured preflight check output
- `nightcrew config --json` for resolved configuration with model routing table
- `enabled` field on tasks: set `enabled: false` in tasks.yaml to skip a task without deleting it
- Node.js HTTP server (server.js) with 11 API endpoints for the web UI
- Design system: "The Silent Sentinel" dark theme from DESIGN.md with tonal layering, no borders, monospace data

### Security
- Cross-origin request protection (localhost-only, no CORS wildcard)
- Path traversal prevention on all file-serving endpoints
- Shell injection prevention (execFileSync with argument arrays, not string interpolation)
- XSS prevention in the SPA (proper HTML entity escaping, URL protocol validation, data-attribute event delegation)
- Request body size limit (1MB) on POST endpoints

## [0.2.1] - 2026-04-02

### Changed
- Plan prompt now classifies architectural patterns using a Layer 1/2/3 framework (built-in, library, first-principles) with a boring-by-default challenge for new dependencies.
- Architecture decisions in the plan prompt require a 1-10 confidence score so morning reviewers know where to focus scrutiny.
- Failure mode analysis expanded: critical gap rule now flags crash/hang failures alongside silent ones, and the "user impact" column asks for specific user experience descriptions.
- Plan output format now includes a "What Already Exists" section to surface reuse opportunities.
- Plan prompt includes a distribution check for new artifacts (binaries, packages, containers).
- Review prompt adds Step 3.5 (Regression Detection) with scope-aware test writing: mandatory regression tests within scope, logged concerns for out-of-scope paths, and post-write test verification.

## [0.2.0] - 2026-04-02

### Fixed
- Pipeline crash when first task completes: `((var++))` with `set -e` killed the script on first counter increment from zero. All 21 arithmetic sites converted to safe `var=$((var + 1))` form.
- `claude -p` running in NightCrew's directory instead of the worktree. Code edits now land in the correct target repository.
- `gh pr create` failing silently: stderr was discarded via `2>/dev/null`. Now captured and logged so you can see why PR creation failed.
- `grep: repetition-operator operand invalid` on macOS: BSD grep choked on `\+` in BRE mode and `\s` in ERE mode. Replaced with POSIX-compatible patterns.
- Dashboard HTML showing "No run data" on refresh: `fetch()` is blocked on `file://` protocol. `nightcrew review` now embeds JSON data inline.
- Worktree setup silently succeeding on stale directories from crashed runs. Now validates `.git` file exists and recreates if needed.

### Added
- `.gitignore` for runtime artifacts (`logs/`, `state/`) and user-specific config (`config.yaml`, `tasks.yaml`)
- `config.yaml.example` and `tasks.yaml.example` so users copy to local files without leaking paths
- Warning message when branch pushes but PR creation fails
- Worktree guard: validates path is non-empty, single-line, and directory exists before proceeding
- Error capture in `commit_changes` and `push_branch` with directory existence checks
- 7 new bats tests for worktree hardening and validation edge cases (60 total)

### Changed
- `nightcrew review --open` now opens rendered dashboard from `state/dashboard.html` (with embedded data) instead of the template

## [0.1.0] - 2026-04-02

First release. Queue tasks before bed, wake up to draft PRs.

### What you can do
- Define tasks in `tasks.yaml` with prompt, branch, type, and complexity
- 3-phase pipeline: Opus plans, Sonnet implements, Sonnet reviews
- Task dependencies via `depends_on` field (blocked tasks are skipped and re-evaluated on re-run)
- JSON Schema validation catches malformed task files before burning tokens
- Preflight validation: schema, dependency graph, templates, git state
- Model routing: Opus for planning and high-complexity tasks, Sonnet for everything else
- Tool sandboxing: each task type gets a whitelist of allowed tools
- Rate limit handling with exponential backoff (5m, 10m, 20m, 40m, 60m)
- Cost tracking: real token counts via `--output-format json`, flat-rate fallback
- Cost cap enforcement to prevent runaway spending
- File scope enforcement with regex-based glob matching (supports `**` patterns)
- Secret scanning in diffs (api_key, secret_key, password, private_key)
- Branch protection (never touches main/master/develop/production)
- Per-task timeouts with clean signal handling
- Morning review CLI dashboard (`nightcrew review`)
- Static HTML dashboard with dark theme, auto-refresh, status badges
- macOS native notifications and webhook support on completion
- DECISIONS.md logging when Claude makes autonomous judgment calls
- Dry-run mode with full preflight validation
- 53 bats tests covering state, routing, validation, deps, schema, cost tracking

### For contributors
- Pure bash, zero compiled dependencies
- Modules in `lib/`, templates in `templates/`, tests in `tests/`
- JSON Schema at `schemas/task.schema.json`
- See CONTRIBUTING.md for setup instructions
