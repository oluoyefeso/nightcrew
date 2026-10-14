# NightCrew product roadmap

NightCrew helps people set a goal, delegate execution and judge the result through evidence. As agents improve, routine use should require less human coordination. We measure progress by verified outcomes, resource use and the attention required from the person.

The open-source local edition is the core product. Managed mode remains **Coming soon**. Planned work below is not a claim of shipped autonomous planning or model support.

## Current foundation

- Cross-day decisions, task scopes, repository authority and independent reviews.
- Missions, prerequisites, priorities, resource limits and saved execution stop times.
- Checkpoint recovery, bounded retries and usage measurements that retain partial or unknown accounting.
- Human-attested objective acceptance with combined repository checks.
- Opt-in check → deploy → release commands, persistent operation results and attention handling.

## Delivery sequence

### 1. Make goals the everyday experience — available in alpha.15

Bring the primary navigation down to Home and Goals, with operational destinations still reachable through More and search. Start a goal from an outcome; reveal naming, scheduling and resource overrides when needed. Keep pause, authority and budget behaviour explicit.

Acceptance: create and reopen a goal with minimal input; advanced values survive submission; all existing destinations work on phones and desktop; decisions and evidence remain accessible. Existing mission IDs, URLs and API contracts stay compatible. A saved goal does not imply work has automatically started.

Visual reference: [Linear](https://linear.app/) and [Linear's agent presentation](https://linear.app/ai). Use a clear type hierarchy, compact navigation, quiet separators, restrained colour and concrete product examples. Verify both themes and mobile layouts.

### 2. Put decisions and evidence inside the goal — next

Make one goal workspace explain the objective, current progress, what needs judgment and the latest verified results. Open an outcome to inspect its preview, checks, changes and concise decision rationale. Link external sources when they materially support a decision. Keep logs, worktrees and phase measurements available as detail.

Acceptance: a person can understand the next useful action without opening every agent; resolved tasks cannot imply objective acceptance; failed, partial and stale evidence remain visible and tied to the relevant attempt and revision.

### 3. Let users bring their models — planned

Introduce user-owned model connections: local inference runtimes, direct providers and gateways such as OpenRouter. Extend the existing engine boundary with capability discovery and a shared tool/usage/cancellation contract. Start with one compatible endpoint adapter and a bounded read-only task before permitting edits.

Acceptance: register and check a connection, identify available models and supported capabilities, execute a synthetic task with evidence, and stop it cleanly. Keep credentials out of reports and exports. A local-only selection must never silently fall back to a remote provider. Report unsupported capabilities and unavailable usage honestly.

The aim is broad model choice. Tested capabilities determine which jobs a particular model/runtime can perform; connection alone is not proof of coding reliability.

### 4. Coordinate work within standing limits — planned

Have the crew propose task breakdowns, choose suitable models from the user's available pool, parallelise independent work, verify results and recover within saved limits. Preserve user overrides and explain consequential route changes. Request human judgment when ambiguity or authority requires it.

Acceptance: bounded retries, resource reservations for verification, restart recovery, authority enforcement and no-progress handling work across attempts. More agents must not create more routine approval work. Evaluate whole-goal outcomes and human interventions rather than token savings alone.

### 5. Take on ongoing responsibilities — later

Build recurring responsibilities on reliable delivery observation and durable execution. Begin with one bounded responsibility such as investigating a failed check. Preserve causal evidence, deduplicate repeated events and stop unproductive repair loops.

## How we ship

Use NightCrew for bounded implementation and research, inspect its artifacts, then independently verify and integrate the result. Work directly when orchestration blocks delivery and record concrete failures for improvement. Each slice includes appropriate checks, desktop/mobile review for UI changes and accurate landing-page copy. Releases are checkpoints; persist the next action after each slice.

Efficiency, hardware scheduling and inference research support this sequence when measured failures justify them. They are not prerequisites for making the everyday experience simpler. Provider-specific deployment health, external rollback and autonomous semantic acceptance remain future work.
