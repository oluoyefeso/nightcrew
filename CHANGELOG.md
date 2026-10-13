# Changelog

All notable changes to NightCrew are documented here.

## [1.0.0-alpha.12] - 2026-10-13

Inspect where agent runs spend their resources, and preserve rate-limit recovery across restarts.

### Added
- **Agent usage by phase.** Run details and activity show each agent call's requested model, elapsed time, input/output tokens, cost, turns, and configured limits. Independent reviews remain separate.
- **Incomplete accounting stays visible.** Partial streams retain observed tokens without inventing missing cost or turn totals. Interrupted phases keep an unfinished record, run totals are labelled partial, and time limits are distinguished from manual cancellation.
- **Reported overshoot.** Phase measurements show tokens reported beyond their limit. Cached input is included once; usage-based cancellation is not an exact financial ceiling.

### Fixed
- Relative `--data` and `NIGHTCREW_HOME` paths now remain anchored to the CLI's launch directory during workspace setup and artifact writing.
- Optional notification settings can be cleared without violating the database's non-null storage constraint.
- Rate-limit cooldown deadlines and backoff history survive dispatcher restarts. Expired cooldowns permit work again, and recovery resets the backoff history.
- Local NightCrew clones are excluded from the project's lint configuration scan.

### Upgrade and limits
- Existing runs and settings remain readable; no database migration is required. Older runs do not gain measurements retroactively.
- Phase measurements contain usage and execution metadata, without adding prompts, tool arguments, session handles, or error text. Existing activity logs and artifacts retain their content.
- Agent phase success does not establish task or mission acceptance. Mission-wide efficiency reports and overall mission runtime limits remain future work.
- Managed remains **Coming soon**. These improvements serve the open-source local runner.

## [1.0.0-alpha.11] - 2026-10-12

Keep unresolved operation outcomes visible and find queued work that needs a conductor’s decision.

### Added
- **Persistent attention list.** Failed and interrupted operations appear in Station’s decision count and Operations until explicitly reviewed, including results older than the recent-history window.
- **Focused review.** Filter attention by operation kind and outcome, page through older items, and inspect the exact saved result. Mark reviewed records a persistent acknowledgement without changing command outcomes or retry authority.
- **Departure filters.** Filter the Station queue by repository and hold reason, and show all matching tasks to find work beyond the first six departures.
- **Landing walkthrough.** An interactive attention example explains review acknowledgements and their separation from delivery retry approval.

### Upgrade and limits
- An embedded SQLite migration adds review timestamps while preserving existing operation results, tasks, policies and authority. Earlier failures appear as unreviewed; later success does not silently clear them.
- Reviewing an operation never retries it or authorizes deployment. Interrupted delivery keeps its separate external-outcome inspection requirement.
- Managed mode remains **Coming soon**. The listed conductor roadmap batches are implemented in the open-source local edition.

## [1.0.0-alpha.10] - 2026-10-12

See why delivery may proceed on the current commit, and return to the exact evidence from any saved operation.

### Added
- **Delivery eligibility.** Operations explains each stage against the current local commit, settings, preceding results, required environment names and prior attempts. Manual actions and automatic holds are shown separately.
- **Preview freshness.** Dashboard delivery actions include the reviewed snapshot. Changed branch heads, repository paths or settings reject stale requests before commands start.
- **Exact saved results.** Open persistent operation and result pages for delivery, mission acceptance and repository setup. Historical links retain their recorded commit, evidence and diagnostics when later operations run.
- **Interrupted-result review.** Inspect an interrupted delivery on its result page and explicitly acknowledge a manual retry. Automatic progression remains held after failed or interrupted attempts.

### Fixed
- Suggested delivery actions no longer rely on the latest record from an unrelated commit or outdated settings.
- Delivery guards also detect a repository path change while waiting for access or running commands.
- Results with the same timestamp sort consistently by insertion order.

### Upgrade and limits
- Existing data and authority are preserved; no database migration is required. The delivery fingerprint is optional for existing API clients, while execution gates remain mandatory.
- Readiness uses local commits and recorded command outcomes. It does not check deployment-provider health, fetch remote branches or undo external actions.
- Managed mode remains **Coming soon**; the open-source local runner remains the supported edition.

## [1.0.0-alpha.9] - 2026-10-12

Plan a complete mission before the crew starts, and inspect how its tasks support the intended outcomes.

### Added
- **Complete mission creation.** Set acceptance criteria, token limits, priority and a start deadline in one action. Dashboard missions start paused by default while you plan; existing API defaults remain compatible.
- **Planned criterion coverage.** Link drafts and saved tasks to mission criteria. The composer proposes links, the draft batch highlights gaps, and the mission page shows supporting tasks for each outcome.
- **Outdated-link repair.** Changed criteria remain visible as outdated links in task editing. Moving a task to another mission clears the old links.

### Fixed
- Mission deadlines use the browser’s local timezone and round-trip through UTC storage without shifting on edit.
- Mission spend copy reflects all attempts charged at dispatch, including work subsequently moved or deleted.

### Upgrade and limits
- The embedded SQLite migration adds empty planning links to existing tasks and preserves mission controls and delivery authority.
- Criterion links describe the plan. They are not completion evidence or an additional dispatch gate; mission acceptance still requires your evidence and passing combined checks.
- Managed mode remains **Coming soon**. These features run in the open-source local edition.

## [1.0.0-alpha.8] - 2026-10-12

Rehearse repository setup before dispatching agents, and maintain a portable library of verification workflows.

### Added
- **Repository setup verification.** Run saved installation and test commands in an isolated checkout of the local default branch, without agent tokens or changes to your working directory. Settings and Operations show saved diagnostics and the tested commit.
- **Readiness freshness.** Changed branch heads, repository paths or setup/test commands invalidate the previous result. Background progress, individual cancellation and restart interruption handling also cover setup verification.
- **Template library management.** Rename, update and delete saved verification templates without changing repository copies. Version checks prevent stale windows from overwriting newer edits.
- **Portable templates.** Export a versioned name-and-rules JSON preview or import one for review. Imports validate the format and policy fields; saving a template or applying repository routes remains an explicit action.
- **Current conductor roadmap.** Separate the open-source product backlog from the older classic-runner TODOs.

### Fixed
- Setup failures retain redacted diagnostics, and setup cannot move the pinned checkout's HEAD before verification proceeds.
- Long repository paths wrap correctly in mobile Settings.

### Upgrade and limits
- The embedded SQLite migration adds repository verification history and preserves existing settings, templates and authority.
- Setup verification checks saved installation and test commands on committed local code. It does not validate agent sign-in, preview screenshots, remote freshness or deployment access, and does not replace task-specific evidence.
- Portable templates exclude repository configuration and credentials; review user-authored names before sharing files.
- Managed mode remains **Coming soon**. The local open-source runner is the supported experience.

## [1.0.0-alpha.7] - 2026-10-12

Follow long-running mission verification and delivery from anywhere in the local dashboard.

### Added
- **Background operations.** Mission acceptance and manual delivery return control immediately. The runner continues when you navigate away or close the browser, and saved progress appears when you return.
- **Visible progress.** Operations shows active and recent jobs, elapsed time, repository waits, checkout preparation, setup, command execution and cleanup. Mission pages show their latest verification job; completed jobs link to their results.
- **Individual stop controls.** Stop one verification or delivery operation without stopping unrelated work. Waiting operations can be cancelled before they acquire repository access.
- **Persistent interruption records.** A runner restart marks unfinished operations interrupted for inspection, without replaying them. Operation metadata excludes command output and credentials.
- **Background API.** Opt-in HTTP 202 responses, authenticated job polling and scoped cancellation. Existing synchronous clients keep their result response.

### Fixed
- Cancelled research-only acceptance can no longer record a passing result.
- Unexpected delivery exceptions are treated as interrupted outcomes requiring inspection before retry.
- Graceful shutdown stops and drains operations even when no agents are active. Repositories and missions cannot be removed while their operations are running.

### Upgrade and limits
- An embedded SQLite migration adds operation history without changing repository authority or delivery configuration.
- Progress shows phases rather than streaming terminal output. Closing the runner interrupts work; closing only the browser does not.
- Stopping cannot undo a deployment or release already performed. Inspect external outcomes before retrying.
- Managed mode remains **Coming soon**; these features run in the open-source local edition.

## [1.0.0-alpha.6] - 2026-10-11

Recover saved work, verify mission outcomes, and supervise delivery from the conductor's station.

### Added
- **Phase recovery.** Saved plan/build checkpoints, Resume, Verify saved build, and Rebuild controls. Compatible recovery avoids repeated agent work while rerunning checks, evidence and authority gates. Automatic retry limits survive restarts.
- **Mission acceptance.** Objective-level criteria, evidence notes and combined tests on pinned local branches. Acceptance expires when the objective, member work, branch heads or verification configuration changes.
- **Mission dispatch controls.** Optional token limits, priorities and start deadlines. Spent tokens stay charged to their dispatch mission when tasks move or are deleted.
- **Verification templates.** Save and preview reusable task routes, with one to three independent review sessions. Every reviewer must approve; repository autonomy remains the ceiling.
- **Delivery supervision.** Configure check, deploy and release commands, with manual defaults and explicit automatic stage authority. Commands run against an isolated, pinned commit. Changed settings or commits hold later stages; failed/interrupted actions require inspection.
- **Operations.** Repository setup guidance, delivery records, bounded reliability trends, and local action/policy history that excludes credential values.
- **Landing walkthrough.** Synthetic recovery, acceptance and delivery examples alongside Missions, departure checks and decision briefs.

### Upgrade and limits
- Existing tasks and repositories retain their routes. Delivery starts manual and unconfigured. SQLite migrations are embedded in the binary.
- Historical local spend is attributed to task membership at upgrade; future spend is charged at dispatch. Classic attempts remain excluded.
- Mission acceptance combines your criterion evidence with machine-run combined tests. It is not autonomous semantic certification; research-only acceptance relies on your evidence.
- Additional reviews use separate sessions of the configured model. They consume the task allowance and do not imply independent model providers.
- Delivery scripts must deploy the supplied commit and wait for the provider's outcome. NightCrew does not infer production environments, fetch delivery branches, or implement provider-specific rollback. Command success alone is only as strong as the configured script.
- Credential values belong in the runner environment, never commands or committed configuration. Selected values and known credential patterns are redacted from delivery logs; scripts must not print encoded secrets.
- Managed mode remains **Coming soon**. The local open-source runner remains the supported experience.

## [1.0.0-alpha.5] - 2026-10-11

Give related tasks a shared objective with Missions, and follow their progress across repositories.

### Added
- **Missions.** Create an objective, draft work for it, attach existing tasks, and inspect queued work, setup holds, questions and latest run decisions in one view.
- **Mission dispatch controls.** Pause new starts for one mission while active agents finish and unrelated work continues. Resume keeps task dependencies, schedules, repository routes and the daily budget in force.
- **Shared context.** Agents receive the mission objective alongside their task. Objective edits apply to future attempts; running tasks retain their starting context and cannot move between missions.
- **Mission totals.** See token usage across all attempts of current tasks, plus combined queued and running task caps. Failed attempts remain unresolved until reviewed or dismissed.
- **Landing-page walkthrough.** An interactive, explicitly synthetic example shows Missions, departure checks and decision briefs in the local runner.

### Upgrade and limits
- Existing tasks migrate without a mission. No task status or repository authority changes during migration.
- Mission pause allows active runs to finish, including landing permitted by their repository rules. Use the existing agent stop controls when an active run must stop.
- Missions do not add a separate budget, merge authority or automatic objective acceptance. Resolved counts include dismissed work, and totals follow current membership.
- Managed mode remains Coming soon. The local open-source version is the supported experience.

## [1.0.0-alpha.4] - 2026-10-11

See what will hold work before dispatch, then resolve completed runs with a clearer decision brief.

### Added
- **Departure checks.** Draft batches and saved tasks show the effective route, required setup, prerequisites, scope overlap warnings, and available token budget after usage and running reservations.
- **Setup holds.** The dispatcher leaves tasks queued without starting an agent when required test or preview commands are missing. Holds appear in the Station and Agents queue; fixing the settings lets dispatch resume automatically.
- **Editable prerequisites.** Add or remove task dependencies, with checks for missing prerequisites and circular dependencies before dispatch.
- **Decision briefs.** Runs explain their stop reason, missing evidence and next steps, with shortcuts to available artifacts, task editing and repository settings.

### Fixed
- Invalid batch dependency references are rejected before any tasks are created, instead of being silently dropped.
- Artifact tabs wrap on small screens.

### Notes
- Departure checks inspect configuration; they do not execute commands or prove that file scopes are conflict-free. Scope warnings are advisory, and proposed token caps are not usage estimates or reservations.
- Retry keeps saved work where available and reruns verification. This release does not add phase checkpoint recovery.
- The local open-source runner remains the supported experience. Managed mode is Coming soon.

## [1.0.0-alpha.3] - 2026-10-11

NightCrew becomes the conductor's station: dispatch work, configure each task's
verification and authority, and keep unresolved decisions in view across days.

### Added
- **Station dashboard.** Decisions across all days, draft questions, live agents, explained queue holds, integration trains, repo authority and recent outcomes. Daily reports remain in History.
- **Routes by task type.** Cap each code task type at a plan, draft PR, train or ship, within the repo's autonomy ceiling. Require tests, visual evidence or regression proof; UI and bug-fix evidence requirements remain in force.
- **Route previews and records.** Preview the effective route before dispatch and inspect its starting requirements, effective route and hold reasons in each run's Route tab.

### Changed
- Running tasks retain the strictest route observed. Promotions apply to the next run; tighter settings are checked before landing and after combined integration tests.
- The local open-source runner is the supported experience. Managed mode is marked Coming soon and cannot be selected from the CLI.

### Fixed
- Missing or stale evidence prevents automatic landing, including when the reviewer changes files after evidence collection.
- Always-ask paths hold train tasks as well as shipping tasks.
- Failed, dismissed and plan-only prerequisites no longer unblock dependent code tasks.
- Failed runs can be dismissed from the Station, and landing hold reasons persist for review.

### Upgrade
- Existing repositories keep their autonomy and inherit the default routes. The local SQLite database migrates automatically.
- Releases remain alpha prereleases. Managed hosting is not included.

## [1.0.0-alpha.2] - 2026-10-10

NightCrew stops being night-only. It's a control room for coding agents:
you dispatch work, agents run in parallel inside your guardrails, and each
comes back with evidence and a status report, around the clock.

### Added
- **Parallel dispatcher.** New tasks start as soon as a slot is free: 3 agents at once and 1 per repo by default, within a daily budget that counts real spend plus the caps of running agents.
  - Per-repo git locks keep parallel agents from racing on worktrees or integration branches.
  - Stop one agent, stop all, or pause dispatch.
  - Scheduling ("run at 22:00") is now an option per task, not the default.
- **Agents page** (replaces Tonight). Live cards per agent (phase progress, last step, elapsed time, Stop), the queue waiting for a slot, scheduled work, and Run now / Schedule / Later on drafts.
- **Inbox** (replaces the Morning Report). Reports arrive as agents finish, today shows "Working now" at the top, the Horizon follows the day with a "now" marker, and days are labelled Today / Yesterday.
- **Notifications.** In-app toasts when an agent reports; optional desktop notifications and a Slack webhook for work that finished or needs you.
- **CLI.** `nightcrew add --schedule`; `nightcrew run` shows parallel agents' steps tagged by task.

### Changed
- Report days turn over at 04:00 local, not 18:00.
- The nightly train is the daily train, published whenever no agent is working in the repo.
- Settings: agents at once, per repo, daily budget, dispatch on/off, schedule time, Slack webhook. Night-era settings carry over.
- `H` in the Inbox runs a task again now, instead of "tonight".
- Landing page and docs repositioned: "Dispatch the work. Judge the evidence."

### Fixed
- Files written by NightCrew's own dependency install (for example `package-lock.json` from `npm install`) no longer count against a task's scope or get committed; npm installs without a lockfile no longer create one.

## [1.0.0-alpha.1] - 2026-10-10

NightCrew 1.0: a rebuild of the product around a calm Morning Report, an
evidence pipeline and a per-repo trust ladder.

### Added
- **Dashboard and single binary.** `nightcrew` serves the dashboard at localhost:3721 and keeps the nightly schedule. One file (`bun build --compile`), installable with `curl | sh`. Light ("Morning") and dark ("Night") themes.
- **Morning Report.** A greeting, the Horizon timeline, and five buckets: Shipped, Ready to merge, Needs your eyes, Sent back and Failed. A detail pane covers plan, decisions, review, checks, evidence and attempts. One-key triage: `1` merge, `2` send back with a note, `3` dismiss or take off the train, `H` try again tonight, `U` undo.
- **Tonight.** A plain-English composer drafts typed task cards (scope, criteria, questions). There's also a drag-to-reorder queue, a budget meter, a live crew strip, Later, a task editor with notes and attempts, a live run view, settings, and a `⌘K` command bar. CLI: `nightcrew add`, `repo add`, `run`.
- **Agent SDK runner.** Plan → build → check (with one repair attempt) → Skeptic review → commit, push and draft PR, each task in its own worktree.
  - Every tool call passes a PreToolUse guard (scope, protected paths and branches, no push, publish, sudo, network writes or secrets).
  - Artifacts stay in `~/.nightcrew/runs`, never in your repo.
  - Unfinished work is kept on the branch, and sent-back tasks resume it with your note.
- **Isolated crew sessions.** No filesystem settings, MCP servers, skills or plugins; the repo's CLAUDE.md and AGENTS.md are passed in. Measured 48× cheaper per turn: a small task costs about $0.08 end to end.
- **Evidence pipeline.**
  - UI tasks: before and after screenshots (desktop and mobile, light and dark) from previews of both branches, pixel diffs, axe accessibility scans and console errors.
  - Bug fixes: fail-then-pass proof.
  - Missing evidence always means Needs your eyes. Evidence and Skeptic results go into the PR.
- **Trust ladder.** Propose, Draft PR, Nightly train (tested together, one PR, take tasks off) and Ship to dev (gated on verdict, evidence, 80% confidence and allow and always-ask rules, with Undo that also demotes the repo). Promotion suggestions come from each repo's track record.
- **Reflexes.** Jev (TypeSafe System One) chooses the workflow, scores confidence and classifies failures when `TYPESAFE_API_KEY` is set; rules decide otherwise. Small tasks skip planning, and flaky failures get one retry.
- **Routines** (recurring tasks on chosen weekdays) and **GitHub intake** (issues labelled `crew` import into Later, and their PRs close them).
- **Demo crew** (`--demo`) for trying everything without spending anything.
- **Classic import.** 0.x history appears in the Morning Report, with PR state from GitHub.
- **Landing page** (`apps/site`), release builds for macOS and Linux, CI.

### Changed
- The bash runner moved to `classic/`; its 141 bats tests pass unchanged.
- `DESIGN.md` now describes "The hour before sunrise" (blue-black ink, one dawn accent, Instrument Serif + Geist).

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
