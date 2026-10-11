// How finished work lands, by trust level: the daily train (an integration
// branch you merge with one PR) and ship-to-dev (the crew merges itself,
// with Undo).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Repo, Train } from "@nightcrew/core";
import { matchesAny } from "@nightcrew/core/guard";
import { git, gitRun, lastLine, openOrUpdatePr, pushTo, withRepoLock } from "./git";
import { runCheck } from "./sandbox";

/** Fetches and pushes on integration branches give up after this long. */
const NETWORK_MS = 120_000;

const SHA = /^[0-9a-f]{40,64}$/;

let home: string | null = null;

/**
 * Where landing records live: NightCrew's data folder, never a git dir a
 * repo command could write. Set by the pipeline; the CLI's default otherwise.
 */
export function setLandingHome(dataDir: string) {
  home = dataDir;
}

/**
 * A landing record for one integration branch. "landing" holds the sha to go
 * back to while a merge or revert is in progress, so an interrupted one is
 * undone on the next use. "ship-head" is the sha NightCrew last left the ship
 * branch at, pushed or not.
 */
export function landingFile(repo: Repo, branch: string, kind: "landing" | "ship-head"): string {
  const root = home ?? process.env.NIGHTCREW_HOME ?? join(homedir(), ".nightcrew");
  return join(root, "landing", repo.id.replace(/[^\w.-]+/g, "-"), `${branch.replace(/[^\w.-]+/g, "-")}.${kind}`);
}

const head = async (dir: string) => (await git(dir, "rev-parse", "HEAD")).stdout.trim();

function readMarker(file: string): string | null {
  try {
    const sha = readFileSync(file, "utf8").trim().split(/\s+/)[0] ?? "";
    return SHA.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

function writeMarker(file: string, text: string) {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
}

interface Lane {
  repo: Repo;
  branch: string;
  dir: string;
}

/** Note the sha to reset to before a merge or revert, so an interrupted one is undone on the next use. */
async function startLanding(lane: Lane, op: string): Promise<string> {
  const before = await head(lane.dir);
  writeMarker(landingFile(lane.repo, lane.branch, "landing"), `${before} ${op}\n`);
  return before;
}

/** The merge or revert is pushed or rolled back. On the ship branch, remember where it was left. */
async function endLanding(lane: Lane, ship: boolean) {
  if (ship) writeMarker(landingFile(lane.repo, lane.branch, "ship-head"), `${await head(lane.dir)}\n`);
  rmSync(landingFile(lane.repo, lane.branch, "landing"), { force: true });
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
): Promise<Lane & { start: string }> {
  const dir = join(repo.path, ".worktrees", `_${branch.replace(/[^\w.-]+/g, "-")}`);
  const lane = { repo, branch, dir };
  const tracking = `refs/remotes/origin/${branch}`;
  const origin = o.publish && (await git(repo.path, "remote", "get-url", "origin")).ok;
  // A failed or slow fetch carries on with the local ref; the push catches a stale base.
  if (origin)
    await gitRun(
      repo.path,
      ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "origin", `+refs/heads/${branch}:${tracking}`],
      { timeoutMs: NETWORK_MS },
    );
  const remote = origin && (await git(repo.path, "rev-parse", "--verify", "--quiet", `${tracking}^{commit}`)).ok;
  if (existsSync(join(dir, ".git"))) {
    // Clear whatever an interrupted merge or revert left behind.
    await git(dir, "merge", "--abort");
    await git(dir, "revert", "--abort");
    await git(dir, "reset", "--hard", "HEAD");
    const interrupted = readMarker(landingFile(repo, branch, "landing"));
    if (interrupted) {
      const r = await git(dir, "reset", "--hard", interrupted);
      if (!r.ok) throw new Error(`Couldn't undo an interrupted landing on ${branch}: ${r.stderr.trim()}`);
      await endLanding(lane, false);
    }
    // What one landing's tests left behind (build output, caches, stray files)
    // must not reach the next one. Installed dependencies stay.
    const clean = await git(dir, "clean", "-ffdxq", ...KEEP.flatMap((k) => ["-e", k]));
    if (!clean.ok) throw new Error(`Couldn't clean the ${branch} checkout: ${lastLine(clean.stderr)}`);
  } else {
    await git(repo.path, "worktree", "prune");
    const local = (await git(repo.path, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)).ok;
    if (!local) {
      const from = remote ? tracking : `refs/heads/${o.createFrom ?? repo.defaultBranch}`;
      const b = await git(repo.path, "branch", "--no-track", branch, from);
      if (!b.ok) throw new Error(`Couldn't create ${branch}: ${b.stderr.trim()}`);
    }
    const add = await git(repo.path, "worktree", "add", dir, branch);
    if (!add.ok) throw new Error(`Couldn't check out ${branch}: ${add.stderr.trim()}`);
  }
  const start = await head(dir);
  if (remote) {
    const ahead = Number((await git(dir, "rev-list", "--count", `${tracking}..HEAD`)).stdout.trim()) || 0;
    const commits = `${ahead} local ${ahead === 1 ? "commit" : "commits"} that ${ahead === 1 ? "isn't" : "aren't"} on origin`;
    // Every published ship is pushed at once, so local-only commits on the ship
    // branch are NightCrew's own unpublished ships or something else moved it.
    if (o.ship && ahead && start !== readMarker(landingFile(repo, branch, "ship-head")))
      throw new Error(
        `${branch} has ${commits} that NightCrew didn't make. Reset ${branch} to origin/${branch}, or push them, first.`,
      );
    if (o.ship && !ahead) await git(dir, "reset", "--hard", tracking);
    else {
      const ff = await git(dir, "merge", "--ff-only", "--quiet", tracking);
      if (!ff.ok)
        throw new Error(
          ahead
            ? `${branch} has ${commits}, and origin has moved on. Push or reset ${branch} first.`
            : `Couldn't bring ${branch} up to date with origin: ${ff.stderr.trim()}`,
        );
    }
  }
  return { ...lane, start };
}

/** Dependency folders the integration checkouts keep between landings. */
const KEEP = ["node_modules", ".venv", "venv", "vendor"];

const identity = ["-c", "user.name=NightCrew", "-c", "user.email=crew@nightcrew.dev"];

/** What the final gate approved: the diff from `base` to the task's sha touches exactly `files`. */
export interface Approved {
  /**
   * Where the task's work forks from the default branch: a default-branch
   * commit, worked out in your repo from the task's sha.
   */
  base: string;
  /** The files the gate checked: the task's whole change against `base`. */
  files: string[];
  /** Checks to run again before the merge stays; a reason to refuse, or null. */
  recheck?: (files: string[]) => string | null;
  /** This task's earlier landings, from NightCrew's records. Read inside the repo lock, so a Pull or Undo that just finished counts. */
  earlier?: () => Earlier | Promise<Earlier>;
}

/** A task's earlier tip that NightCrew landed and then took off again. */
export interface TakenOff {
  /** The task's tip that landed. */
  tip: string;
  /** The merge commit that landed it, which the Pull or Undo reverted. */
  merge: string;
  /** Where it landed. */
  branch: string;
}

export interface Earlier {
  /**
   * This task's earlier tips that NightCrew landed on this branch and that are
   * still there by its records (cars on the train, ships not undone). A merge
   * may build on one of them and land only what's new since.
   */
  landed: string[];
  /** This task's earlier tips, on any of the repo's trains or ship branches, that were pulled or undone. */
  takenOff: TakenOff[];
  /** How to start the task over, for when its earlier work was taken off. */
  restart?: string;
}

/** Does the history at `at` hold NightCrew's revert of `merge` (git revert's own message)? */
async function holdsRevert(cwd: string, merge: string, at: string): Promise<boolean> {
  if (!SHA.test(merge)) return false;
  const r = await git(cwd, "log", "-1", "--format=%H", "-F", `--grep=This reverts commit ${merge}`, at, "--");
  return r.ok && SHA.test(r.stdout.trim());
}

/**
 * The first taken-off tip that one of `heads` builds on (is it or descends
 * from it). Building on it would land only the work after it, with the
 * taken-off part left out, so the task has to start fresh. Not when the
 * default branch at `base` (the gate's base) already holds the revert: then
 * the task's change is diffed against a base without that work, and what
 * lands is what the gate saw.
 */
export async function buildsOnTakenOff(
  cwd: string,
  takenOff: TakenOff[],
  heads: string[],
  base: string,
): Promise<TakenOff | null> {
  for (const t of takenOff) {
    if (!SHA.test(t.tip)) continue;
    let under = false;
    for (const h of heads) {
      if (h === t.tip || (await git(cwd, "merge-base", "--is-ancestor", t.tip, h)).ok) {
        under = true;
        break;
      }
    }
    if (under && !(await holdsRevert(cwd, t.merge, base))) return t;
  }
  return null;
}

const lines = (out: string) => out.split("\0").filter(Boolean);

/**
 * Merge a task's fetched commit, by sha, only when what lands is what the
 * gate saw. `before` is where to reset to if the merge has to come back off.
 */
async function mergeInto(
  lane: Lane,
  sha: string,
  message: string,
  approved: Approved,
): Promise<{ ok: true; sha: string; before: string } | { ok: false; error: string }> {
  if (!SHA.test(sha) || !SHA.test(approved.base))
    return { ok: false, error: "NightCrew lands a task by its commit sha only." };
  const { dir } = lane;
  // Already merged (or shipped and undone): merging again would change nothing.
  // The only place that says so; --no-ff never makes a no-op merge after this.
  if ((await git(dir, "merge-base", "--is-ancestor", sha, "HEAD")).ok)
    return { ok: false, error: `Already on ${lane.branch}; nothing new to merge.` };
  // git merges against the merge base of the branch and the task. The gate
  // diffed from the default branch, so the merge base must sit at or under
  // the gate's base, or be this task's own earlier work that's still landed
  // here (then only what's new since lands). A task whose history takes in
  // the branch's own tip (a merge commit made in the clone, which can see
  // your repo's objects) would otherwise move it, and the merge would undo
  // branch changes the gate never saw.
  const bases = await git(dir, "merge-base", "--all", "HEAD", sha);
  const mergeBases = bases.ok ? bases.stdout.split("\n").filter(Boolean) : [];
  if (!mergeBases.length)
    return { ok: false, error: `The task's work shares no history with ${lane.branch}, so it wasn't merged.` };
  // Taken-off work first: a merge base on (or under) a pulled tip passes the
  // checks below once the revert reached the default branch or a later car of
  // the task is still on, and the pulled part would never come back.
  const earlier: Earlier = (await approved.earlier?.()) ?? { landed: [], takenOff: [] };
  const off = await buildsOnTakenOff(dir, earlier.takenOff, [...mergeBases, ...earlier.landed, sha], approved.base);
  if (off)
    return {
      ok: false,
      error: `This task's earlier work was taken off ${off.branch} (pulled or undone), so merging again would land only part of it. ${earlier.restart ?? "Start the task fresh and run it again."}`,
    };
  for (const mb of mergeBases) {
    if (earlier.landed.includes(mb)) continue;
    if ((await git(dir, "merge-base", "--is-ancestor", mb, approved.base)).ok) continue;
    return {
      ok: false,
      error: `The task's history takes in commits from ${lane.branch} that its checks didn't cover, so it wasn't merged.`,
    };
  }
  const before = await startLanding(lane, `merge ${sha}`);
  // Renames off, so the paths that land are the paths the gate listed (it
  // diffs with --no-renames). Directory renames need their own switch.
  const m = await git(
    dir,
    ...identity,
    "-c",
    "merge.directoryRenames=false",
    "merge",
    "--no-ff",
    "--no-edit",
    "-X",
    "no-renames",
    "-m",
    message,
    sha,
  );
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
  const refused = await checkLanded(lane, before, approved);
  if (refused) {
    await git(dir, "reset", "--hard", before);
    return { ok: false, error: refused };
  }
  return { ok: true, sha: await head(dir), before };
}

/**
 * Every file the merge changed on the branch is one the gate approved, or
 * one the default branch changed between the branch and the gate's base (a
 * default-branch commit, so worked out from the default branch only). The
 * checks run again on the task's whole change. A reason to refuse, or null.
 */
async function checkLanded(lane: Lane, before: string, approved: Approved): Promise<string | null> {
  const landed = await git(lane.dir, "diff", "--name-only", "-z", "--no-renames", before, "HEAD");
  if (!landed.ok) return `Couldn't list what the merge changed: ${lastLine(landed.stderr)}`;
  const files = [...new Set(lines(landed.stdout))].sort();
  const allowed = new Set(approved.files);
  const fromBase = new Set<string>();
  const bases = await git(lane.dir, "merge-base", "--all", before, approved.base);
  for (const mb of bases.ok ? bases.stdout.split("\n").filter(Boolean) : []) {
    const d = await git(lane.dir, "diff", "--name-only", "-z", "--no-renames", mb, approved.base);
    if (!d.ok) return `Couldn't list what the default branch changed: ${lastLine(d.stderr)}`;
    for (const f of lines(d.stdout)) fromBase.add(f);
  }
  const unapproved = files.filter((f) => !allowed.has(f) && !fromBase.has(f));
  if (unapproved.length)
    return `Merging into ${lane.branch} changed files outside what the task's checks covered (${unapproved.slice(0, 4).join(", ")}). That can happen when ${lane.branch} renamed or moved files the task changed. It was taken back off.`;
  const again = approved.recheck?.(approved.files) ?? null;
  return again ? `${again} It was taken back off.` : null;
}

/** Revert a merge commit. `before` is where to reset to if the revert has to come back off. */
async function revertMerge(
  lane: Lane,
  sha: string,
): Promise<{ ok: true; before: string } | { ok: false; error: string }> {
  if (!SHA.test(sha)) return { ok: false, error: "Not a commit sha." };
  const before = await startLanding(lane, `revert ${sha}`);
  const r = await git(lane.dir, ...identity, "revert", "--no-edit", "-m", "1", sha);
  if (r.ok) return { ok: true, before };
  await git(lane.dir, "revert", "--abort");
  await git(lane.dir, "reset", "--hard", before);
  return { ok: false, error: r.stderr.trim() };
}

/** Files whose change means the dependencies need installing again. */
const MANIFEST =
  /(^|\/)(package\.json|bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum|requirements[^/]*\.txt|pyproject\.toml)$/;

const tail = (r: { stdout: string; stderr: string }, n = 3000) => `${r.stdout}\n${r.stderr}`.trim().slice(-n);

/** `since` is HEAD before catching up with origin, so dependencies the catch-up brought in count too. */
async function testsPass(
  repo: Repo,
  dir: string,
  since: string,
): Promise<{ ok: boolean; setupFailed?: boolean; log: string }> {
  if (repo.setupCommand) {
    const diff = await git(dir, "diff", "--name-only", "--no-renames", since, "HEAD");
    // Can't tell what changed: install again rather than test on stale dependencies.
    const changed = diff.ok ? diff.stdout.split("\n").filter(Boolean) : ["package.json"];
    if (!existsSync(join(dir, "node_modules")) || changed.some((f) => MANIFEST.test(f))) {
      const s = await runCheck(repo.setupCommand, dir, { timeoutMs: 10 * 60_000 });
      if (!s.ok)
        return { ok: false, setupFailed: true, log: `$ ${repo.setupCommand} (exit ${s.code})\n${tail(s, 1500)}` };
    }
  }
  if (!repo.testCommand) return { ok: true, log: "No test command." };
  const t = await runCheck(repo.testCommand, dir, { timeoutMs: 15 * 60_000 });
  return { ok: t.ok, log: `$ ${repo.testCommand} (exit ${t.code})\n${tail(t)}` };
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

/** Push an integration branch's commit, by sha, if publishing and there's an origin. */
async function publishBranch(lane: Lane, publish: boolean) {
  if (!publish || !(await git(lane.repo.path, "remote", "get-url", "origin")).ok) return null;
  const p = await pushTo(lane.repo.path, await head(lane.dir), lane.branch, NETWORK_MS);
  return p.ok ? null : lastLine(p.stderr) || "push failed";
}

/** Merge the task's fetched commit into the ship branch, test, push. */
async function shipTaskUnlocked(
  repo: Repo,
  sha: string,
  title: string,
  publish: boolean,
  approved: Approved,
): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
  if (!repo.shipBranch) return { ok: false, error: "No ship branch." };
  const lane = await branchWorktree(repo, repo.shipBranch, { publish, ship: true });
  try {
    const merged = await mergeInto(lane, sha, `Ship: ${title} (NightCrew)`, approved);
    if (!merged.ok) return merged;
    const tests = await testsPass(repo, lane.dir, lane.start);
    if (!tests.ok) {
      await git(lane.dir, "reset", "--hard", merged.before);
      return {
        ok: false,
        error: tests.setupFailed
          ? `Setup failed on ${repo.shipBranch} after merging, so it wasn't shipped.\n${tests.log}`
          : `Tests failed on ${repo.shipBranch} after merging, so it wasn't shipped.\n${tests.log}`,
      };
    }
    const failed = await publishBranch(lane, publish);
    if (failed) {
      await git(lane.dir, "reset", "--hard", merged.before);
      return { ok: false, error: `Couldn't push ${repo.shipBranch}: ${failed}` };
    }
    return { ok: true, sha: merged.sha };
  } finally {
    await endLanding(lane, true);
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
  const lane = await branchWorktree(repo, shipBranch, { publish, ship: true });
  try {
    // A second Undo that waited on the lock: say so instead of a failed revert.
    if (await holdsRevert(lane.dir, sha, "HEAD")) return { ok: false, error: "That ship is already undone." };
    const r = await revertMerge(lane, sha);
    if (!r.ok)
      return { ok: false, error: `Couldn't revert ${sha.slice(0, 7)}: ${r.error || "conflicts with later changes"}` };
    const failed = await publishBranch(lane, publish);
    if (failed) {
      // Leave no stray revert behind for the next ship to push.
      await git(lane.dir, "reset", "--hard", r.before);
      return { ok: false, error: `Couldn't push ${shipBranch}, so nothing was undone: ${failed}` };
    }
    return { ok: true, sha: await head(lane.dir) };
  } finally {
    await endLanding(lane, true);
  }
}

// ── The daily train ─────────────────────────────────────────────────────────

export function trainBranch(dayId: string) {
  return `crew/train-${dayId}`;
}

/** Add a finished task's fetched commit to today's train. If the train's tests break, it comes straight back off. */
async function boardTrainUnlocked(
  repo: Repo,
  train: Train,
  sha: string,
  title: string,
  publish: boolean,
  approved: Approved,
): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
  const lane = await branchWorktree(repo, train.branch, {
    publish,
    ship: false,
    createFrom: repo.defaultBranch,
  });
  try {
    const merged = await mergeInto(lane, sha, `${title} (NightCrew)`, approved);
    if (!merged.ok) return merged;
    const tests = await testsPass(repo, lane.dir, lane.start);
    if (!tests.ok) {
      await git(lane.dir, "reset", "--hard", merged.before);
      return {
        ok: false,
        error: tests.setupFailed
          ? `Setup failed on the train after merging it.\n${tests.log}`
          : `It broke the train's tests together with today's other work.\n${tests.log}`,
      };
    }
    return { ok: true, sha: merged.sha };
  } finally {
    await endLanding(lane, false);
  }
}

/** Push the train and open (or refresh) its one PR. */
async function publishTrainUnlocked(
  repo: Repo,
  train: Train,
): Promise<{ prUrl: string; prNumber: number; warning?: string } | null> {
  const on = train.cars.filter((c) => c.state === "on");
  if (!on.length) return null;
  const lane = await branchWorktree(repo, train.branch, {
    publish: true,
    ship: false,
    createFrom: repo.defaultBranch,
  });
  if (!(await git(repo.path, "remote", "get-url", "origin")).ok) return null;
  const failed = await publishBranch(lane, true);
  if (failed) throw new Error(`Couldn't push the train: ${failed}`);
  const pulled = train.cars.filter((c) => c.state !== "on");
  const body = `Today's train for ${repo.name}: ${on.length} ${on.length === 1 ? "task" : "tasks"}, tested together.

${on.map((c) => `- [x] ${c.title}`).join("\n")}
${pulled.length ? `\nTaken off the train:\n${pulled.map((c) => `- ${c.title} (${c.state === "broke" ? "broke the tests" : "pulled by you"})`).join("\n")}\n` : ""}
Review each task's plan, evidence and Skeptic report in the NightCrew Morning Report.

---
Made by [NightCrew](https://github.com/oluoyefeso/nightcrew)`;
  const pr = await openOrUpdatePr(repo.path, {
    branch: train.branch,
    base: repo.defaultBranch,
    title: `Daily train ${train.nightId}: ${on.length} ${on.length === 1 ? "task" : "tasks"}`,
    body,
  });
  return { prUrl: pr.url, prNumber: pr.number, warning: pr.warning };
}

/** Take one task off the train: revert its merge commit. */
async function pullCarUnlocked(
  repo: Repo,
  train: Train,
  mergeSha: string,
  publish: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const lane = await branchWorktree(repo, train.branch, {
    publish,
    ship: false,
    createFrom: repo.defaultBranch,
  });
  try {
    // A second Pull that waited on the lock: say so instead of a failed revert.
    if (await holdsRevert(lane.dir, mergeSha, "HEAD")) return { ok: false, error: "It's already off the train." };
    const r = await revertMerge(lane, mergeSha);
    if (!r.ok) return { ok: false, error: "That task can't come off cleanly; later tasks build on it." };
    const failed = await publishBranch(lane, publish);
    if (failed) {
      await git(lane.dir, "reset", "--hard", r.before);
      return { ok: false, error: `Couldn't push the train, so the task stays on: ${failed}` };
    }
    return { ok: true };
  } finally {
    await endLanding(lane, false);
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
