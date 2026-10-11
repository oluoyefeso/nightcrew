# The trust ladder

Draft PRs are the safe default. Each repo can move up as its record earns it, and a revert moves it back down.

## Levels

**Propose.** The crew plans and stops. Useful for unfamiliar repos or big changes you want to steer.

**Draft PR.** One draft PR per task. You merge. This is the default.

**Daily train.** Every task that finishes ready, with complete evidence, merges into `crew/train-<day>`, a branch made from your default branch that day, and the full test suite runs on the combined result.
- A task that conflicts with the day's other work, or breaks the combined tests, comes straight back off and gets its own draft PR.
- Whenever no agent is working in the repo, NightCrew pushes the train and opens (or refreshes) **one** PR listing every task on it.
- At any point, press `3` on any task to take it off the train (its merge is reverted) without blocking the rest.

**Ship to dev.** The crew merges into your ship branch (like `dev` or `staging`, never a protected branch) by itself when all of these hold:
- the Skeptic's verdict is ready,
- the required evidence is complete,
- confidence is at least 80%,
- every changed file matches **Allowed to ship on their own**,
- no changed file matches **Always wait for me**.

Otherwise the task falls back to a draft PR, and the run log says exactly which rule stopped it. Press `U` on a shipped task to revert its merge on the ship branch. An undo also drops the repo back to the daily train.

**Never.** The default branch, `main`, `master`, release branches you protect, workflows and secrets. The guard refuses them during the night, and NightCrew never merges there.

## Earning it

NightCrew keeps a record per repo over the last ten finished tasks: how many merged unchanged, were sent back, or were undone. It suggests a promotion in the Inbox:

- **Draft PR → Daily train** after 5 merged unchanged, with nothing sent back or undone.
- **Daily train → Ship to dev** after 8 merged unchanged, with nothing sent back or undone. You need a ship branch and an allow list first.

You can also change the level in **Settings → Repos** at any time.

## Confidence

Confidence is a 0–100% score for "a careful reviewer would merge this unchanged".
- With `TYPESAFE_API_KEY` set, Jev scores it from the review and evidence in about 100ms.
- Without it, NightCrew starts from the Skeptic's verdict, the challenges that held, the concerns raised and any missing evidence.
