# Security

NightCrew runs agents unattended, so nobody is there to approve each command. Several layers keep them in their lane: a separate clone per task, the guard, the OS sandbox for the agent, the sandbox for checks, one stripped environment, a push block, and landing by commit SHA. None of them is a reason to point NightCrew at a repo or a machine you can't afford to have an agent touch.

## Each task works in its own clone

Every task gets a standalone clone of your repo at `<data>/work/<repo id>/<task id>`, outside your repo (the data dir is `~/.nightcrew` unless you pass `--data`). NightCrew makes it before any agent runs (`git clone --shared`, which borrows your repo's objects read-only without copying them), checks out the task branch at the pinned base commit, and removes the clone's remote.

If you delete a clone, the next run makes a new one that resumes from the task's last saved work, `refs/nightcrew/tasks/<task id>` in your repo.

Repos that use git-lfs, git-crypt or a sparse checkout are refused for now, with a message saying so. Supporting them is on the list.

The agent can change anything inside its clone, its own `.git` included: branches, hooks, config, refs. None of that reaches your repo. Your repo's branches, hooks, config and worktrees are never shared with it.

NightCrew never runs unsandboxed git inside a clone. Its own git commands there (status, add, commit) run through the check sandbox below, and their output is treated as advisory.

## Results are checked in your repo, by commit SHA

When the agent is done, NightCrew fetches the task branch from the clone into your repo as `refs/nightcrew/tasks/<task>` and reads its commit SHA. Everything that decides whether the work can ship runs in your repo against that SHA and the pinned base:
- the result must contain the pinned base, or NightCrew refuses it,
- the changed files come from `git diff` between the two, failing closed if git fails,
- the scope and protected-path checks, the diff stats and the commit count use the same pair.

Draft PRs, trains and ship merges all use that SHA, never a branch name. After a merge, NightCrew checks the diff that actually landed against the same scope and protected-path rules, so a merge can't bring in files the task's own diff didn't show. NightCrew pushes the task branch from your repo as `<sha>:refs/heads/<branch>`, so nothing the agent did to branch names in its clone changes what lands. Integration worktrees (for the ship branch and trains) are worktrees of your repo that only NightCrew writes, reset each time they're reused. Landing records live under `~/.nightcrew/landing/`, not inside any `.git`.

NightCrew's own git commands, in your repo and everywhere else, run with hooks off (`core.hooksPath=/dev/null`), no fsmonitor, no replace objects (`GIT_NO_REPLACE_OBJECTS=1`) and no terminal prompts. A hook or a replace ref planted in a clone does nothing when NightCrew fetches from it.

## The guard

Every tool call goes through the guard before it runs. It refuses:
- writes outside the task's clone and NightCrew's artifact folder, and outside the task's scope globs,
- `.github/workflows/`, `.env` files, keys and `.git`, whatever the scope says,
- reading secrets files,
- `git push`, history rewrites, `git reset --hard`, `git clean -f`, changing remotes or git config, deleting branches and tagging,
- checking out or moving a protected branch,
- `gh pr`, `gh api` and friends (NightCrew opens the pull request itself),
- publishing packages, global installs, system package changes, `sudo`,
- network writes with `curl` or `wget` (POST, PUT, uploads),
- `rm -r` aimed at `/`, `~` or outside the clone.

The guard is a **policy layer, not a sandbox**. It reads commands as text. Shell tricks it can't see through (a script file, `eval`, variables, base64, another interpreter) get past it. It catches the honest mistakes; the sandboxes below are the backstop for the rest.

## The agent's OS sandbox (local engine)

On the local engine, the agent's Bash runs inside the operating system's sandbox: Seatbelt on macOS, bubblewrap on Linux. A command can only write to:
- the task's clone, all of it,
- NightCrew's artifact folder,
- the temp folder,
- package manager caches (see the list under checks), so installs work.

So `git commit`, `git stash` and submodules work in the clone, and `echo >> ~/.zshrc` fails with "operation not permitted". The agent can't ask to run a command outside the sandbox.

Whether a phase runs in a task's clone comes from NightCrew's own records, never from files in the clone, which the agent can change. Before each phase NightCrew checks that the clone's `.git` is still a real folder; if the agent replaced it with a pointer file or a symlink, the phase doesn't run and the task fails as tampered with. Phases outside a clone (composing tasks, in your repo's main checkout) can't write its refs, `HEAD`, index, hooks, config, remotes, submodules or alternates.

Tasks started before 1.0 may still have an old linked worktree under `<repo>/.worktrees/`. NightCrew gives them a fresh clone at their branch tip.

Network stays open, because tests and installs need it. The guard still refuses network writes.

File edits (Write, Edit) don't run in the sandbox; the guard checks each path instead.

## The sandbox for checks

NightCrew runs the repo's own commands (setup, tests, previews) and its git commands inside clones itself, outside the agent. Those run sandboxed too, with `sandbox-exec` on macOS and `bwrap` on Linux. As with the agent, NightCrew's records say whether a command runs in a task's clone; the clone's `.git` is never read to decide what it may write. They can write to:
- the clone, `.git` included, so submodules and stash work,
- the temp folders,
- `/dev/null`, `/dev/zero`, `/dev/random`, `/dev/urandom` and `/dev/fd`, not the rest of `/dev`,
- the package caches: `~/.npm`, `~/.bun/install/cache`, `~/.cache`, `~/.pnpm-store`, `~/Library/pnpm`, `~/.yarn`, `~/Library/Caches`, `~/.cargo/registry`, `~/.cargo/git`, `~/go/pkg/mod`, `~/.local/share/uv`.

Checks in NightCrew's own worktrees of your repo (integration worktrees for the ship branch and trains, and the base worktree used for before-and-after evidence) can write only that worktree's folder, minus its `.git` pointer file. None of your repo's git data is writable from there: not the worktree's git dir, not your repo's hooks or config, and not its `lfs` or `modules` folders.

Checks run without your terminal: each starts in a new session with no controlling terminal, so it can't open `/dev/tty`, and on macOS the profile also blocks terminal ioctls, so it can't type into the terminal NightCrew was started from.

On macOS the profile also stops a command from starting work outside the sandbox: `launchctl`, `open` and `osascript` can't run, and the LaunchServices and Apple Events services are blocked, so a test can't open a `.command` file in Terminal, submit a launchd job or script another app.

On Linux, bubblewrap starts each check in a new session, with its own process namespace and a private `/tmp`, and stops it if NightCrew exits. Cache folders are created before they're mounted, so a first install fills the real cache.

Where no sandbox is available (Linux without bubblewrap), checks run unsandboxed and NightCrew warns once. `NIGHTCREW_UNSANDBOXED_CHECKS=1` turns the check sandbox off on purpose, for test suites that need to write elsewhere; then a test can write anywhere your user can.

## One credential policy

The agent's processes and the check commands get NightCrew's environment minus credentials, by one shared rule:
- by name: `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `NPM_TOKEN`, `NODE_AUTH_TOKEN`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AZURE_CLIENT_SECRET`, `GOOGLE_APPLICATION_CREDENTIALS`, `SSH_AUTH_SOCK`, `GIT_ASKPASS`, `SSH_ASKPASS`, `SUDO_ASKPASS`,
- by pattern: any name containing `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `API_KEY`, `APIKEY`, `PRIVATE_KEY`, `ACCESS_KEY`, `CREDENTIAL`, `WEBHOOK` or `CONNECTION_STRING`, or `_AUTH` as a word (such as `NPM_CONFIG__AUTH`),
- any name ending in `_KEY`, `_DSN`, `_PAT` or `_PWD` (`STRIPE_KEY`, `SENTRY_DSN`, `GITHUB_PAT`, `MYSQL_PWD`; `PWD` itself stays),
- database and queue URLs, which carry their password: `DATABASE_URL`, `DB_URL`, `REDIS_URL`, `MONGO_URL`, `MONGODB_URI`, `AMQP_URL`, `POSTGRES_URL`, `MYSQL_URL`, `RABBITMQ_URL` and the same with a prefix, such as `CACHE_REDIS_URL`,
- git variables that point at another repo, such as `GIT_DIR` and `GIT_WORK_TREE`.

Config stays: `AWS_REGION`, `AWS_DEFAULT_REGION`, `AWS_PROFILE`, `AWS_ENDPOINT_URL` and `TOKENIZERS_PARALLELISM` are kept by name, and names like `NODE_ENV` or `API_URL` match nothing. The agent keeps `ANTHROPIC_*` and `CLAUDE_*`, because the Claude process needs them to sign in; checks don't get those.

This covers tokens in environment variables only. Tokens a tool keeps in a file are still readable (see the gaps below).

## The push block and credential helpers

NightCrew pushes task branches itself, from your repo, after checks pass. The agent and the checks both get git config that outranks your system, global and repo config:
- pushes to any `https://`, `http://`, `ssh://`, `git://` or `git@` URL are rewritten to an address git can't reach,
- `origin` gets a blocked push URL, which also covers an ssh alias such as `gh:acme/widgets`,
- `credential.helper` is reset to empty, so the macOS keychain, `gh auth git-credential` or any other helper can't hand git a token,
- `core.askPass` is emptied and terminal prompts are off, so nothing asks for one.

A clone has no remote at all. Fetching from other remotes still works. NightCrew's own pushes are unaffected.

It's a second line, not a wall. A remote other than `origin` that uses an ssh alias, an ssh key on disk, and a command that clears its own environment can all get past it. Branch protection on GitHub is the real backstop.

## Branches NightCrew protects

NightCrew pins each task's base commit when the task starts, so later work is compared against what the task actually started from. The repo's default branch, its listed protected branches and the ship and train branches are protected for the guard. Because results land by SHA from your repo, an agent can't move any of them: it only ever has its own clone's copies.

## The dashboard API

The API listens on `127.0.0.1` only, and it checks every request:
- each launch makes a new API token. The dashboard link `nightcrew` prints and opens carries it once; the dashboard swaps it for an HttpOnly, SameSite=Strict cookie,
- every `/api` call needs that token, so another local user or a web page can't use the API without it,
- requests that change something also need an `Origin` that exactly matches the dashboard's,
- the `Host` header must name `localhost`, `127.0.0.1` or `[::1]`, which stops DNS rebinding.

Don't expose the port to a network. To reach NightCrew from another device, use an SSH tunnel.

## Managed mode

In [managed mode](managed.md) the agent works in Anthropic's cloud sandbox, not on your machine. Every shell, write and edit call is held for confirmation and decided by the same guard; read-only tools run on the server's `auto` policy. Paths under the sandbox's `/workspace/<repo>` mount, in file paths and in shell commands, are mapped to the local clone for the guard's decision, so `rm -rf /workspace/<repo>/dist` is judged as a delete inside the clone. The agent's call runs as it sent it.

NightCrew pushes the task's starting point from your repo by SHA, fetches the result back into your repo as `refs/nightcrew/tasks/<task>`, and checks it there exactly as for the local engine. It runs no git of its own inside the clone outside the check sandbox.

The sandbox mounts your repo with the GitHub token from `gh auth token`. That token can do whatever your account can, so for unattended runs:
- use a **fine-grained token** limited to the repos NightCrew works on, with contents and pull requests access only,
- turn on **branch protection** for your default branch and your ship branch, so nothing lands there without the checks you require.

## Known gaps

- **Shell tricks get past the guard.** It reads commands as text. On the local engine the sandboxes are the backstop; they limit where a command can write, not what it tries.
- **Linux without bubblewrap.** Both sandboxes need `bubblewrap` (the agent's also needs `socat`). Without them, Bash and checks run unsandboxed with the guard only. Install them: `sudo apt install bubblewrap socat`.
- **Reads aren't limited.** The sandboxes limit writes. A command can still read any file your user can read, such as `~/.config/gh/hosts.yml`, `~/.aws/credentials` or `~/.ssh`, and the network is open. The guard refuses reading the common secrets files by name, but a shell trick gets past that.
- **Terminals in tests.** Checks can't open new pseudo-terminals (`/dev/ptmx` and `/dev/ttys*` aren't writable on macOS), so tests that spawn a pty fail inside the check sandbox.
- **Package caches are writable.** A command can plant something in `~/.npm` or `~/.cache` that a later install on this machine picks up.
- **Local services.** The network is open, including to services on this machine. Anything listening locally that runs commands (a Docker socket, an SSH server with your keys) is reachable.
- **Managed mode** relies on Anthropic's cloud sandbox and the guard's confirmations. NightCrew's own sandboxes don't apply there; the result is still checked in your repo by SHA before it lands.
