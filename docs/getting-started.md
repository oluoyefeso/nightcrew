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
- **install**: `bun install --frozen-lockfile`, `npm ci` and so on, run in each fresh worktree
- **preview**: how to start the app for UI screenshots (Vite, Next, Astro, any `dev` script, or `static` for plain HTML)

Check them in **Settings → Repos**. Without a test command, NightCrew can't verify the crew's work. Without a preview command, UI tasks have no screenshots and always land in Needs your eyes.

## 3. Open the dashboard

```bash
nightcrew
```

It opens at `http://localhost:3721` and keeps the nightly schedule while it runs. Your data lives in `~/.nightcrew`.

## 4. Plan tonight

On **Tonight**, describe the work like you'd brief a contractor. Several things at once is fine:

> Dark mode that follows the system. Also the crash when a widget has no title. Don't touch billing.

The crew drafts one card per piece of work. Each card has a repo, a type, a scope (the files it may change), acceptance criteria, and a question if something is unclear. Fix anything that's off, then **Queue**. Drag to reorder. Parked work goes to **Later**.

From a terminal: `nightcrew add "…"`.

## 5. Let it run

The crew starts at 22:00 by default, or press **Run now**. Watch any task live from the strip at the top of Tonight. Stop it at any time; unfinished work is kept on its branch.

## 6. Clear the Morning Report

| Key | Does |
|---|---|
| `J` / `K` | Move between tasks |
| `1` (twice) | Merge the PR |
| `2` | Send back with a note; it runs again tonight on the same branch |
| `3` | Dismiss, or take a task off the nightly train |
| `H` | Try again tonight |
| `U` | Undo the last decision, or undo a ship to dev |
| `⌘K` | Command bar |

## Trying it without spending anything

```bash
nightcrew --demo
```

The demo crew narrates believable steps and writes a small file inside each task's scope. Nothing is pushed.
