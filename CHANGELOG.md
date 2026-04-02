# Changelog

All notable changes to NightCrew are documented here.

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
