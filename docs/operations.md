# Conductor operations

These features run locally in the open-source edition. Managed mode remains **Coming soon**.

## Live operation progress

Mission acceptance and delivery start as background operations owned by your local runner. You can navigate away, reload, or close the browser while the runner keeps working. **Operations** shows all active jobs and the latest 30 finished jobs, with the three most recent shown initially. The mission page also shows its latest verification operation.

Progress distinguishes requirement checks, waiting for repository access, checkout preparation, repository setup, command execution and cleanup. Elapsed time includes waiting and cleanup. Command output is available in the completed verification/delivery result; progress is not a live terminal stream.

**Stop this operation** cancels only that operation, including a wait for repository access. Other operations and agents continue. **Stop running verification and delivery** still stops all operations. A stop cannot undo external side effects already performed. On a runner restart, unfinished operations become **Interrupted** and are never automatically replayed. Inspect any deployment outcome before allowing a manual retry.

For local integrations, authenticated `POST /api/repos/:id/deliver?background=1` and `POST /api/missions/:id/acceptance?background=1` return HTTP 202 with a saved operation ID. Poll `GET /api/operations/:id`, or request `POST /api/operations/:id/stop`. A 202 response acknowledges the job, not successful validation or completion: inspect its terminal status and `resultId`. Requests without `background=1` retain the synchronous result response. Existing launch-key, origin and publishing restrictions apply to both modes.

## Recovery

Open a task's Recovery panel:

- **Resume** reuses a completed plan or build when the task intent, notes, mission objective and saved commit still match. An incompatible checkpoint starts the ordinary workflow instead.
- **Verify saved build** requires a compatible build checkpoint. It reruns checks, evidence and read-only review, without implementation or repair. If the checkpoint changed, it stops and asks you to rebuild.
- **Rebuild** revisits the existing saved work with the normal planning/build workflow. It does not delete the branch or reset to the default branch.

Checks and merge authority are always evaluated again. A completed successful task rerun builds normally. Sending work back also rebuilds. Research tasks have no code checkpoint.

One failed validation can invoke one repair. A flaky failed run can receive one automatic retry; rate limits and process interruptions allow at most two automatic retries. Counts survive a dispatcher restart. Explicit recovery resets the count. An interrupted run is retained as a failed attempt with a recovery explanation.

## Mission controls and acceptance

Edit a mission to set acceptance criteria, a token limit, priority (Normal through Urgent), and an optional ISO start deadline. Higher priorities go first; deadlines break ties, followed by queue position. Dependencies, schedules, repository capacity and verification setup still apply. A passed start deadline holds new starts; it does not terminate an active agent. Pause has the same active-run behavior.

Mission token usage is charged at dispatch, across retries. Changing membership or deleting a task does not refund it. Running tasks reserve their remaining task caps. Migration assigns historical local attempts to each task's mission at upgrade time. Unassigned and classic work is not retroactively charged. Token limits govern dispatch capacity; provider token accounting can arrive after a model turn, so they are not financial guarantees. Command execution has timeouts rather than a token cost.

Draft work from the mission to have the composer propose tasks, prerequisites and a final integration check using its objective and criteria. Review drafts before dispatch.

Task counts do not certify the objective. Acceptance requires:

1. Explicit, distinct mission criteria and your evidence note for each one.
2. Successful, ready latest attempts for all member tasks. Dismissed, undone, incomplete or removed train work blocks acceptance.
3. Code landed on the combined local branch: the configured delivery branch, a shared train branch, or the ship/default branch. Recorded squash-merged PRs can satisfy landing; review that the local branch contains their result.
4. Passing repository test commands in isolated checkouts of those pinned commits. Setup and checks must preserve tracked source files.

The acceptance record includes your evidence, check results and snapshot. Changes to the objective, criteria, member tasks, test/setup commands or branch heads invalidate it. This is conductor-attested objective acceptance with machine-run combined checks, not an autonomous semantic proof. Research-only missions rely on your evidence and ready research results.

## Reusable verification workflows

In a repository's **Routes by task type**, save the current rules as a named template. Load a template to preview the effective routes, then save to apply it. Templates are copied; editing a repository does not silently update other repositories.

Choose one to three independent review sessions per task type. Extra reviewers are read-only, receive the task and evidence, and must all approve. They use the configured review model, so independence means separate sessions, not different providers. Additional reviews consume the task's token allowance. Running work retains stricter requirements observed while it runs; a late increase can hold landing until fresh verification.

Templates never promote the repository's autonomy ceiling, remove protected-path rules, or remove mandatory UI/bug-fix evidence.

## Delivery commands

Configure **Settings → repository → Delivery**, then use **Operations**. Stages are check → deploy → release. Each stage must succeed on the same commit and policy before the next can start. The default is manual. Automatic authority can end after check, deploy or release; it operates while dispatch and publishing are enabled. Task merge authority is separate.

Use a local branch that you keep current. NightCrew does not automatically fetch it or infer your production environment. Commands run in detached, isolated checkouts, preserving your working directory. Existing setup runs first, without delivery credentials. Each stage times out after 15 minutes; setup has a 10-minute limit.

The command receives:

| Variable | Meaning |
|---|---|
| `NC_COMMIT` | Exact verified commit; deploy/release this revision |
| `NC_BRANCH` | Configured delivery branch |
| `NC_STAGE` | `check`, `deploy`, or `release` |

Commands must wait for the external outcome and exit nonzero on failure. A command that merely queues a job cannot prove deployment succeeded. Use an idempotent script that deploys `NC_COMMIT`, waits for rollout/health checks, and records the provider's deployment identifier. Release scripts should verify that revision is deployed before publishing it. The check command should cover combined tests and any required pre-release checks. NightCrew records command outcomes; it does not provide provider-specific health checks or automatic external rollback.

Credentials are opt-in environment **names**, such as `DEPLOY_TOKEN`, configured on the runner process. Do not paste secret values into commands or settings. Only deploy/release receive the selected variables. Setup and checks run without them. Known credential patterns and configured credential values are redacted from saved command output; keep scripts from printing secrets or transformed/encoded credentials. Logs stay in the authenticated local dashboard. Commands retain the runner's sandbox restrictions, including blocked Git pushes; use your deployment/provider API rather than Git push in these scripts.

A failed or interrupted external action is never automatically replayed. Inspect the provider first: an action may have succeeded before output or acknowledgement was lost. For an interrupted action, acknowledge that inspection in Operations to allow a manual retry. Run checks again and explicitly continue. Successful deployment/release stages cannot be repeated for the same commit. The stop control aborts running verification/delivery commands; an external side effect already performed is not undone.

## History and reliability

Operations includes an append-only action history of repository changes, task edits, recoveries, run outcomes and delivery stages. It records field names and identifiers instead of settings values, credentials or command output. This local SQLite history is an operational aid, not a tamper-proof compliance log.

Reliability covers the most recent 100 local attempts, with ready rates for the latest and preceding 20 finished attempts. Reviewer readiness is not a guarantee of correctness. Use real evidence and enough observations before increasing authority. Repository setup indicators distinguish configured tests, UI preview, routes and delivery; they do not prove those commands work.
