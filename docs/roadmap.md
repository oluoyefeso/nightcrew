# NightCrew product status

NightCrew helps people set a goal, delegate execution and judge the result through evidence. The open-source local edition is the core product. Managed mode remains **Coming soon**.

## Available in the local edition

- Home and Goals navigation, with operational destinations available through More and search.
- Goal workspaces with waiting decisions, run evidence, prior attempts and explicit outcome verification. Execution controls are available on demand.
- Outcome-first goal creation with optional success criteria, naming, scheduling and resource limits. New goals start paused by default.
- Cross-day decisions, task scopes, repository authority and independent reviews.
- Missions, prerequisites, priorities, token limits and saved execution stop times.
- Checkpoint recovery, bounded retries and usage measurements that retain partial or unknown accounting.
- Human-attested objective acceptance with combined repository checks.
- Opt-in check → deploy → release commands, persistent operation results and attention handling.
- Optional saved model connections, model discovery and bounded synthetic tool checks with inspectable results.

## Current limits

Creating a goal saves its objective; drafting tasks and starting execution remain separate steps. Resolved tasks do not establish objective acceptance. Verification records identify the criteria, checks and revisions they assessed, and changes can make those records outdated.

The local runner uses Claude Code. Repository authority, task limits and crew budgets govern execution. Usage reports reflect observed provider accounting and can be incomplete after interruption.

Model connections are diagnostics only and do not grant coding authority. Their explicit checks may use provider tokens separately from task and mission budgets.

See the [getting-started guide](getting-started.md) for setup and the [changelog](../CHANGELOG.md) for released changes.
