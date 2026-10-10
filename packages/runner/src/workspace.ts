// Each task works in its own standalone clone under NightCrew's data folder,
// not in a worktree of your repo, so nothing an agent does to git there
// (refs, hooks, config, replace objects, the shallow file) reaches your repo.
// NightCrew never runs git in a clone itself, only through the check
// sandbox, and treats what that says as advisory. The work comes back by a
// fetch into your repo, and every check that decides anything runs there.

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  type Exec,
  FETCH_FSCK,
  GIT_ENV,
  GIT_HARDEN,
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
/** Cloning and checking out a large tree can take a while. */
const CLONE_MS = 10 * 60_000;

/** Workspaces this process set up, by real path, so engines can find the repo a clone belongs to. */
const known = new Map<string, Workspace>();
/** Clones being set up right now, by folder, so two calls for one task share the work. */
const pending = new Map<string, Promise<Workspace & { fresh: boolean }>>();

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

export interface WorkspaceOptions {
  dataDir: string;
  /** `defaultBranch`, when known, gets a branch in the clone at the pinned base, for the agent's own diffs. */
  repo: { id: string; path: string; defaultBranch?: string };
  task: { id: string; branch: string };
  base: string;
  signal?: AbortSignal;
}

/**
 * The task's clone, made if it doesn't exist yet. A new clone checks out the
 * task branch at the last work fetched from an earlier clone, else at the
 * branch an earlier version left in your repo (a legacy worktree's branch,
 * whose worktree stays where it is), else at the pinned base. Refuses when
 * you've moved the task branch past the work NightCrew last fetched.
 */
export function ensureWorkspace(o: WorkspaceOptions): Promise<Workspace & { fresh: boolean }> {
  const dir = workspaceDir(o.dataDir, o.repo.id, o.task.id);
  const running = pending.get(dir);
  if (running) return running;
  const p = setUp(o, dir).finally(() => pending.delete(dir));
  pending.set(dir, p);
  return p;
}

async function setUp(o: WorkspaceOptions, dir: string): Promise<Workspace & { fresh: boolean }> {
  const ws: Workspace = { dir, repoPath: o.repo.path, taskId: o.task.id, branch: o.task.branch };
  // The repo lock covers only reading your repo's refs. Cloning reads your
  // repo without changing it, so it runs outside the lock.
  const start = await withRepoLock(
    o.repo.path,
    async () => {
      const existing = existsSync(dir);
      // A clone owns its git folder. Anything else here wasn't made by NightCrew.
      if (existing && !lstatSync(join(dir, ".git"), { throwIfNoEntry: false })?.isDirectory())
        throw new Error(
          `The task's workspace at ${dir} isn't a NightCrew clone. Delete that folder and the next run makes a new clone that picks up from ${taskRef(o.task.id)}. To start the task over from scratch, also delete that ref (git update-ref -d ${taskRef(o.task.id)}) and ${join(o.dataDir, "bases", `${o.task.id}.sha`)}.`,
        );
      await refuseMovedBranch(o.repo.path, o.task, existing ? dir : null);
      if (existing) return null;
      return (
        (await resolveSha(o.repo.path, taskRef(o.task.id))) ??
        (await resolveSha(o.repo.path, `refs/heads/${o.task.branch}`)) ??
        o.base
      );
    },
    o.signal,
  );
  if (start === null) {
    known.set(realKey(dir), ws);
    return { ...ws, fresh: false };
  }
  // Built aside and moved into place, so a half-made clone is never reused.
  const tmp = `${dir}.new`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(dirname(dir), { recursive: true });
  const step = async (cwd: string, args: string[]) => {
    const r = await gitRun(cwd, args, { timeoutMs: CLONE_MS, signal: o.signal });
    if (!r.ok) {
      rmSync(tmp, { recursive: true, force: true });
      throw new Error(`Couldn't set up the task's workspace: ${lastLine(r.stderr) || `git ${args[0]} failed`}`);
    }
  };
  // --shared borrows your repo's objects through alternates: no copy, and no
  // hardlinked object files (--local) shared with your repo.
  await step(dirname(dir), ["clone", "--quiet", "--shared", "--no-checkout", "--no-tags", o.repo.path, tmp]);
  // Nothing else has touched the new clone yet, so NightCrew's own git is safe in it.
  await step(tmp, ["checkout", "--quiet", "-B", o.task.branch, start]);
  // The agent's prompts diff against the default branch by name. Here it's
  // the pinned base, whatever your own checkout is on.
  const main = o.repo.defaultBranch;
  if (main && main !== o.task.branch) await step(tmp, ["update-ref", `refs/heads/${main}`, o.base]);
  // Submodule URLs as your repo resolves them, so `git submodule update --init`
  // still works once the clone has no origin to resolve relative ones against.
  for (const [key, url] of await submoduleUrls(o.repo.path, o.base)) await step(tmp, ["config", key, url]);
  await step(tmp, ["remote", "remove", "origin"]);
  renameSync(tmp, dir);
  known.set(realKey(dir), ws);
  return { ...ws, fresh: true };
}

/**
 * Stop when the task branch (yours, or origin's as last fetched) has commits
 * the last fetched work doesn't, rather than quietly carry on without them.
 */
async function refuseMovedBranch(repoPath: string, task: { id: string; branch: string }, clone: string | null) {
  const ref = taskRef(task.id);
  const last = await resolveSha(repoPath, ref);
  if (!last) return;
  const behind = async (sha: string | null) =>
    !sha || (await git(repoPath, "merge-base", "--is-ancestor", sha, last)).code !== 1;
  const andClone = clone ? ` and the task's workspace at ${clone}` : "";
  if (!(await behind(await resolveSha(repoPath, `refs/heads/${task.branch}`))))
    throw new Error(
      `You moved ${task.branch} since NightCrew last worked on it. Reset it to ${ref}, or delete that ref${andClone} to start from your branch.`,
    );
  if (!(await behind(await resolveSha(repoPath, `refs/remotes/origin/${task.branch}`))))
    throw new Error(
      `${task.branch} on origin has commits NightCrew hasn't seen. Push ${ref} over it, or bring those commits into your local ${task.branch} and delete ${ref}${andClone} to start from there.`,
    );
}

/** `submodule.<name>.url` for each submodule at `base`, as your repo resolves it. */
async function submoduleUrls(repoPath: string, base: string): Promise<[string, string][]> {
  const pattern = "^submodule\\..*\\.url$";
  const listed = await git(repoPath, "config", "-z", "--blob", `${base}:.gitmodules`, "--get-regexp", pattern);
  if (!listed.ok) return [];
  const entries = (out: string) =>
    new Map(
      nulList(out).map((e) => {
        const i = e.indexOf("\n");
        return i < 0 ? [e, ""] : [e.slice(0, i), e.slice(i + 1)];
      }),
    );
  const own = entries((await git(repoPath, "config", "-z", "--get-regexp", pattern)).stdout);
  const origin = (await git(repoPath, "config", "--get", "remote.origin.url")).stdout.trim();
  const out: [string, string][] = [];
  for (const [key, declared] of entries(listed.stdout)) {
    let url = own.get(key) ?? declared;
    if (/^\.\.?\//.test(url)) url = resolveRelativeUrl(origin || repoPath, url);
    // git refuses option-like URLs anyway; never hand one to `git config`.
    if (url && !url.startsWith("-")) out.push([key, url]);
  }
  return out;
}

/** A relative submodule URL (`../x`, `./x`) against its superproject's URL or path, the way git does it. */
export function resolveRelativeUrl(base: string, rel: string): string {
  let b = base.replace(/\/+$/, "");
  let r = rel;
  for (;;) {
    if (r.startsWith("./")) r = r.slice(2);
    else if (r.startsWith("../")) {
      r = r.slice(3);
      const i = Math.max(b.lastIndexOf("/"), b.lastIndexOf(":"));
      b = i < 0 ? "" : b.slice(0, b[i] === ":" ? i + 1 : i);
    } else break;
  }
  if (!b) return r;
  return b.endsWith(":") ? `${b}${r}` : `${b}/${r}`;
}

/**
 * Take the clone's checked-out commit into your repo as
 * refs/nightcrew/tasks/<id> and return its sha. This is the commit every
 * final check looks at. HEAD, not the branch: a branch switch in the clone
 * can't hand over an older, untested tip.
 */
export function fetchTask(ws: Workspace, signal?: AbortSignal): Promise<string> {
  return withRepoLock(
    ws.repoPath,
    async () => {
      // Into a fresh ref first: a fetch git declines (say, one that would need
      // your repo's shallow file updated) must not leave the last copy looking current.
      const incoming = `refs/nightcrew/incoming/${ws.taskId}`;
      await git(ws.repoPath, "update-ref", "-d", incoming);
      const f = await gitRun(
        ws.repoPath,
        [
          ...FETCH_FSCK,
          "-c",
          "protocol.file.allow=always",
          "fetch",
          "--quiet",
          "--no-tags",
          "--no-recurse-submodules",
          "--no-write-fetch-head",
          ws.dir,
          `+HEAD:${incoming}`,
        ],
        { timeoutMs: GIT_MS },
      );
      const sha = f.ok ? await resolveSha(ws.repoPath, incoming) : null;
      await git(ws.repoPath, "update-ref", "-d", incoming);
      if (!sha)
        throw new Error(
          `Couldn't take the task's work from its workspace${f.ok ? "." : `: ${lastLine(f.stderr)}`} Check that ${ws.dir} has a commit checked out.`,
        );
      const u = await git(ws.repoPath, "update-ref", taskRef(ws.taskId), sha);
      if (!u.ok) throw new Error(`Couldn't record the task's work: ${lastLine(u.stderr)}`);
      return sha;
    },
    signal,
  );
}

interface CloneOpts {
  signal?: AbortSignal;
  warn?: (text: string) => void;
}

/** A shell script in the clone, in the check sandbox, with hardened git. Its output is the clone's word, not proof. */
export function inClone(dir: string, script: string, o: CloneOpts & { timeoutMs?: number } = {}): Promise<Exec> {
  return runCheck(script, dir, {
    timeoutMs: o.timeoutMs ?? GIT_MS,
    signal: o.signal,
    warn: o.warn,
    env: GIT_ENV,
    clone: true,
  });
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
 * the final checks. Only fast-forwards, and never a branch that's checked
 * out. Says why when it couldn't; the work is in refs/nightcrew/tasks/<id> either way.
 */
export async function updateLocalBranch(
  repoPath: string,
  branch: string,
  sha: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  return withRepoLock(repoPath, async () => {
    const current = await resolveSha(repoPath, `refs/heads/${branch}`);
    if (current === sha) return { ok: true };
    if (current && !(await git(repoPath, "merge-base", "--is-ancestor", current, sha)).ok)
      return { ok: false, reason: `${branch} has commits that aren't in the task's work` };
    const b = await git(repoPath, "branch", "--force", "--no-track", branch, sha);
    if (b.ok) return { ok: true };
    return {
      ok: false,
      reason: /worktree|current branch|checked out/i.test(b.stderr)
        ? `${branch} is checked out`
        : lastLine(b.stderr) || "git branch failed",
    };
  });
}

/** Repo setups a task's clone can't reproduce. */
const UNSUPPORTED = "Support is coming; see docs/security.md.";

function gitSync(cwd: string, args: string[]): { ok: boolean; out: string } {
  try {
    const r = Bun.spawnSync(["git", ...GIT_HARDEN, ...args], {
      cwd,
      env: { ...process.env, ...GIT_ENV },
      stdout: "pipe",
      stderr: "ignore",
    });
    return { ok: r.exitCode === 0, out: r.stdout.toString() };
  } catch {
    return { ok: false, out: "" };
  }
}

function readText(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/**
 * Why NightCrew can't work in this repo yet, or null when it can. Repos that
 * rely on local git setup (git-lfs, git-crypt, a sparse checkout) don't come
 * through a plain clone intact.
 */
export function repoSupport(repoPath: string): string | null {
  const why = (what: string) => `NightCrew can't work in this repo yet: it uses ${what}. ${UNSUPPORTED}`;
  const top = gitSync(repoPath, ["rev-parse", "--show-toplevel"]).out.trim() || repoPath;
  const gitPath = (p: string) =>
    gitSync(top, ["rev-parse", "--path-format=absolute", "--git-path", p]).out.trim() || join(top, ".git", p);
  const common =
    gitSync(top, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).out.trim() || join(top, ".git");
  const listed = gitSync(top, ["ls-files", "-z", "--", ".gitattributes", ":(glob)**/.gitattributes"]);
  const attributes = [".gitattributes", ...(listed.ok ? nulList(listed.out) : [])]
    .map((f) => readText(join(top, f)))
    .concat(readText(gitPath("info/attributes")))
    .join("\n");
  if (
    /\bfilter\s*=\s*lfs\b/.test(attributes) ||
    existsSync(join(top, ".lfsconfig")) ||
    existsSync(join(common, "lfs", "objects")) ||
    gitSync(top, ["config", "--local", "--get-regexp", "^lfs\\."]).ok
  )
    return why("git-lfs");
  if (/\bfilter\s*=\s*git-crypt\b/.test(attributes) || existsSync(join(common, "git-crypt"))) return why("git-crypt");
  const sparse = gitSync(top, ["config", "--bool", "--get", "core.sparseCheckout"]).out.trim() === "true";
  const patterns = readText(gitPath("info/sparse-checkout"))
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && l !== "/*");
  if (sparse || patterns.length) return why("sparse checkout");
  return null;
}
