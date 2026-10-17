# Getting started

## 1. Install

```bash
curl -fsSL https://raw.githubusercontent.com/oluoyefeso/nightcrew/main/install.sh | sh
```

You also need `git` and a model connection. OpenRouter is the recommended hosted entry point; compatible local endpoints and Claude Code remain available. GitHub publishing requires the GitHub CLI logged in (`gh auth login`). Claude Code must be installed and authenticated only when using the Claude engine.

## 2. Add a repo

```bash
cd ~/code/my-app
nightcrew repo add
```

NightCrew reads the repo and fills in what it can:

- **tests**: `bun run test`, `npm test`, `cargo test`, `go test ./...`, `pytest -q` or `make test`
- **install**: `bun install --frozen-lockfile`, `npm ci` and so on, run in each task's fresh clone
- **preview**: how to start the app for UI screenshots (Vite, Next, Astro, any `dev` script, or `static` for plain HTML)

Repos that use git-lfs, git-crypt or sparse checkout are refused for now. Support is coming.

Check them in **Settings → Repos**. Without a test command, NightCrew can't verify the crew's work. Without a preview command, UI tasks have no screenshots and always land in Needs your eyes.

## 3. Open the dashboard

```bash
nightcrew
```

It prints a link like `http://localhost:3721/?t=…` and opens it in your browser. The link carries a key that changes every launch, so only it opens the dashboard. With `--no-open`, or after a restart, open the link it just printed; an old tab shows a page saying so.

For OpenRouter, start with `nightcrew --env-file .env.local` after adding `OPENROUTER_API_KEY` to that private file. In **Settings → Model connections**, choose **Add OpenRouter**, then **Use for crew**. The preset supplies a model; you can select another compatible model or a local endpoint there. Selection does not resume paused dispatch. See [model connections](configuration.md#model-connections-optional) for credential handling and compatibility limits.

While it runs, agents pick up work as soon as it's queued. Your data lives in `~/.nightcrew` (or `NIGHTCREW_HOME`, or `--data`). Each task runs in its own clone at `<data>/work/<repo id>/<task id>` and lands back in your repo as a commit. Delete a clone and the task starts a new one from its last saved work.

## 4. Give the agents work

Start in **Goals**, choose a project, describe the outcome and select **Start goal**. The conductor plans, queues, coordinates and verifies the work. Answer questions in the goal workspace; the saved plan continues automatically. **Save for later** stores a goal without starting it. Your last selected project is remembered on this dashboard. A paused crew remains paused until you explicitly resume it. Unusable plans are held, with no automatic fallback execution.

For individual tasks, **More → Agents** also accepts a short brief. Several things at once is fine:

> Dark mode that follows the system. Also the crash when a widget has no title. Don't touch billing.

For this manual task flow, proposals show the approach, project, acceptance criteria and any question. **Adjust task details** exposes repository, type, scope and criterion links. Execution checks show reasons work must wait; their full details are optional. Then:

- **Queue work**: save the proposals; ready tasks start when the goal, dispatch, project setup and budgets allow,
- **Schedule**: hold until the schedule time, such as off-peak,
- **Save to Later**: park it.

From a terminal: `nightcrew add "…"` (add `--schedule` or `--later`).

## 5. Watch, or don't

**More → Agents** shows every agent working: phase, last step, elapsed time, and a Stop button. Stop one and its work so far stays on its branch. **Pause dispatch** lets running agents finish but starts nothing new. Turn on desktop or Slack notifications in Settings → Advanced crew settings to hear when an agent finishes or needs you.

## 6. Return to results on Home

**Home** opens your daily history and Horizon timeline. Select a result to inspect its evidence and decisions, or move between report days. **New goal** opens a short outcome form; naming and execution limits are optional details. An attention link includes unresolved work across all days, including questions and failed operations. It opens **Work overview**, where you can inspect evidence, answer, merge, send instructions, retry, or dismiss.

In **More → Work overview**, expand **Crew at work** to inspect active agents. **Next departures** explains what queued tasks are waiting for: dependencies, capacity, budget, a schedule, or paused dispatch. **Routes & authority** shows each repo's current autonomy level and links to its settings. Filter Next departures by repository or reason, then open a task to resolve its hold. Work overview also surfaces failed and interrupted operations; inspect their exact saved outcomes and mark them reviewed in Operations.

Resolved work also appears in **Recent outcomes** in Work overview. Existing `/history` links return to Home and preserve the selected run.

| Key | Does |
|---|---|
| `J` / `K` | Move between tasks |
| `1` (twice) | Merge the PR |
| `2` | Send back with a note; an agent picks it up on the same branch |
| `3` | Dismiss, or take a task off the daily train |
| `H` | Run it again |
| `U` | Undo the last decision, or undo a ship to dev |
| `⌘K` | Command bar |

## Trying it without spending anything

```bash
nightcrew --demo
```

The demo crew narrates believable steps and writes a small file inside each task's scope. Nothing is pushed.

## Conducting an objective

Open **Goals** and describe the outcome. Optional success criteria define what the independent goal reviewer must substantiate. **Start goal** coordinates one selected project, including prerequisite handoffs and a private combined checkout for final tests. The result retains exact evidence quotes and the checked commit. **Ready for your review** leaves merge and delivery under the project's existing permissions. One bounded correction can follow a failed combined check or a substantiated goal gap; further failure waits for your judgment.

**Budget & deadline** contains an optional goal token limit and deadline that stops work. Open **Edit goal** to change the name, outcome or success criteria. Limit holds have an **Adjust limits** action in the same workspace; existing scheduling overrides are preserved. Planning and final review share daily and goal allowance with task execution. Missing usage retains the call's reservation; recorded token limits are not guaranteed provider billing ceilings. **Stop work** cancels this goal's coordination and active tasks. Reloading retains the plan and progress. Interrupted planning/review requires explicit continuation; completed task plans are not regenerated after restart. Manual mission acceptance remains available for goals managed without the automatic conductor.

Open **More → Operations** or use the command bar for delivery, repository setup, reliability and activity. Configure delivery commands in repository settings before using them. See [Conductor operations](operations.md) for the complete workflow and limits.

Before your first agent run, use **Verify repository setup** in Settings to rehearse installation and tests against the local default branch without spending agent tokens. Save verification routes as named templates, or import a template to preview its rules before applying them. The [product status](roadmap.md) describes available capabilities and current limits.
