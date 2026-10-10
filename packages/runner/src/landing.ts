// How finished work lands, by trust level: the daily train (an integration
// branch you merge with one PR) and ship-to-dev (the crew merges itself,
// with Undo).

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Repo, Train } from "@nightcrew/core";
import { matchesAny } from "@nightcrew/core/guard";
import { git, openOrUpdatePr, push, run, withRepoLock } from "./git";
import { runCheck } from "./sandbox";

/** Fetches and pushes on integration branches give up after this long. */
const NETWORK_MS = 120_000;

/** Where a merge or revert in progress records the sha to go back to. */
const LANDING_MARKER = "nightcrew-landing";
/** The sha NightCrew last left the ship branch at, pushed or not. */
const SHIP_MARKER = "nightcrew-ship-head";

const head = async (dir: string) => (await git(dir, "rev-parse", "HEAD")).stdout.trim();
const gitDir = async (dir: string) => (await git(dir, "rev-parse", "--absolute-git-dir")).stdout.trim();

async function readMarker(dir: string, name: string): Promise<string | null> {
  try {
    const sha =
      readFileSync(join(await gitDir(dir), name), "utf8")
        .trim()
        .split(/\s+/)[0] ?? "";
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** Note the sha to reset to before a merge or revert, so an interrupted one is undone on the next use. */
async function startLanding(dir: string, op: string): Promise<string> {
  const before = await head(dir);
  writeFileSync(join(await gitDir(dir), LANDING_MARKER), `${before} ${op}\n`);
  return before;
}

/** The merge or revert is pushed or rolled back. On the ship branch, remember where it was left. */
async function endLanding(dir: string, ship: boolean) {
  const gd = await gitDir(dir);
  if (ship) writeFileSync(join(gd, SHIP_MARKER), `${await head(dir)}\n`);
  rmSync(join(gd, LANDING_MARKER), { force: true });
}

/**
 * A long-lived worktree for an integration branch (train or ship branch),
 * clean, with any interrupted landing undone and, when publishing, level with
 * origin, so nothing merges onto a stale or tampered base. `start` is HEAD
 * before catching up with origin, for spotting dependency changes.
 */
async function branchWorktree(
  repo: Repo,
  branch: string,
  o: { publish: boolean; ship: boolean; createFrom?: string },
): Promise<{ dir: string; start: string }> {
  const dir = join(repo.path, ".worktrees", `_${branch.replace(/[^\w.-]+/g, "-")}`);
  const origin = o.publish && (await git(repo.path, "remote", "get-url", "origin")).ok;
  // A failed or slow fetch carries on with the local ref; the push catches a stale base.
  if (origin) await run(["git", "fetch", "--quiet", "origin", branch], repo.path, { timeoutMs: NETWORK_MS });
  const remote =
    origin && (await git(repo.path, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`)).ok;
  if (existsSync(join(dir, ".git"))) {
    // Clear whatever an interrupted merge or revert left behind.
    await git(dir, "merge", "--abort");
    await git(dir, "revert", "--abort");
    await git(dir, "reset", "--hard", "HEAD");
    const interrupted = await readMarker(dir, LANDING_MARKER);
    if (interrupted) {
      const r = await git(dir, "reset", "--hard", interrupted);
      if (!r.ok) throw new Error(`Couldn't undo an interrupted landing on ${branch}: ${r.stderr.trim()}`);
      await endLanding(dir, false);
    }
  } else {
    await git(repo.path, "worktree", "prune");
    const local = (await git(repo.path, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)).ok;
    if (!local) {
      const from = remote ? `origin/${branch}` : (o.createFrom ?? repo.defaultBranch);
      const b = await git(repo.path, "branch", branch, from);
      if (!b.ok) throw new Error(`Couldn't create ${branch}: ${b.stderr.trim()}`);
    }
    const add = await git(repo.path, "worktree", "add", dir, branch);
    if (!add.ok) throw new Error(`Couldn't check out ${branch}: ${add.stderr.trim()}`);
  }
  const start = await head(dir);
  if (remote) {
    const ahead = Number((await git(dir, "rev-list", "--count", `origin/${branch}..HEAD`)).stdout.trim()) || 0;
    const commits = `${ahead} local ${ahead === 1 ? "commit" : "commits"} that ${ahead === 1 ? "isn't" : "aren't"} on origin`;
    // Every published ship is pushed at once, so local-only commits on the ship
    // branch are NightCrew's own unpublished ships or something else moved it.
    if (o.ship && ahead && start !== (await readMarker(dir, SHIP_MARKER)))
      throw new Error(
        `${branch} has ${commits} that NightCrew didn't make. Reset ${branch} to origin/${branch}, or push them, first.`,
      );
    if (o.ship && !ahead) await git(dir, "reset", "--hard", `origin/${branch}`);
    else {
      const ff = await git(dir, "merge", "--ff-only", "--quiet", `origin/${branch}`);
      if (!ff.ok)
        throw new Error(
          ahead
            ? `${branch} has ${commits}, and origin has moved on. Push or reset ${branch} first.`
            : `Couldn't bring ${branch} up to date with origin: ${ff.stderr.trim()}`,
        );
    }
  }
  return { dir, start };
}

const identity = ["-c", "user.name=NightCrew", "-c", "user.email=crew@nightcrew.dev"];

/** Merge a task branch. `before` is where to reset to if the merge has to come back off. */
async function mergeInto(
  dir: string,
  branch: string,
  into: string,
  message: string,
): Promise<{ ok: true; sha: string; before: string } | { ok: false; error: string }> {
  // Already merged (or shipped and undone): merging again would change nothing.
  // The only place that says so; --no-ff never makes a no-op merge after this.
  if ((await git(dir, "merge-base", "--is-ancestor", branch, "HEAD")).ok)
    return { ok: false, error: `Already on ${into}; nothing new to merge.` };
  const before = await startLanding(dir, `merge ${branch}`);
  const m = await git(dir, ...identity, "merge", "--no-ff", "--no-edit", "-m", message, branch);
  if (!m.ok) {
    await git(dir, "merge", "--abort");
    await git(dir, "reset", "--hard", before);
    return {
      ok: false,
      error: /conflict/i.test(m.stdout + m.stderr)
        ? "It conflicts with work already merged today."
        : m.stderr.trim() || "git merge failed.",
    };
  }
  return { ok: true, sha: await head(dir), before };
}

/** Revert a merge commit. `before` is where to reset to if the revert has to come back off. */
async function revertMerge(
  dir: string,
  sha: string,
): Promise<{ ok: true; before: string } | { ok: false; error: string }> {
  const before = await startLanding(dir, `revert ${sha}`);
  const r = await git(dir, ...identity, "revert", "--no-edit", "-m", "1", sha);
  if (r.ok) return { ok: true, before };
  await git(dir, "revert", "--abort");
  await git(dir, "reset", "--hard", before);
  return { ok: false, error: r.stderr.trim() };
}

/** Files whose change means the dependencies need installing again. */
const MANIFEST =
  /(^|\/)(package\.json|bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum|requirements[^/]*\.txt|pyproject\.toml)$/;

/** `since` is HEAD before catching up with origin, so dependencies the catch-up brought in count too. */
async function testsPass(repo: Repo, dir: string, since: string): Promise<{ ok: boolean; log: string }> {
  if (repo.setupCommand) {
    const changed = (await git(dir, "diff", "--name-only", since, "HEAD")).stdout.split("\n").filter(Boolean);
    if (!existsSync(join(dir, "node_modules")) || changed.some((f) => MANIFEST.test(f)))
      await runCheck(repo.setupCommand, dir, { timeoutMs: 10 * 60_000 });
  }
  if (!repo.testCommand) return { ok: true, log: "No test command." };
  const t = await runCheck(repo.testCommand, dir, { timeoutMs: 15 * 60_000 });
  return { ok: t.ok, log: `$ ${repo.testCommand} (exit ${t.code})\n${`${t.stdout}\n${t.stderr}`.trim().slice(-3000)}` };
}

// ── Ship to dev ─────────────────────────────────────────────────────────────

export interface ShipCheck {
  ok: boolean;
  reasons: string[];
}

/** Can this task ship without a person? Every reason it can't, in words. */
export function canShip(input: {
  repo: Repo;
  files: string[];
  verdict: string | null;
  evidenceMissing: string[];
  confidence: number | null;
}): ShipCheck {
  const { repo } = input;
  const reasons: string[] = [];
  if (repo.level !== "ship") reasons.push("The repo isn't at the Ship to dev level.");
  if (!repo.shipBranch) reasons.push("No ship branch is set.");
  else if (repo.protectedBranches.includes(repo.shipBranch))
    reasons.push(`${repo.shipBranch} is protected; the crew never merges there.`);
  if (input.verdict !== "ready") reasons.push("The Skeptic wants a person to look.");
  if (input.evidenceMissing.length) reasons.push("Some required evidence is missing.");
  if (input.confidence !== null && input.confidence < 0.8)
    reasons.push(`Confidence is ${Math.round(input.confidence * 100)}%, under the 80% bar.`);
  const asks = input.files.filter((f) => matchesAny(f, repo.alwaysAsk));
  if (asks.length) reasons.push(`It touches files that always wait for you: ${asks.slice(0, 4).join(", ")}.`);
  if (!repo.allowShip.length) reasons.push("No paths are allowed to ship on their own yet.");
  else {
    const outside = input.files.filter((f) => !matchesAny(f, repo.allowShip));
    if (outside.length) reasons.push(`It changes files outside the ship list: ${outside.slice(0, 4).join(", ")}.`);
  }
  return { ok: reasons.length === 0, reasons };
}

/** Push an integration branch, if publishing and there's an origin. */
async function publishBranch(dir: string, branch: string, publish: boolean) {
  if (!publish || !(await git(dir, "remote", "get-url", "origin")).ok) return null;
  const p = await push(dir, branch, NETWORK_MS);
  return p.ok ? null : (p.stderr.trim().split("\n").pop() ?? "push failed");
}

/** Merge the task branch into the ship branch, test, push. */
async function shipTaskUnlocked(
  repo: Repo,
  branch: string,
  title: string,
  publish: boolean,
): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
  if (!repo.shipBranch) return { ok: false, error: "No ship branch." };
  const { dir, start } = await branchWorktree(repo, repo.shipBranch, { publish, ship: true });
  try {
    const merged = await mergeInto(dir, branch, repo.shipBranch, `Ship: ${title} (NightCrew)`);
    if (!merged.ok) return merged;
    const tests = await testsPass(repo, dir, start);
    if (!tests.ok) {
      await git(dir, "reset", "--hard", merged.before);
      return {
        ok: false,
        error: `Tests failed on ${repo.shipBranch} after merging, so it wasn't shipped.\n${tests.log}`,
      };
    }
    const failed = await publishBranch(dir, repo.shipBranch, publish);
    if (failed) {
      await git(dir, "reset", "--hard", merged.before);
      return { ok: false, error: `Couldn't push ${repo.shipBranch}: ${failed}` };
    }
    return { ok: true, sha: merged.sha };
  } finally {
    await endLanding(dir, true);
  }
}

/** Undo a ship: revert its merge commit on the ship branch and push. */
async function undoShipUnlocked(
  repo: Repo,
  shipBranch: string,
  sha: string,
  publish: boolean,
): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
  // branchWorktree brings the branch level with origin, or fails with why.
  const { dir } = await branchWorktree(repo, shipBranch, { publish, ship: true });
  try {
    const r = await revertMerge(dir, sha);
    if (!r.ok)
      return { ok: false, error: `Couldn't revert ${sha.slice(0, 7)}: ${r.error || "conflicts with later changes"}` };
    const failed = await publishBranch(dir, shipBranch, publish);
    if (failed) {
      // Leave no stray revert behind for the next ship to push.
      await git(dir, "reset", "--hard", r.before);
      return { ok: false, error: `Couldn't push ${shipBranch}, so nothing was undone: ${failed}` };
    }
    return { ok: true, sha: await head(dir) };
  } finally {
    await endLanding(dir, true);
  }
}

// ── The daily train ─────────────────────────────────────────────────────────

export function trainBranch(dayId: string) {
  return `crew/train-${dayId}`;
}

/** Add a finished task to today's train. If the train's tests break, it comes straight back off. */
async function boardTrainUnlocked(
  repo: Repo,
  train: Train,
  taskBranch: string,
  title: string,
  publish: boolean,
): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
  const { dir, start } = await branchWorktree(repo, train.branch, {
    publish,
    ship: false,
    createFrom: repo.defaultBranch,
  });
  try {
    const merged = await mergeInto(dir, taskBranch, train.branch, `${title} (NightCrew)`);
    if (!merged.ok) return merged;
    const tests = await testsPass(repo, dir, start);
    if (!tests.ok) {
      await git(dir, "reset", "--hard", merged.before);
      return { ok: false, error: `It broke the train's tests together with today's other work.\n${tests.log}` };
    }
    return { ok: true, sha: merged.sha };
  } finally {
    await endLanding(dir, false);
  }
}

/** Push the train and open (or refresh) its one PR. */
async function publishTrainUnlocked(repo: Repo, train: Train): Promise<{ prUrl: string; prNumber: number } | null> {
  const on = train.cars.filter((c) => c.state === "on");
  if (!on.length) return null;
  const { dir } = await branchWorktree(repo, train.branch, {
    publish: true,
    ship: false,
    createFrom: repo.defaultBranch,
  });
  if (!(await git(dir, "remote", "get-url", "origin")).ok) return null;
  const failed = await publishBranch(dir, train.branch, true);
  if (failed) throw new Error(`Couldn't push the train: ${failed}`);
  const pulled = train.cars.filter((c) => c.state !== "on");
  const body = `Today's train for ${repo.name}: ${on.length} ${on.length === 1 ? "task" : "tasks"}, tested together.

${on.map((c) => `- [x] ${c.title}`).join("\n")}
${pulled.length ? `\nTaken off the train:\n${pulled.map((c) => `- ${c.title} (${c.state === "broke" ? "broke the tests" : "pulled by you"})`).join("\n")}\n` : ""}
Review each task's plan, evidence and Skeptic report in the NightCrew Morning Report.

---
Made by [NightCrew](https://github.com/oluoyefeso/nightcrew)`;
  const pr = await openOrUpdatePr(dir, {
    branch: train.branch,
    base: repo.defaultBranch,
    title: `Daily train ${train.nightId}: ${on.length} ${on.length === 1 ? "task" : "tasks"}`,
    body,
  });
  return { prUrl: pr.url, prNumber: pr.number };
}

/** Take one task off the train: revert its merge commit. */
async function pullCarUnlocked(
  repo: Repo,
  train: Train,
  mergeSha: string,
  publish: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { dir } = await branchWorktree(repo, train.branch, {
    publish,
    ship: false,
    createFrom: repo.defaultBranch,
  });
  try {
    const r = await revertMerge(dir, mergeSha);
    if (!r.ok) return { ok: false, error: "That task can't come off cleanly; later tasks build on it." };
    const failed = await publishBranch(dir, train.branch, publish);
    if (failed) {
      await git(dir, "reset", "--hard", r.before);
      return { ok: false, error: `Couldn't push the train, so the task stays on: ${failed}` };
    }
    return { ok: true };
  } finally {
    await endLanding(dir, false);
  }
}

// Integration-branch work holds the repo's lock so parallel agents in one
// repo never merge into the same branch at the same moment. A thrown git
// error comes back as a failed result, so callers can fall back.
const settled = async <T>(p: Promise<T>): Promise<T | { ok: false; error: string }> => {
  try {
    return await p;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
};

export const shipTask = (repo: Repo, ...a: Tail<Parameters<typeof shipTaskUnlocked>>) =>
  settled(withRepoLock(repo.path, () => shipTaskUnlocked(repo, ...a)));
export const undoShip = (repo: Repo, ...a: Tail<Parameters<typeof undoShipUnlocked>>) =>
  settled(withRepoLock(repo.path, () => undoShipUnlocked(repo, ...a)));
export const boardTrain = (repo: Repo, ...a: Tail<Parameters<typeof boardTrainUnlocked>>) =>
  settled(withRepoLock(repo.path, () => boardTrainUnlocked(repo, ...a)));
export const publishTrain = (repo: Repo, ...a: Tail<Parameters<typeof publishTrainUnlocked>>) =>
  withRepoLock(repo.path, () => publishTrainUnlocked(repo, ...a));
export const pullCar = (repo: Repo, ...a: Tail<Parameters<typeof pullCarUnlocked>>) =>
  settled(withRepoLock(repo.path, () => pullCarUnlocked(repo, ...a)));

type Tail<T extends unknown[]> = T extends [unknown, ...infer R] ? R : never;
