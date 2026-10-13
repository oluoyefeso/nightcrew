# Conductor operations

These features run locally in the open-source edition. Managed mode remains **Coming soon**.

## Verify repository setup

In repository Settings or the Operations setup section, choose **Verify repository setup**. The local runner checks out the current commit of the repository's local default branch, runs the saved install command (if configured), then the saved test command. This spends no agent tokens and preserves your working directory, including uncommitted changes. Those uncommitted changes are not part of the verification.

The result records the branch, commit, outcome and redacted diagnostics. A changed branch head, repository path, install command or test command makes the result outdated. Changed settings while waiting or during setup prevent the old command from continuing. Setup and tests must preserve the pinned source files. Verification runs as a background operation with individual stop and restart interruption handling.

This is an optional rehearsal, not a new dispatch gate or an authority promotion. It verifies installation and tests; it does not verify agent sign-in, preview screenshots, remote branch freshness or deployment access. Task-specific checks still run on each task's changes.

## Live operation progress

Mission acceptance and delivery start as background operations owned by your local runner. You can navigate away, reload, or close the browser while the runner keeps working. **Operations** shows all active jobs and the latest 30 finished jobs, with the three most recent shown initially. The mission page also shows its latest verification operation. Open an operation to inspect its exact saved result, even after later checks have run. Direct result links also work for older delivery, mission and repository checks; saved outcomes are historical evidence, not a claim of current readiness.

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

## Agent usage by phase

New local runs show **Agent usage by phase** in the run detail pane and activity page. Each plan, build, repair, research call and independent review records its requested model, outcome, elapsed time, input/output tokens, cost, turns and configured limits. Repeated reviews remain separate. Older runs keep their existing activity and totals; missing phase measurements are not reconstructed as zero usage.

Input includes cache reads and writes. Reported tokens above a phase limit appear as an overshoot: provider usage arrives during or after a call, so cancellation cannot guarantee an exact ceiling. A partial stream retains observed tokens while missing cost and turn totals remain unknown. A phase interrupted before its result is saved remains visible, with unknown usage. Measurements contain numerical usage and execution metadata, without adding prompts, tool arguments, session handles or error text to the measurement records. Existing activity logs and artifacts retain their own content.

A successful agent call is not task or mission acceptance. Use the checks, evidence and reviewer verdicts to judge the result. These measurements are a foundation for comparing resource use across attempts; they do not yet provide a mission-wide cost-per-accepted-outcome report or enforce an overall mission runtime.

## Mission controls and acceptance

Set mission acceptance criteria, a token limit, priority (Normal through Urgent), and an optional start deadline when creating or editing a mission. The dashboard uses your browser’s local timezone and stores the deadline in UTC; the API accepts an ISO date with a timezone. New dashboard missions start paused by default so you can review the plan; API clients retain the active default unless they send `paused: true`. Higher priorities go first; deadlines break ties, followed by queue position. Dependencies, schedules, repository capacity and verification setup still apply. A passed start deadline holds new starts; it does not terminate an active agent. Pause has the same active-run behavior.

Mission token usage is charged at dispatch, across retries. Changing membership or deleting a task does not refund it. Running tasks reserve their remaining task caps. Migration assigns historical local attempts to each task's mission at upgrade time. Unassigned and classic work is not retroactively charged. Token limits govern dispatch capacity; provider token accounting can arrive after a model turn, so they are not financial guarantees. Command execution has timeouts rather than a token cost.

Draft work from the mission to have the composer propose tasks, prerequisites and a final integration check using its objective and criteria. Review drafts before dispatch. Each draft can link to the exact mission criteria it supports; the batch shows missing links, and the mission page shows coverage across saved tasks. Links describe planned work, not proof of completion or a dispatch gate. If criteria change, outdated links remain visible until repaired in the task editor. Moving a task to another mission clears its old links.

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

Select a saved template to rename it or change its rules, then choose **Update saved template**. Changes to the library do not alter repository copies. Updates and deletes require the version you previewed; if another window changed it, reload the saved version before continuing. Deleting a template keeps repository routes intact.

**Export preview** downloads a versioned JSON file containing only the template name and task rules. **Import verification template** accepts that format, validates its fields, and previews it without saving or dispatching anything. Choose **Save as template** to keep it in the library or **Save task routes** to apply the preview to the current repository. Imports reject unsupported versions, extra fields and invalid policies. Review template names before sharing them; names are user-authored text.

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

### Delivery eligibility and saved results

Operations evaluates each stage against the current local branch head, saved delivery/setup settings, required environment names, and complete attempt history for that commit. A stage needs its preceding passing result with matching settings. Deploy/release attempts that passed or were interrupted remain held to prevent duplication; inspect an interrupted result before acknowledging a manual retry. Failed attempts also hold automatic progression. The preview explains manual-only authority, paused dispatch, disabled publishing, changed settings and exhausted stages separately from manual eligibility.

Dashboard requests include the preview fingerprint. A changed branch, repository path or configuration rejects the stale request before starting a command. Integrations may supply the same optional `fingerprint` from authenticated `GET /api/repos/:id/delivery-readiness`; older clients retain their existing behavior and all execution checks. Environment values never appear in readiness responses. Eligibility does not confirm provider health or external deployment state, and the runner does not fetch remote changes for you.

`GET /api/results/:kind/:id` returns the requested saved result for `delivery`, `mission` or `repository`. These launch-key-protected responses are uncached. Operation pages use their saved `resultId`; they never substitute the latest result. A missing result is reported explicitly. Delivery history in Operations is bounded to the latest 100 records across repositories; a known result link remains accessible beyond that window while its record exists.

## Attention and review

Station includes unreviewed failed and interrupted operations in its decision count. **Operations → Needs attention** retains them independently of the recent-job window. The list initially previews three items; expand it, filter by operation kind and outcome, or load older pages of 30 items. Section links jump directly to running work, delivery, setup or activity. Repository setup, mission acceptance and delivery share this list, including validation failures with no command result. Earlier failed operations appear after upgrading; a later pass does not silently acknowledge them.

Open an operation, inspect its message and exact saved result, then choose **Mark reviewed**. The acknowledgement persists across restarts and is recorded in local activity history. It clears attention only: the operation status, result, retry guards and publishing authority remain unchanged. Interrupted delivery still needs its separate external-outcome acknowledgement before a manual retry. Active and passing jobs cannot be marked reviewed; stale operation versions are rejected.

Authenticated `GET /api/operations/attention` returns a filtered total, jobs and `nextCursor`. Optional `kind`, `status` and `before` parameters select the list. `POST /api/operations/:id/review` requires `expectedUpdatedAt` from the inspected job. Review is idempotent for that version and never executes work.

Station’s **Next departures** can be filtered by repository and departure reason, with an option to show every matching queued task. These controls help locate holds without changing dispatch order or bypassing limits.

## History and reliability

Operations includes an append-only action history of repository changes, task edits, recoveries, run outcomes and delivery stages. It records field names and identifiers instead of settings values, credentials or command output. This local SQLite history is an operational aid, not a tamper-proof compliance log.

Reliability covers the most recent 100 local attempts, with ready rates for the latest and preceding 20 finished attempts. Reviewer readiness is not a guarantee of correctness. Use real evidence and enough observations before increasing authority. Repository setup indicators distinguish configured tests, UI preview, routes and delivery; they do not prove those commands work.
