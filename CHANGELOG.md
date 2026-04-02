# Changelog

All notable changes to NightCrew are documented here.

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
