# Managed mode (experimental)

```bash
ANTHROPIC_API_KEY=sk-… nightcrew --engine managed
```

With the managed engine, each phase runs on **Claude Managed Agents** instead of your machine: an Anthropic-hosted agent in a cloud sandbox with the task's GitHub repo mounted.

## How a phase runs

1. NightCrew pushes the task branch so the sandbox can check it out. It never pushes a protected branch.
2. It creates a session with:
   - the repo mounted at `/workspace/<repo>`,
   - a short-lived GitHub token from `gh auth token`, used for that one session and never stored,
   - a budget from the task.
3. The cloud environment's networking is **limited** to GitHub and package registries. (An environment created without a networking setting gets unrestricted access, so NightCrew always sets one.)
4. The agent works, commits, and pushes the task branch. Pushing that branch is the only push allowed. The server's `auto` permission policy decides routine calls; anything it can't judge is answered by NightCrew's guard.
5. NightCrew fetches the branch back and fast-forwards the local worktree. The rest of the pipeline then runs as usual: checks, evidence, the Skeptic, the trust ladder.

## Requirements and limits

- An Anthropic org with Managed Agents enabled, and `ANTHROPIC_API_KEY`.
- The repo needs a GitHub remote, and `gh auth login`.
- NightCrew still orchestrates from a machine that's on. To close the laptop, run `nightcrew` on any always-on box. With the managed engine that box needs no language toolchains.
- Managed Agents is in beta and not eligible for zero data retention. Use the local engine for repos that must stay on your machine.
- Structured output is requested in the prompt and parsed from the reply.

## Not yet verified against the live API

The engine is tested against the SDK's types and a fake client, not live sessions.
- **Authenticated push.** The docs don't say whether `git push` from the sandbox is authenticated by the mounted repo's token. If it isn't, write phases end without changes to pull, and the run fails with a clear message.
- **The `auto` policy.** It might deny the branch push.
