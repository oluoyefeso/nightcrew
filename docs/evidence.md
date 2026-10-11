# Evidence

Routes in **Settings → Repos** can add verification requirements by task type. The task preview lists the effective requirements; the run's **Route** tab records what was enforced. Requirements can be added to any code task type, while UI visual evidence and bug-fix regression proof remain mandatory for automatic landing. If the Skeptic changes files after visual or regression evidence was collected, the run waits for review with a request for fresh evidence.

The agent that wrote the code never grades it. NightCrew gathers evidence itself, then a separate reviewer, the Skeptic, tries to show the work isn't done.

## What gets gathered

| Task type | Evidence |
|---|---|
| UI | Screenshots of each preview page at desktop (1440×900) and mobile (390×844), in light and dark, from the base branch and from the task branch. Plus a pixel diff per view, an axe accessibility scan (only issues new versus the base branch count) and console errors on the new pages. |
| Bug fix | Fail-then-pass: NightCrew copies the task's new or changed test files onto a clean checkout of the base branch and runs your test command. They must **fail** there and pass on the task branch. A test that passes either way proves nothing and gets flagged. |
| Everything | NightCrew's own checks on changed files against scope, protected paths and your test command, with one repair attempt if they fail. |

Screenshots are taken in a real headless Chrome, using your installed Chrome or a Playwright Chromium. Animations are frozen so diffs are stable.

## The Skeptic

The reviewer gets the diff, the acceptance criteria and a summary of the evidence. It has to:

- check each criterion against concrete evidence (a test name, a command and its output, a file and line),
- make at least five challenges (edge cases, regressions, tests that might pass for the wrong reason, scope) and record which held,
- give a verdict: ready, needs your eyes, or not done.

**Missing evidence always means Needs your eyes**, whatever the verdict.

## Where to see it

In the Station, open a task and choose **Evidence**: a checklist, the screenshot gallery (before, after and changes), and the fail-then-pass output. The same summary goes into the PR description, along with the Skeptic's results.

Files live in `~/.nightcrew/runs/<run>/`. Nothing is committed to your repo.
