# NightCrew

Set the goal. Conduct the work.

NightCrew is an open-source conductor's station for coding agents. Set the direction, dispatch work across your repos, and choose how far the crew may go. Agents build, gather evidence, and pass their work to an independent Skeptic. Your repo settings determine whether they stop at a plan, open a PR, join an integration train, or merge to dev. Work starts whenever you need it; overnight is one scheduling option.

![Daily report](docs/screenshots/inbox.png)

> **1.0 alpha.** The bash runner from 0.x still works and lives in [`classic/`](classic/README.md).

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/oluoyefeso/nightcrew/main/install.sh | sh
```

NightCrew needs `git` and a model connection. Use OpenRouter or a compatible local endpoint, or install Claude Code and sign in (or set `ANTHROPIC_API_KEY`). GitHub publishing also needs the GitHub CLI (`gh auth login`).

[Model connections](docs/configuration.md#model-connections-optional) in Settings can discover models, check a synthetic tool exchange and explicitly select a model for the crew. OpenRouter is the recommended hosted connection, with a preset and `--env-file` support for a private key file; local and custom endpoints remain available. Choose **Use for crew** to enable planning, coding and review through that connection. The model must support tool calls and report token usage; saving or checking a connection alone does not switch execution.

```bash
cd ~/code/my-app
nightcrew repo add        # detects the test, install and preview commands
nightcrew                 # prints a dashboard link and opens it
```

The link (`http://localhost:3721/?t=…`) carries a key that changes every launch. With `--no-open`, or after a restart, open the link `nightcrew` just printed.

Give the agents work in the dashboard, or from a terminal:

```bash
nightcrew add "Dark mode that follows the system, and fix the crash when a widget has no title"
```

Agents start as soon as a slot is free: up to 3 at once and 1 per repo by default, within a 20M-token daily budget (all adjustable). Add `--schedule` to hold work for off-peak, or `--later` to park it. Try everything without spending anything with `nightcrew --demo`.

## How it works

1. **Dispatch.** Describe the work. NightCrew drafts task cards with scope, acceptance criteria, the evidence it will need and a token budget, and asks one question if something is unclear. Departure checks show missing setup, prerequisites, scope overlap and available budget before dispatch. Run now, schedule it, or park it in Later.
2. **Agents work, in parallel.** **More → Agents** shows every agent live: its phase, its last step, and a Stop button.
   - Each task gets its own clone of the repo (under `~/.nightcrew/work`) and a separate agent session through the selected connection or Claude Code, and lands by commit. Repos that use git-lfs, git-crypt or sparse checkout aren't supported yet.
   - Small tasks build directly; bigger ones plan first.
   - Every tool call passes a guard that refuses writes outside scope, pushes, publishing, secrets and protected branches.
   - NightCrew runs your tests itself and gives a failing task one repair attempt, then gathers evidence and hands it to the Skeptic.
3. **Return to results on Home.** Daily history and the Horizon timeline show what happened, with evidence one click away. **New goal** opens the outcome form. A compact attention link keeps unresolved decisions visible across days; **More → Work overview** holds decisions, queue explanations and repository authority. Desktop and Slack notifications are optional.
   - `1` merges.
   - `2` sends a task back with a note; an agent picks it up on the same branch.
   - `3` dismisses.
   - `H` runs it again.
   - `U` undoes.

![Agents at work](docs/screenshots/agents.png)

## Evidence, not claims

NightCrew collects evidence itself, independent of what the agent says:

- **UI tasks.** Before and after screenshots at desktop and mobile, in light and dark, taken from a preview of the base branch and of the task branch. Also a pixel diff, an accessibility scan (only new issues count) and console errors.
- **Bug fixes.** A new test that fails on the base branch and passes on the fix. A test that passes either way gets flagged.
- **Every task.** NightCrew's own checks on scope, tests and protected paths.

The **Skeptic** receives the collected diff, checks and evidence in a separate, read-only session. It investigates gaps and records each challenge it made and whether it held. Missing evidence always sends the task to Needs your eyes. See [docs/evidence.md](docs/evidence.md).

## The trust ladder

Each repo earns autonomy from its track record:

| Level | What the crew may do |
|---|---|
| Propose | Plans only, no code |
| Draft PR | One draft PR per task (the default) |
| Daily train | Ready tasks merge into `crew/train-<day>` and are tested together; you merge one PR |
| Ship to dev | The crew merges into your ship branch itself when evidence, the Skeptic, an 80% confidence score and your path rules all agree. `U` reverts it and drops the repo back to the train |

`main`, the default branch and anything you protect are never touched. NightCrew suggests a promotion when the record earns it ("8 of the last 10 tasks merged without changes"). See [docs/trust-ladder.md](docs/trust-ladder.md).

**Routes by task type** make that authority precise. Keep refactors at draft PRs while tests join the train, or require visual evidence for features. The repo level stays the ceiling. Preview each route before dispatch and inspect its recorded requirements in the run's **Route** tab. Tightening a rule holds running work when it no longer qualifies; raising authority applies to the next run.

**Departure checks** hold queued tasks before an agent starts when required test or preview commands are missing. Fix the settings and dispatch can pick them up automatically. The preview also explains dependency, schedule, capacity and budget waits; you can edit prerequisites on the task. Scope overlap is an advisory based on path patterns. These checks inspect configuration, not whether commands will succeed. Running reservations count against the available budget; proposed caps are not usage estimates or reservations.

**Decision briefs** explain a run's stop reason, missing evidence and next steps, with links to the relevant artifacts and settings. Retry uses saved work where available and reruns verification under current rules.

## Goals

Choose a project, describe the outcome in **Goals**, and select **Start goal**. The conductor prepares a bounded task plan, sends its scoped tasks directly to implementation (proposal-only authority still requires a written plan), carries checked prerequisite code and research into subsequent tasks, and verifies the combined result. Success criteria are optional; without them, the objective itself is the verification target. The dashboard remembers your last project. **Budget & deadline** is optional; **Save for later** stores a goal without starting it. **Edit goal** and limit changes are available directly in the goal workspace. Existing goals also have a **Start goal** action. Manual task preparation remains available separately.

The goal workspace shows progress, questions, consequential decisions and evidence. Answer a question there and the saved plan continues. Final verification combines checked commits privately, runs the configured project tests, and asks an independent reviewer to substantiate each criterion with exact source quotes. Verification can trigger one bounded correction; further gaps wait for your judgment. **Ready for your review** identifies a checked result, not permission to merge or deploy it. Project authority remains in force. Changed objectives, membership, evidence, project configuration or base revisions invalidate verification.

Coordination state and usage survive reloads and restarts. Planning and goal review count alongside task attempts against daily and goal admission limits. Coordination calls reserve allowance; incomplete accounting retains a conservative reservation. Provider-reported usage can overshoot a call's observed token threshold, so these are not guaranteed dollar billing ceilings. Interrupted planning or final review waits for an explicit continuation rather than silently repeating a paid call.

**Stop work** stops the selected goal's active agents and coordination while preserving saved work. A paused crew holds all goals; starting a goal never silently resumes unrelated work. A goal **Deadline** stops active attempts and new work. Existing start-only deadlines remain available as scheduling overrides. Tightening applies to active work; extending or clearing does not relax an active attempt's earliest observed stop time. Cleanup can continue after stopping. The automatic conductor currently coordinates one project per goal using the configured local engine; manually grouped missions may still span projects.

## Recovery and delivery

Task recovery offers **Resume**, **Verify saved build**, and **Rebuild**. Compatible checkpoints avoid repeating planning or implementation; checks and evidence run again. Verification mode uses read-only agent review and never invokes an agent repair. Automatic retry limits persist across restarts.

Save verification routes as reusable templates, including one to three independent reviewers. The repository autonomy ceiling still applies. **More → Operations** shows repository setup, recent reliability, action history, and delivery from check to deploy to release. Delivery commands use a pinned local branch commit in an isolated checkout; automatic stages require explicit repository configuration. Failed or interrupted external actions wait for inspection.

Mission checks and delivery run in the background. Follow saved progress in **Operations**, leave the page and return, or stop an individual operation. Delivery shows why each stage is ready or held for the current local commit and settings; saved-result links retain the exact evidence from earlier operations. Restarting the local runner marks unfinished work interrupted; it does not replay the action. Failed and interrupted operations remain in Work overview and the Operations attention list until marked reviewed; Home links to that outstanding work. Review clears the attention item without changing retry guards or delivery authority. Filter queued departures by repository and hold reason to find the next action.

Before dispatch, **Verify repository setup** rehearses installation and tests on an isolated checkout of the local default branch. Results become outdated when the commit or commands change. Verification templates can be edited, exported and imported for preview; repository authority remains the ceiling. See the [product status](docs/roadmap.md) for available capabilities and current limits.

See [Conductor operations](docs/operations.md) for configuration, command contracts, recovery, and acceptance limits. Managed mode remains **Coming soon**.

## Tokens

Total usage depends on the model, task and number of tool calls; include implementation, failed attempts and independent reviews when judging cost. Claude Code sessions exclude your machine's filesystem settings, MCP servers, skills and plugins. The direct connection engine uses a bounded tool loop. Both receive the repo's own instructions. Each task has a token limit, and the daily budget holds new agents when their reservations would exceed it. Cancellation follows reported usage, so an in-flight call can overshoot. The run view shows per-phase tokens, cost, time, turns and limits; streamed token checkpoints survive interruption and remain charged to the run and mission. Partial or interrupted calls leave missing accounting visible as unknown.

## More

- [Getting started](docs/getting-started.md)
- [Configuration](docs/configuration.md): repos, budgets, models, preview commands, Jev
- [Evidence](docs/evidence.md)
- [Trust ladder](docs/trust-ladder.md)
- [Security](docs/security.md): the guard, the OS sandbox, the push block and the local API
- [Managed mode](docs/managed.md): coming soon. The local open-source runner is the supported experience.
- [Design system](DESIGN.md)

## Development

```bash
bun install
bun run dev          # dashboard on :5173 (Vite) with the API on :3721
bun test             # unit and integration tests (real git repos, headless Chrome)
bun run typecheck
bun run lint
bun run build        # dashboard + single nightcrew binary in apps/cli/dist
bun run classic:test # the 0.x bats suite
```

| Path | What lives there |
|---|---|
| `apps/web` | The dashboard: React 19, Vite 8, TanStack Router and Query, Tailwind 4 |
| `apps/cli` | The `nightcrew` binary: Hono API, scheduler, classic importer, embedded dashboard |
| `apps/site` | The landing page |
| `packages/core` | Domain model, report logic, the tool-call guard |
| `packages/db` | SQLite schema (Drizzle) and queries |
| `packages/runner` | Agent engines (Agent SDK, Managed Agents, demo), pipeline, evidence, trust ladder, reflexes |
| `classic/` | The 0.x bash runner |

## License

MIT
