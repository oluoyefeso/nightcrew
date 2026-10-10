# Security

NightCrew runs agents unattended, so nobody is there to approve each command. Three layers keep them in their lane: the guard, the OS sandbox and a push block. None of them is a reason to point NightCrew at a repo or a machine you can't afford to have an agent touch.

## The guard

Every tool call goes through the guard before it runs. It refuses:
- writes outside the task's worktree and NightCrew's artifact folder, and outside the task's scope globs,
- `.github/workflows/`, `.env` files, keys and `.git`, whatever the scope says,
- reading secrets files,
- `git push`, history rewrites, `git reset --hard`, `git clean -f`, changing remotes or git config, deleting branches and tagging,
- checking out or moving a protected branch,
- `gh pr`, `gh api` and friends (NightCrew opens the pull request itself),
- publishing packages, global installs, system package changes, `sudo`,
- network writes with `curl` or `wget` (POST, PUT, uploads),
- `rm -r` aimed at `/`, `~` or outside the worktree.

The guard is a **policy layer, not a sandbox**. It reads commands as text, and a determined agent can phrase a command it doesn't recognise. It catches the honest mistakes; the next two layers are for the rest.

## The OS sandbox (local engine)

On the local engine, Bash runs inside the operating system's sandbox: Seatbelt on macOS, bubblewrap on Linux. A command can only write to:
- the task's worktree, and its own git data (not the repo's hooks or config),
- NightCrew's artifact folder,
- the temp folder,
- package manager caches (`~/.npm`, `~/.bun/install/cache`, `~/.cache` and similar), so installs work.

Anything else fails with "operation not permitted". `echo >> ~/.zshrc` does nothing. The agent can't ask to run a command outside the sandbox.

Network stays open, because tests and installs need it. The guard still refuses network writes.

On Linux the sandbox needs `bubblewrap` (and `socat`). Without them, Bash runs unsandboxed with the guard only. Install them: `sudo apt install bubblewrap socat`.

File edits (Write, Edit) don't run in the sandbox; the guard checks each path instead.

## The push block

NightCrew pushes task branches itself, after checks pass. The agent's own processes get git config that rewrites every push to a real remote (`https://`, `ssh://`, `git@`) to an address git can't reach, so `git push` fails even when the guard misses it. Fetching still works. This only applies to the agent; NightCrew's own pushes are unaffected.

It's a second line, not a wall: a command that clears its own environment, or a remote with an explicit `pushurl`, gets past it. Branch protection on GitHub is the real backstop.

## The dashboard API

The API listens on `127.0.0.1` only, and it checks every request:
- the `Host` header must name `localhost`, `127.0.0.1` or `[::1]`, which stops DNS rebinding,
- requests that change something must be JSON and same-origin, so a web page you visit can't start, stop or merge tasks.

Don't expose the port to a network. To reach NightCrew from another device, use an SSH tunnel.

## Managed mode

In [managed mode](managed.md) the agent works in Anthropic's cloud sandbox, not on your machine. Every shell, write and edit call is held for confirmation and decided by the same guard; read-only tools run on the server's `auto` policy.

The sandbox mounts your repo with the GitHub token from `gh auth token`. That token can do whatever your account can, so for unattended runs:
- use a **fine-grained token** limited to the repos NightCrew works on, with contents and pull requests access only,
- turn on **branch protection** for your default branch and your ship branch, so nothing lands there without the checks you require.
