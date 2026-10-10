// Each task works in its own standalone clone under NightCrew's data folder,
// not in a worktree of your repo, so nothing an agent does to git there
// (refs, hooks, config, replace objects, the shallow file) reaches your repo.
// NightCrew never runs git in a clone itself, only through the check
// sandbox, and treats what that says as advisory. The work comes back by a
// fetch into your repo, and every check that decides anything runs there.

import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  type Exec,
  GIT_ENV,
  git,
  gitRun,
  gitShell,
  lastLine,
  nulList,
  resolveSha,
  shellQuote,
  untouchedSetupFiles,
  withRepoLock,
} from "./git";
import { runCheck } from "./sandbox";

export interface Workspace {
  /** The task's clone. */
  dir: string;
  /** Your repo, which the clone borrows objects from and NightCrew fetches results into. */
  repoPath: string;
  taskId: string;
  branch: string;
}

/** Local git operations give up after this long. */
const GIT_MS = 120_000;

/** Workspaces this process set up, by real path, so engines can find the repo a clone belongs to. */
const known = new Map<string, Workspace>();

function realKey(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** The workspace NightCrew set up at `dir`, or null if it didn't. */
export function workspaceFor(dir: string): Workspace | null {
  return known.get(realKey(dir)) ?? null;
}

/** Where a fetched task commit lives in your repo. */
export const taskRef = (taskId: string) => `refs/nightcrew/tasks/${taskId}`;

const segment = (s: string) => s.replace(/[^\w.-]+/g, "-").replace(/^\.+/, "_");

export function workspaceDir(dataDir: string, repoId: string, taskId: string): string {
  return join(dataDir, "work", segment(repoId), segment(taskId));
}

/**
 * The task's clone, made if it doesn't exist yet. A new clone checks out the
 * task branch at the last work fetched from an earlier clone, else at the
 * branch an earlier version left in your repo (a legacy worktree's branch,
 * whose worktree stays where it is), else at the pinned base.
 */
export function ensureWorkspace(o: {
  dataDir: string;
  repo: { id: string; path: string };
  task: { id: string; branch: string };
  base: string;
}): Promise<Workspace & { fresh: boolean }> {
  return withRepoLock(o.repo.path, () => ensureWorkspaceUnlocked(o));
}

async function ensureWorkspaceUnlocked(o: {
  dataDir: string;
  repo: { id: string; path: string };
  task: { id: string; branch: string };
  base: string;
}): Promise<Workspace & { fresh: boolean }> {
  const dir = workspaceDir(o.dataDir, o.repo.id, o.task.id);
  const ws: Workspace = { dir, repoPath: o.repo.path, taskId: o.task.id, branch: o.task.branch };
  if (existsSync(dir)) {
    // A clone owns its git folder. Anything else here wasn't made by NightCrew.
    if (!lstatSync(join(dir, ".git"), { throwIfNoEntry: false })?.isDirectory())
      throw new Error(
        `The task's workspace at ${dir} isn't a NightCrew clone. Delete that folder to start the task over.`,
      );
    known.set(realKey(dir), ws);
    return { ...ws, fresh: false };
  }
  const start =
    (await resolveSha(o.repo.path, taskRef(o.task.id))) ??
    (await resolveSha(o.repo.path, `refs/heads/${o.task.branch}`)) ??
    o.base;
  // Built aside and moved into place, so a half-made clone is never reused.
  const tmp = `${dir}.new`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(dirname(dir), { recursive: true });
  // --shared borrows your repo's objects through alternates: no copy, and no
  // hardlinked object files (--local) shared with your repo.
  const steps: [string, string[]][] = [
    [dirname(dir), ["clone", "--quiet", "--shared", "--no-checkout", "--no-tags", o.repo.path, tmp]],
    // Nothing else has touched the new clone yet, so NightCrew's own git is safe in it.
    [tmp, ["checkout", "--quiet", "-B", o.task.branch, start]],
    [tmp, ["remote", "remove", "origin"]],
  ];
  for (const [cwd, args] of steps) {
    const r = await gitRun(cwd, args, { timeoutMs: GIT_MS });
    if (!r.ok) {
      rmSync(tmp, { recursive: true, force: true });
      throw new Error(`Couldn't set up the task's workspace: ${lastLine(r.stderr)}`);
    }
  }
  renameSync(tmp, dir);
  known.set(realKey(dir), ws);
  return { ...ws, fresh: true };
}

/**
 * Take the clone's task branch into your repo as refs/nightcrew/tasks/<id>
 * and return its sha. This is the commit every final check looks at.
 */
export function fetchTask(ws: Workspace): Promise<string> {
  return withRepoLock(ws.repoPath, async () => {
    // Into a fresh ref first: a fetch git declines (say, one that would need
    // your repo's shallow file updated) must not leave the last copy looking current.
    const incoming = `refs/nightcrew/incoming/${ws.taskId}`;
    await git(ws.repoPath, "update-ref", "-d", incoming);
    const f = await gitRun(
      ws.repoPath,
      [
        "-c",
        "protocol.file.allow=always",
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-recurse-submodules",
        "--no-write-fetch-head",
        ws.dir,
        `+refs/heads/${ws.branch}:${incoming}`,
      ],
      { timeoutMs: GIT_MS },
    );
    const sha = f.ok ? await resolveSha(ws.repoPath, incoming) : null;
    await git(ws.repoPath, "update-ref", "-d", incoming);
    if (!sha)
      throw new Error(
        `Couldn't take the task's work from its workspace${f.ok ? "." : `: ${lastLine(f.stderr)}`} Check the ${ws.branch} branch in ${ws.dir}.`,
      );
    const u = await git(ws.repoPath, "update-ref", taskRef(ws.taskId), sha);
    if (!u.ok) throw new Error(`Couldn't record the task's work: ${lastLine(u.stderr)}`);
    return sha;
  });
}

interface CloneOpts {
  signal?: AbortSignal;
  warn?: (text: string) => void;
}

/** A shell script in the clone, in the check sandbox, with hardened git. Its output is the clone's word, not proof. */
export function inClone(dir: string, script: string, o: CloneOpts & { timeoutMs?: number } = {}): Promise<Exec> {
  return runCheck(script, dir, { timeoutMs: o.timeoutMs ?? GIT_MS, signal: o.signal, warn: o.warn, env: GIT_ENV });
}

/**
 * What the clone says changed against the base: tracked changes (committed
 * or not) and new files. Advisory, for the checks between agent phases; the
 * final gate reads the fetched commit in your repo instead. Fails closed.
 */
export async function cloneChangedFiles(dir: string, base: string, o: CloneOpts = {}): Promise<string[]> {
  const tracked = await inClone(dir, gitShell("diff", "--name-only", "-z", "--no-renames", base), o);
  if (!tracked.ok) throw new Error(`Couldn't list the changed files: ${lastLine(tracked.stderr)}`);
  const added = await inClone(dir, gitShell("ls-files", "-z", "--others", "--exclude-standard"), o);
  if (!added.ok) throw new Error(`Couldn't list the new files: ${lastLine(added.stderr)}`);
  return [...new Set([...nulList(tracked.stdout), ...nulList(added.stdout)])].sort();
}

/** Put setup-only files back in the clone: restore tracked ones, delete new ones. */
export async function dropSetupFiles(dir: string, setup: Map<string, string>, o: CloneOpts = {}): Promise<void> {
  const files = [...(await untouchedSetupFiles(dir, setup))];
  if (!files.length) return;
  const script = files
    .map((f) => {
      const q = shellQuote(f);
      return `if ${gitShell("ls-files", "--error-unmatch", "--")} ${q} >/dev/null 2>&1; then ${gitShell("checkout", "--")} ${q}; else rm -f -- ${q}; fi`;
    })
    .join("\n");
  await inClone(dir, script, o);
}

/** Commit everything in the clone, without hooks. False when there was nothing to commit. */
export async function commitInClone(dir: string, message: string, o: CloneOpts = {}): Promise<boolean> {
  const commit = gitShell(
    "-c",
    "user.name=NightCrew",
    "-c",
    "user.email=crew@nightcrew.dev",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "--no-verify",
    "-m",
    message,
  );
  const r = await inClone(
    dir,
    `${gitShell("add", "-A")} && if ${gitShell("diff", "--cached", "--quiet")}; then echo nightcrew:nothing; else ${commit} && echo nightcrew:committed; fi`,
    o,
  );
  if (!r.ok) throw new Error(`git commit failed: ${lastLine(r.stderr) || lastLine(r.stdout)}`);
  return r.stdout.includes("nightcrew:committed");
}

/** Update the clone to a commit already in your repo (managed mode's cloud work), from inside the sandbox. */
export async function pullIntoClone(ws: Workspace, ref: string, o: CloneOpts = {}): Promise<Exec> {
  return inClone(
    ws.dir,
    `${gitShell("-c", "protocol.file.allow=always", "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", ws.repoPath, ref)} && ${gitShell("reset", "--quiet", "--hard", "FETCH_HEAD")}`,
    o,
  );
}

/**
 * A convenience copy of the task branch in your repo, at a commit that passed
 * the final checks. Only fast-forwards, and never a branch that's checked out.
 */
export async function updateLocalBranch(repoPath: string, branch: string, sha: string): Promise<void> {
  await withRepoLock(repoPath, async () => {
    const current = await resolveSha(repoPath, `refs/heads/${branch}`);
    if (current && current !== sha && !(await git(repoPath, "merge-base", "--is-ancestor", current, sha)).ok) return;
    await git(repoPath, "branch", "--force", "--no-track", branch, sha);
  });
}
