# Open-source conductor roadmap

NightCrew is the local station for dispatching agents, verifying their work and deciding how far they may proceed. Managed mode remains **Coming soon**. This roadmap tracks the conductor experience; the root `TODOS.md` contains older classic-runner work.

## Available

- Station decisions across days, task routes and repository authority ceilings.
- Missions, prerequisites, dispatch priorities, token limits and start deadlines.
- Saved-work recovery, bounded retries, independent reviews and evidence requirements.
- Human-attested mission acceptance with combined repository checks.
- Opt-in check → deploy → release commands on pinned local commits.
- Persistent operation progress, individual stops and interruption records.

## Completed in this batch

- **Repository readiness:** rehearse installation and verification before dispatching agents; retain results tied to the tested commit and configuration.
- **Workflow library:** edit and manage reusable verification templates, with portable import/export and previews before applying them.

## Next

- **Mission planning:** set complete mission controls at creation, inspect the proposed work against acceptance criteria, and keep handoffs clear before dispatch.
- **Delivery readiness:** explain stage eligibility against the current commit and policy, with direct access to historical results.
- **Operational decisions:** make holds and failed outcomes easier to find and act on across repositories.

Releases are checkpoints within this work. Each batch includes appropriate tests, compatibility checks and a landing-page review. Examples use synthetic data; local configuration, private repository details and credentials stay outside the public project.
