// How finished work lands, by trust level: the nightly train (an integration
// branch you merge in the morning) and ship-to-dev (the crew merges itself,
// with Undo).

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Repo, Train } from "@nightcrew/core";
import { matchesAny } from "@nightcrew/core/guard";
import { git, openOrUpdatePr, push, run, withRepoLock } from "./git";

/** A long-lived worktree for an integration branch (train or ship branch). */
async function branchWorktree(repo: Repo, branch: string, createFrom?: string): Promise<string> {
  const dir = join(repo.path, ".worktrees", `_${branch.replace(/[^\w.-]+/g, "-")}`);
  if (existsSync(join(dir, ".git"))) {
    await git(dir, "fetch", "--quiet", "origin", branch).catch(() => {});
    return dir;
  }
  await git(repo.path, "worktree", "prune");
  const local = (await git(repo.path, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)).ok;
  if (!local) {
    const remote = (await git(repo.path, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`)).ok;
    const from = remote ? `origin/${branch}` : (createFrom ?? repo.defaultBranch);
    const b = await git(repo.path, "branch", branch, from);
    if (!b.ok) throw new Error(`Couldn't create ${branch}: ${b.stderr.trim()}`);
  }
  const add = await git(repo.path, "worktree", "add", dir, branch);
  if (!add.ok) throw new Error(`Couldn't check out ${branch}: ${add.stderr.trim()}`);
  return dir;
}

const identity = ["-c", "user.name=NightCrew", "-c", "user.email=crew@nightcrew.dev"];

async function mergeInto(
  dir: string,
  branch: string,
  message: string,
): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
  const m = await git(dir, ...identity, "merge", "--no-ff", "--no-edit", "-m", message, branch);
  if (!m.ok) {
    await git(dir, "merge", "--abort");
    return {
      ok: false,
      error: /conflict/i.test(m.stdout + m.stderr)
        ? "It conflicts with work already merged tonight."
        : m.stderr.trim() || "git merge failed.",
    };
  }
  return { ok: true, sha: (await git(dir, "rev-parse", "HEAD")).stdout.trim() };
}

async function testsPass(repo: Repo, dir: string): Promise<{ ok: boolean; log: string }> {
  if (repo.setupCommand && !existsSync(join(dir, "node_modules")))
    await run(["sh", "-c", repo.setupCommand], dir, { timeoutMs: 10 * 60_000 });
  if (!repo.testCommand) return { ok: true, log: "No test command." };
  const t = await run(["sh", "-c", repo.testCommand], dir, { timeoutMs: 15 * 60_000 });
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

/** Merge the task branch into the ship branch, test, push. */
async function shipTaskUnlocked(
  repo: Repo,
  branch: string,
  title: string,
  publish: boolean,
): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
  if (!repo.shipBranch) return { ok: false, error: "No ship branch." };
  const dir = await branchWorktree(repo, repo.shipBranch);
  const merged = await mergeInto(dir, branch, `Ship: ${title} (NightCrew)`);
  if (!merged.ok) return merged;
  const tests = await testsPass(repo, dir);
  if (!tests.ok) {
    await git(dir, "reset", "--hard", "HEAD~1");
    return {
      ok: false,
      error: `Tests failed on ${repo.shipBranch} after merging, so it wasn't shipped.\n${tests.log}`,
    };
  }
  if (publish && (await git(dir, "remote", "get-url", "origin")).ok) {
    const p = await push(dir, repo.shipBranch);
    if (!p.ok) {
      await git(dir, "reset", "--hard", "HEAD~1");
      return { ok: false, error: `Couldn't push ${repo.shipBranch}: ${p.stderr.trim().split("\n").pop()}` };
    }
  }
  return merged;
}

/** Undo a ship: revert its merge commit on the ship branch and push. */
async function undoShipUnlocked(
  repo: Repo,
  shipBranch: string,
  sha: string,
  publish: boolean,
): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
  const dir = await branchWorktree(repo, shipBranch);
  if (publish) await git(dir, "pull", "--ff-only", "--quiet", "origin", shipBranch).catch(() => {});
  const r = await git(dir, ...identity, "revert", "--no-edit", "-m", "1", sha);
  if (!r.ok) {
    await git(dir, "revert", "--abort");
    return {
      ok: false,
      error: `Couldn't revert ${sha.slice(0, 7)}: ${r.stderr.trim() || "conflicts with later changes"}`,
    };
  }
  if (publish && (await git(dir, "remote", "get-url", "origin")).ok) {
    const p = await push(dir, shipBranch);
    if (!p.ok) return { ok: false, error: `Reverted locally but couldn't push: ${p.stderr.trim().split("\n").pop()}` };
  }
  return { ok: true, sha: (await git(dir, "rev-parse", "HEAD")).stdout.trim() };
}

// ── The nightly train ───────────────────────────────────────────────────────

export function trainBranch(dayId: string) {
  return `crew/train-${dayId}`;
}

/** Add a finished task to tonight's train. If the train's tests break, it comes straight back off. */
async function boardTrainUnlocked(
  repo: Repo,
  train: Train,
  taskBranch: string,
  title: string,
): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
  const dir = await branchWorktree(repo, train.branch, repo.defaultBranch);
  const merged = await mergeInto(dir, taskBranch, `${title} (NightCrew)`);
  if (!merged.ok) return merged;
  const tests = await testsPass(repo, dir);
  if (!tests.ok) {
    await git(dir, "reset", "--hard", "HEAD~1");
    return { ok: false, error: `It broke the train's tests together with tonight's other work.\n${tests.log}` };
  }
  return merged;
}

/** Push the train and open (or refresh) its one PR. */
async function publishTrainUnlocked(repo: Repo, train: Train): Promise<{ prUrl: string; prNumber: number } | null> {
  const on = train.cars.filter((c) => c.state === "on");
  if (!on.length) return null;
  const dir = await branchWorktree(repo, train.branch, repo.defaultBranch);
  if (!(await git(dir, "remote", "get-url", "origin")).ok) return null;
  const p = await push(dir, train.branch);
  if (!p.ok) throw new Error(`Couldn't push the train: ${p.stderr.trim().split("\n").pop()}`);
  const pulled = train.cars.filter((c) => c.state !== "on");
  const body = `Tonight's train for ${repo.name}: ${on.length} ${on.length === 1 ? "task" : "tasks"}, tested together.

${on.map((c) => `- [x] ${c.title}`).join("\n")}
${pulled.length ? `\nTaken off the train:\n${pulled.map((c) => `- ${c.title} (${c.state === "broke" ? "broke the tests" : "pulled by you"})`).join("\n")}\n` : ""}
Review each task's plan, evidence and Skeptic report in the NightCrew Morning Report.

---
Made overnight by [NightCrew](https://github.com/oluoyefeso/nightcrew)`;
  const pr = await openOrUpdatePr(dir, {
    branch: train.branch,
    base: repo.defaultBranch,
    title: `Nightly train ${train.nightId}: ${on.length} ${on.length === 1 ? "task" : "tasks"}`,
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
  const dir = await branchWorktree(repo, train.branch, repo.defaultBranch);
  const r = await git(dir, ...identity, "revert", "--no-edit", "-m", "1", mergeSha);
  if (!r.ok) {
    await git(dir, "revert", "--abort");
    return { ok: false, error: "That task can't come off cleanly; later tasks build on it." };
  }
  if (publish && (await git(dir, "remote", "get-url", "origin")).ok) await push(dir, train.branch);
  return { ok: true };
}

// Integration-branch work holds the repo's lock so parallel agents in one
// repo never merge into the same branch at the same moment.
export const shipTask = (repo: Repo, ...a: Tail<Parameters<typeof shipTaskUnlocked>>) =>
  withRepoLock(repo.path, () => shipTaskUnlocked(repo, ...a));
export const undoShip = (repo: Repo, ...a: Tail<Parameters<typeof undoShipUnlocked>>) =>
  withRepoLock(repo.path, () => undoShipUnlocked(repo, ...a));
export const boardTrain = (repo: Repo, ...a: Tail<Parameters<typeof boardTrainUnlocked>>) =>
  withRepoLock(repo.path, () => boardTrainUnlocked(repo, ...a));
export const publishTrain = (repo: Repo, ...a: Tail<Parameters<typeof publishTrainUnlocked>>) =>
  withRepoLock(repo.path, () => publishTrainUnlocked(repo, ...a));
export const pullCar = (repo: Repo, ...a: Tail<Parameters<typeof pullCarUnlocked>>) =>
  withRepoLock(repo.path, () => pullCarUnlocked(repo, ...a));

type Tail<T extends unknown[]> = T extends [unknown, ...infer R] ? R : never;
