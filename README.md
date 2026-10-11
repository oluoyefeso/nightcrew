# NightCrew

Your station for an agent crew.

NightCrew is an open-source conductor's station for coding agents. Set the direction, dispatch work across your repos, and choose how far the crew may go. Agents build, gather evidence, and pass their work to an independent Skeptic. Your repo settings determine whether they stop at a plan, open a PR, join an integration train, or merge to dev. Work starts whenever you need it; overnight is one scheduling option.

![Daily report](docs/screenshots/inbox.png)

> **1.0 alpha.** The bash runner from 0.x still works and lives in [`classic/`](classic/README.md).

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/oluoyefeso/nightcrew/main/install.sh | sh
```

NightCrew needs `git`, the GitHub CLI (`gh auth login`), and either Claude Code (logged in) or `ANTHROPIC_API_KEY`.

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
2. **Agents work, in parallel.** The **Agents** page shows every agent live: its phase, its last step, and a Stop button.
   - Each task gets its own clone of the repo (under `~/.nightcrew/work`) and an isolated Claude session, and lands by commit. Repos that use git-lfs, git-crypt or sparse checkout aren't supported yet.
   - Small tasks build directly; bigger ones plan first.
   - Every tool call passes a guard that refuses writes outside scope, pushes, publishing, secrets and protected branches.
   - NightCrew runs your tests itself and gives a failing task one repair attempt, then gathers evidence and hands it to the Skeptic.
3. **Conduct from the Station.** Unresolved decisions stay visible across days. Inspect the evidence, answer a question, send work back, or make a merge decision. Next departures explains why queued work is waiting, and Routes & authority shows each repo's autonomy level. Resolved work becomes a recent outcome; daily reports and the Horizon timeline remain in **History**. Desktop and Slack notifications are optional.
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

The **Skeptic** reviews with that evidence and records each challenge it made and whether it held. Missing evidence always sends the task to Needs your eyes. See [docs/evidence.md](docs/evidence.md).

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

## Missions

Group related tasks around an objective, even across repositories. Create a mission from the Station or **Missions**, then draft work for it or attach existing tasks. Agents receive the objective alongside their task; their scope and repository rules still apply. Edit prerequisites on individual tasks to control ordering.

Each mission shows queued and active work, setup holds, questions, decisions and token usage charged at dispatch. Moving or deleting tasks does not erase spent tokens. Set mission acceptance criteria, then record evidence and run combined repository checks before accepting the objective. Resolved task counts include dismissed work; dismissed tasks do not satisfy mission acceptance.

**Pause mission** holds new starts while active agents finish, including landing allowed by their repository rules. Resume allows queued tasks to start when the crew's other limits permit. Objective edits apply to future attempts. An optional mission token limit includes recorded usage and running reservations, alongside the daily budget. Mission priority and start deadlines govern the order and eligibility of new starts.

## Recovery and delivery

Task recovery offers **Resume**, **Verify saved build**, and **Rebuild**. Compatible checkpoints avoid repeating planning or implementation; checks and evidence run again. Verification mode uses read-only agent review and never invokes an agent repair. Automatic retry limits persist across restarts.

Save verification routes as reusable templates, including one to three independent reviewers. The repository autonomy ceiling still applies. **Operations** shows repository setup, recent reliability, action history, and delivery from check to deploy to release. Delivery commands use a pinned local branch commit in an isolated checkout; automatic stages require explicit repository configuration. Failed or interrupted external actions wait for inspection.

Mission checks and delivery run in the background. Follow saved progress in **Operations**, leave the page and return, or stop an individual operation. Restarting the local runner marks unfinished work interrupted; it does not replay the action.

Before dispatch, **Verify repository setup** rehearses installation and tests on an isolated checkout of the local default branch. Results become outdated when the commit or commands change. Verification templates can be edited, exported and imported for preview; repository authority remains the ceiling. See the [open-source conductor roadmap](docs/roadmap.md) for ongoing work.

See [Conductor operations](docs/operations.md) for configuration, command contracts, recovery, and acceptance limits. Managed mode remains **Coming soon**.

## Tokens

A small task uses about **100k tokens** end to end (build, check, review, commit). That's measured, not estimated. Each agent session runs isolated: no filesystem settings, MCP servers, skills or plugins from your machine, only the repo's own `CLAUDE.md` / `AGENTS.md`. The same tasks took 2.3M–4.4M tokens in a session that loaded everything on the machine, so that's 20–40× fewer, with the agent's tools kept to what the task needs. Every task has a token budget the agent stops at, and the daily token budget holds new agents back rather than letting them pass it.

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
