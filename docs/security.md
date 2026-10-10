# Security

NightCrew runs agents unattended, so nobody is there to approve each command. Several layers keep them in their lane: the guard, the OS sandbox for the agent, the sandbox for checks, a stripped environment, a push block and branch pinning. None of them is a reason to point NightCrew at a repo or a machine you can't afford to have an agent touch.

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

The guard is a **policy layer, not a sandbox**. It reads commands as text. Shell tricks it can't see through (a script file, `eval`, variables, base64, another interpreter) get past it. It catches the honest mistakes; the layers below are for the rest.

## The agent's OS sandbox (local engine)

On the local engine, the agent's Bash runs inside the operating system's sandbox: Seatbelt on macOS, bubblewrap on Linux. A command can only write to:
- the task's worktree,
- the git data a commit on the task's own branch needs: new objects, that branch's ref, its reflog, the worktree's index, and `refs/stash`,
- NightCrew's artifact folder,
- the temp folder,
- package manager caches (`~/.npm`, `~/.bun/install/cache`, `~/.cache` and similar), so installs work.

Inside the repo's `.git` it can't write main, the ship and train branches, any other existing branch, tags, `packed-refs`, other worktrees, its own `HEAD`, the `.git` pointer file, `commondir`, hooks, config, legacy `remotes/`, submodules or alternates. So `git commit` and `git stash` work, and `git update-ref refs/heads/main HEAD` fails with "operation not permitted". Anything else outside the list above fails the same way: `echo >> ~/.zshrc` does nothing. The agent can't ask to run a command outside the sandbox.

Network stays open, because tests and installs need it. The guard still refuses network writes.

File edits (Write, Edit) don't run in the sandbox; the guard checks each path instead.

Known gaps:
- **Linux without bubblewrap.** The sandbox needs `bubblewrap` (and `socat`). Without them, Bash runs unsandboxed with the guard only. Install them: `sudo apt install bubblewrap socat`.
- **New branch names.** The agent can create a branch under a name that doesn't exist yet and isn't protected. It can't move one NightCrew relies on.
- **Package caches are writable.** A command can plant something in `~/.npm` or `~/.cache` that a later install on this machine picks up.
- **Reads aren't limited.** The sandbox limits writes. A command can still read files your user can read, such as `~/.config/gh/hosts.yml` or `~/.aws/credentials`, and the network is open. The guard refuses reading the common secrets files by name, but a shell trick gets past that.

## The sandbox for checks

NightCrew runs the repo's own commands (setup, tests, previews) itself, outside the agent. Those run sandboxed too, with `sandbox-exec` on macOS and `bwrap` on Linux. They can write to the task's worktree, temp and package caches, and nowhere else. So a test the agent wrote can't append to `~/.zshrc` either, as long as the sandbox is available (macOS, or Linux with bubblewrap).

Where no sandbox is available, checks run unsandboxed and NightCrew warns once. `NIGHTCREW_UNSANDBOXED_CHECKS=1` turns the check sandbox off on purpose, for test suites that need to write elsewhere; then a test can write anywhere your user can.

## Credentials stay out of the agent's environment

The agent's processes and the check commands get NightCrew's environment minus credentials: `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_PAT`, `NPM_TOKEN`, `NODE_AUTH_TOKEN`, `GOOGLE_APPLICATION_CREDENTIALS`, `TYPESAFE_API_KEY`, and everything starting with `AWS_`, `AZURE_` or `SLACK_`. The agent keeps `ANTHROPIC_*` and `CLAUDE_*`, because the Claude process needs them to sign in; checks don't get those either.

This covers tokens in environment variables only. Tokens a tool keeps in a file or the system keychain are still readable (see the gaps above).

## The push block

NightCrew pushes task branches itself, after checks pass. The agent's own processes get git config that sends every push to an address git can't reach, so `git push` fails even when the guard misses it:
- pushes to any `https://`, `http://`, `ssh://`, `git://` or `git@` URL are rewritten,
- `origin` gets a blocked push URL, which also covers an ssh alias such as `gh:acme/widgets`.

Fetching still works. This only applies to the agent; NightCrew's own pushes are unaffected.

It's a second line, not a wall. Known gaps: a remote other than `origin` that uses an ssh alias, a remote with its own `pushurl` in the repo config, and a command that clears its own environment all get past it. Branch protection on GitHub is the real backstop.

## Branches NightCrew protects

NightCrew pins each task's base commit when the task starts, so later work is compared against what the task actually started from. During a task run the ship and train branches are protected, for the guard and for the agent's sandbox, as well as the repo's default and listed protected branches. Integration worktrees are reset each time they're reused, so nothing an earlier run left behind carries over.

## The dashboard API

The API listens on `127.0.0.1` only, and it checks every request:
- each launch makes a new API token. The dashboard link `nightcrew` prints and opens carries it once; the dashboard swaps it for an HttpOnly, SameSite=Strict cookie,
- every `/api` call needs that token, so another local user or a web page can't use the API without it,
- requests that change something also need an `Origin` that exactly matches the dashboard's,
- the `Host` header must name `localhost`, `127.0.0.1` or `[::1]`, which stops DNS rebinding.

Don't expose the port to a network. To reach NightCrew from another device, use an SSH tunnel.

## Managed mode

In [managed mode](managed.md) the agent works in Anthropic's cloud sandbox, not on your machine. Every shell, write and edit call is held for confirmation and decided by the same guard; read-only tools run on the server's `auto` policy. Paths under the sandbox's `/workspace/<repo>` mount, in file paths and in shell commands, are mapped to the local worktree for the guard's decision, so `rm -rf /workspace/<repo>/dist` is judged as a delete inside the worktree. The agent's call runs as it sent it.

The sandbox mounts your repo with the GitHub token from `gh auth token`. That token can do whatever your account can, so for unattended runs:
- use a **fine-grained token** limited to the repos NightCrew works on, with contents and pull requests access only,
- turn on **branch protection** for your default branch and your ship branch, so nothing lands there without the checks you require.
