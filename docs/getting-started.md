# Getting started

## 1. Install

```bash
curl -fsSL https://raw.githubusercontent.com/oluoyefeso/nightcrew/main/install.sh | sh
```

You also need `git`, the GitHub CLI logged in (`gh auth login`), and Claude: either Claude Code logged in on this machine, or `ANTHROPIC_API_KEY` in your environment.

## 2. Add a repo

```bash
cd ~/code/my-app
nightcrew repo add
```

NightCrew reads the repo and fills in what it can:

- **tests**: `bun run test`, `npm test`, `cargo test`, `go test ./...`, `pytest -q` or `make test`
- **install**: `bun install --frozen-lockfile`, `npm ci` and so on, run in each task's fresh clone
- **preview**: how to start the app for UI screenshots (Vite, Next, Astro, any `dev` script, or `static` for plain HTML)

Check them in **Settings → Repos**. Without a test command, NightCrew can't verify the crew's work. Without a preview command, UI tasks have no screenshots and always land in Needs your eyes.

## 3. Open the dashboard

```bash
nightcrew
```

It prints a link like `http://localhost:3721/?t=…` and opens it in your browser. The link carries a key that changes every launch, so only it opens the dashboard. With `--no-open`, or after a restart, open the link it just printed; an old tab shows a page saying so.

While it runs, agents pick up work as soon as it's queued. Your data lives in `~/.nightcrew`. Each task runs in its own clone of the repo under `~/.nightcrew/work` and lands back in your repo as a commit.

## 4. Give the agents work

On **Agents**, describe the work like you'd brief a contractor. Several things at once is fine:

> Dark mode that follows the system. Also the crash when a widget has no title. Don't touch billing.

The crew drafts one card per piece of work. Each card has a repo, a type, a scope (the files it may change), acceptance criteria, and a question if something is unclear. Fix anything that's off, then:

- **Run now**: agents start as soon as a slot is free (the default),
- **Schedule**: hold until the schedule time, such as off-peak,
- **Save to Later**: park it.

From a terminal: `nightcrew add "…"` (add `--schedule` or `--later`).

## 5. Watch, or don't

**Agents** shows every agent working: phase, last step, elapsed time, and a Stop button. Stop one and its work so far stays on its branch. **Pause dispatch** lets running agents finish but starts nothing new. Turn on desktop or Slack notifications in Settings to hear when an agent finishes or needs you.

## 6. Judge the reports

Reports land in the **Inbox** as agents finish. Today's Inbox shows who's still working at the top.

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
