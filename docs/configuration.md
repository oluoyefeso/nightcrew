# Configuration

Everything is set in the dashboard. This page explains what each setting does.

## The night (Settings)

| Setting | Default | What it does |
|---|---|---|
| Start time | 22:00 | When the queue starts, local time. |
| Nightly budget | $25 | The crew stops before a task could take the night past this. |
| Start automatically | Yes | Off means the queue waits for Run now. |
| Planning model | `claude-opus-5-5` | Plans bigger tasks. |
| Building model | `claude-sonnet-5-5` | Implements and repairs. |
| Review model | `claude-sonnet-5-5` | The Skeptic. |

## Each task

| Field | What it does |
|---|---|
| Brief | Everything the crew should know. Nobody answers questions at 3am. |
| Type | Feature, Bug fix, UI, Tests, Refactor, Research. Decides the evidence required. |
| Scope | Globs the crew may change. Writes elsewhere are refused as they happen and checked again afterwards. Empty means the whole repo. |
| Acceptance criteria | The Skeptic checks each one against evidence. |
| Budget | A hard cap for the task (default $5). Planning is capped, and the review always keeps a reserve. |
| Time cap | Default 45 minutes. |
| Workflow | `auto` (default): small, scoped tasks build directly and bigger ones plan first. Force with `quick` or `planned`. |

## Each repo

| Field | What it does |
|---|---|
| Test command | Run by NightCrew after every task and on trains. |
| Install command | Run in each fresh worktree. |
| Preview command | Starts the app for screenshots. Gets `$PORT`; `static` serves the folder. |
| Preview URL | Default `http://localhost:{port}`. |
| Pages to screenshot | Up to six paths. Default `/`. |
| Also protect | Branches the crew never touches. The default branch, `main` and `master` always are. |
| Autonomy | See [the trust ladder](trust-ladder.md). |

## Guardrails that aren't settings

Every tool call in a crew session passes a guard. It refuses:

- writes outside the worktree or the task's scope,
- `.github/workflows`, `.env*`, `.git`, keys,
- `git push`, `reset --hard`, `rebase`, `remote`, `gh pr` and friends (NightCrew opens PRs itself),
- publishing packages, `sudo`, global installs and system package changes,
- network writes (`curl -X POST` and the like),
- reading `.env` files,
- checking out protected branches.

Crew sessions are isolated: no filesystem settings, MCP servers, skills or plugins from your machine. The repo's own `CLAUDE.md`, `AGENTS.md` and `.claude/CLAUDE.md` are passed in so the crew follows the project's conventions.

## Environment variables

| Variable | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | Used by the crew when set; otherwise your Claude Code login. |
| `TYPESAFE_API_KEY` | Turns on Jev (TypeSafe's System One model) for fast judgement calls: workflow choice, merge confidence, failure classification. Without it, rules decide. |
| `NIGHTCREW_HOME` | Data folder (default `~/.nightcrew`). |
| `NIGHTCREW_PORT` | Dashboard port (default 3721). |

## Command line

```
nightcrew                     Open the dashboard and keep the nightly schedule
nightcrew add "<request>"     Draft tasks and queue them for tonight (--later to park them)
nightcrew repo add [path]     Let the crew work in a repo
nightcrew repo                List repos
nightcrew run                 Work through tonight's queue now, in this terminal
nightcrew import              Import 0.x (classic) history

--demo             Pretend crew that spends nothing
--engine managed   Run tasks on Claude Managed Agents (see managed.md)
--no-publish   Keep branches local: don't push or open PRs
--port, --no-open, --data, --classic, --offline
```
