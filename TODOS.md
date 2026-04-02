# NightCrew TODOs

## v2: Pipeline-First Task Format
**Priority:** P2 | **Effort:** S (human: ~30min / CC: ~10min)
**Depends on:** Real overnight usage data from v1

Write the spec for pipeline-first task format where tasks define which phases to run (plan, implement, review, QA) with per-phase model and template configuration. This is NightCrew's core differentiator from TaskSmith — gstack-style intelligence applied to overnight batch work. The v1 flat format is a strict subset of the pipeline format, so this is backward-compatible.

## Multi-Repo Project Manifest
**Priority:** P3 | **Effort:** S (human: ~4h / CC: ~20min)
**Depends on:** Actually using NightCrew across 2+ repos

Add a root manifest (`nightcrew.yaml`) that points to per-project task files, each scoped to a repo. Enables overnight runs across multiple repositories in sequence.

## Self-Review Loop
**Priority:** P2 | **Effort:** M (human: ~1 day / CC: ~30min)
**Depends on:** v1 working reliably overnight

After a task completes, spawn a second Claude session to review the draft PR. By morning, PRs have already been through one round of self-review. This is the strongest differentiation from TaskSmith's black-box approach.

## Server-Backed Dashboard (`nightcrew serve`)
**Priority:** P2 | **Effort:** M (human: ~1 day / CC: ~30min)
**Depends on:** Static dashboard (dashboard.html) proving useful

Local HTTP server with API endpoints for reading status and adding/editing tasks. Upgrades the static dashboard to a full task management UI. Adds a Node/Python dependency.
