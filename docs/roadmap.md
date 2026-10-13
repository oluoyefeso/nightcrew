# Open-source conductor roadmap

NightCrew is the local station for dispatching agents, verifying their work and deciding how far they may proceed. Managed mode remains **Coming soon**. This roadmap tracks the conductor experience; the root `TODOS.md` contains older classic-runner work.

## Available

- Station decisions across days, task routes and repository authority ceilings.
- Missions, prerequisites, dispatch priorities, token limits, start deadlines and saved execution stop times.
- Saved-work recovery, bounded retries, independent reviews and evidence requirements.
- Human-attested mission acceptance with combined repository checks.
- Opt-in check → deploy → release commands on pinned local commits.
- Persistent operation progress, individual stops and interruption records.
- Agent phase measurements for requested models, tokens, cost, elapsed time, turns and limits, with partial and unknown usage visible.

## Completed batches

- **Repository readiness:** rehearse installation and verification before dispatching agents; retain results tied to the tested commit and configuration.
- **Workflow library:** edit and manage reusable verification templates, with portable import/export and previews before applying them.
- **Mission planning:** set complete controls at creation, start paused, link tasks to acceptance criteria, inspect missing coverage, and repair outdated links.
- **Delivery readiness:** explain manual and automatic eligibility against the current commit, settings and saved attempts, with direct access to exact historical results.
- **Operational decisions:** surface failed and interrupted operations in Station, retain an attention list with filters and pagination, record review acknowledgements, and filter queued departures by repository and hold reason.

## Batch status

The conductor batches listed above are implemented in the local edition. Further expansion should follow observed use and concrete feedback; Managed mode remains Coming soon. Provider-specific deployment health, external rollback and autonomous semantic acceptance are outside these completed batches.

Releases are checkpoints within this work. Each batch includes appropriate tests, compatibility checks and a landing-page review. Examples use synthetic data; local configuration, private repository details and credentials stay outside the public project.
