# Configuration

Everything is set in the dashboard. This page explains what each setting does.

## Agents (Settings)

| Setting | Default | What it does |
|---|---|---|
| Agents at once | 3 | Agents working at the same time, across all repos. 1 to 12. |
| Per repo | 1 | Agents at once in one repo, 1 to 6. Above 1, same-repo agents use separate branches and the daily train catches conflicts. |
| Daily token budget | 20M | Tokens used today plus the token caps of agents still running. New agents wait rather than pass it. At least 100k, and never below the budget of a task that's waiting to run. |
| Dispatch | On | Paused: running agents finish, nothing new starts. |
| Schedule time | 22:00 | Where "Schedule" sends work, such as an off-peak window. Local time, 24-hour `HH:MM`. |
| Slack webhook | none | Agents post there when they finish or need you. |
| Planning model | `claude-opus-5-5` | Plans bigger tasks. |
| Building model | `claude-sonnet-5-5` | Implements and repairs. |
| Review model | `claude-sonnet-5-5` | The Skeptic. |

## Each task

| Field | What it does |
|---|---|
| Brief | Everything the crew should know. Nobody answers questions at 3am. |
| Type | Feature, Bug fix, UI, Tests, Refactor, Research. Decides the evidence required. |
| Scope | Globs the crew may change. Writes elsewhere are refused as they happen, and the task's whole change against the default branch is checked again afterwards. Empty means the whole repo. |
| Acceptance criteria | The Skeptic checks each one against evidence. |
| Token budget | A limit on reported input, cache and output tokens for the task: 50k up to the daily budget (default 1M, or the daily budget if that's lower). Planning is capped, and review keeps a reserve. Cancellation follows reported usage, so an in-flight call can overshoot. |
| Time cap | 1 to 600 minutes. Default 45. |
| Workflow | `auto` (default): small, scoped tasks build directly and bigger ones plan first. Force with `quick` or `planned`. |

## Each repo

| Field | What it does |
|---|---|
| Test command | Run by NightCrew after every task and on trains. |
| Install command | Run in each fresh task clone. |
| Preview command | Starts the app for screenshots. Gets `$PORT`; `static` serves the folder. |
| Preview URL | Default `http://localhost:{port}`. |
| Pages to screenshot | Up to six paths. Default `/`. |
| Also protect | Branches the crew never touches. The default branch, `main` and `master` always are. |
| Autonomy ceiling | The most authority any task in this repo may have. See [the trust ladder](trust-ladder.md). |
| Routes by task type | Cap each code task type at an earlier stop; require tests, visual evidence or regression proof. Save explicitly to apply. Existing repos inherit their current autonomy and built-in evidence rules. |

### Where tasks run

Each task works in its own clone at `<data>/work/<repo id>/<task id>`. The data folder is `~/.nightcrew` unless you set `NIGHTCREW_HOME` or pass `--data`. Settings → Repos shows the real path. If you delete a clone, the task starts a new one from its last saved work.

Repos that use git-lfs, git-crypt or sparse checkout are refused for now. Only settings actually in effect count. Support is coming.

## Guardrails that aren't settings

Some limits can't be switched off. Every tool call passes a guard that keeps the crew inside its clone and scope, away from secrets, workflows and protected branches, and away from pushing or opening PRs itself. The agent's own pushes are blocked, and on the local engine its commands run in the OS sandbox. [Security](security.md) has the full list and what each layer does and doesn't catch.

Crew sessions are isolated: no filesystem settings, MCP servers, skills or plugins from your machine. The repo's own `CLAUDE.md`, `AGENTS.md` and `.claude/CLAUDE.md` are passed in so the crew follows the project's conventions.

## Environment variables

| Variable | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | Used by the crew when set; otherwise your Claude Code login. |
| `TYPESAFE_API_KEY` | Turns on Jev (TypeSafe's System One model) for fast judgement calls: workflow choice, merge confidence, failure classification. Without it, rules decide. |
| `NIGHTCREW_HOME` | Data folder (default `~/.nightcrew`). Relative paths, including `--data`, resolve from the directory where the CLI starts. |
| `NIGHTCREW_PORT` | Dashboard port (default 3721). |

## Command line

```
nightcrew                     Open the dashboard; agents pick up work around the clock
nightcrew add "<request>"     Draft tasks and dispatch them (--schedule for off-peak, --later to park, --repo to pick the repo)
nightcrew repo add [path]     Let the crew work in a repo
nightcrew repo                List repos
nightcrew run                 Run the queue in this terminal until it's empty
nightcrew import              Import 0.x (classic) history

--repo <path>      Repo for `add` (default: the current folder if the crew knows it, or the only repo)
--demo             Pretend crew that spends nothing
--engine local     Run agents on this machine (default; managed mode is coming soon)
--no-publish   Keep branches local: don't push or open PRs
--port, --no-open, --data, --classic, --offline
```

## Conductor operations

Mission token limits, priority, start deadlines, acceptance, reusable verification templates, and delivery commands are documented in [Conductor operations](operations.md). Delivery is manual until a repository explicitly grants automatic stage authority. Managed mode remains Coming soon.
