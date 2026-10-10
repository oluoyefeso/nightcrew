# Managed mode (experimental)

```bash
ANTHROPIC_API_KEY=sk-… nightcrew --engine managed
```

With the managed engine, each phase runs on **Claude Managed Agents** instead of your machine: an Anthropic-hosted agent in a cloud sandbox with the task's GitHub repo mounted.

## How a phase runs

1. NightCrew pushes the task's starting point from your repo, by commit SHA, to the task branch so the sandbox can check it out. It never pushes a protected branch.
2. It creates a session with:
   - the repo mounted at `/workspace/<repo>`,
   - a short-lived GitHub token from `gh auth token`, used for that one session and never stored,
   - a cost limit derived from the task's token budget (the session API only takes a cost limit).
3. The cloud environment's networking is **limited** to GitHub and package registries. (An environment created without a networking setting gets unrestricted access, so NightCrew always sets one.)
4. The agent works, commits, and pushes the task branch. Pushing that branch is the only push allowed. Every shell, write and edit call is held for confirmation (`always_ask`) and NightCrew's guard decides it, the same guard the local engine uses. The guard sees `/workspace/<repo>` paths, in file paths and shell commands, as the task's local clone, so cleaning `/workspace/<repo>/dist` is allowed and deleting the mount itself isn't. Read-only tools (read, glob, grep, web) run on the server's `auto` policy. Each guarded call costs a short round trip; if NightCrew goes away mid-session, the session waits and spends nothing.
5. NightCrew fetches the branch from GitHub into your repo as `refs/nightcrew/tasks/<task>` and checks that commit there: it must contain the pinned base, and the changed files and scope come from your repo's own `git diff`. Then it updates the task's local clone (`<data>/work/<repo id>/<task id>`, under `~/.nightcrew` by default) to that commit, with git running inside the check sandbox. If that clone was deleted, a new one starts from the task's last saved work, `refs/nightcrew/tasks/<task id>`. The rest of the pipeline runs as usual: checks, evidence, the Skeptic, the trust ladder. What lands is that commit SHA, not whatever the branch points to later.

## Requirements and limits

- An Anthropic org with Managed Agents enabled, and `ANTHROPIC_API_KEY`.
- The repo needs a GitHub remote, and `gh auth login`.
- The token can do whatever your GitHub account can. Prefer a fine-grained token limited to the repos NightCrew works on (contents and pull requests only), and turn on branch protection for your default branch and your ship branch. See [Security](security.md).
- NightCrew still orchestrates from a machine that's on. To close the laptop, run `nightcrew` on any always-on box. With the managed engine that box needs no language toolchains.
- Managed Agents is in beta and not eligible for zero data retention. Use the local engine for repos that must stay on your machine.
- Structured output is requested in the prompt and parsed from the reply.
- Repos that use git-lfs, git-crypt or a sparse checkout are refused for now, with a message saying so.

## Not yet verified against the live API

The engine is tested against the SDK's types and a fake client, not live sessions.
- **Authenticated push.** The docs don't say whether `git push` from the sandbox is authenticated by the mounted repo's token. If it isn't, write phases end without changes to pull, and the run fails with a clear message.
- **Confirmations.** Shell, write and edit calls should arrive as `ask` and wait for NightCrew's answer. The tests use a fake client, so the round trip hasn't been timed on a real session.
