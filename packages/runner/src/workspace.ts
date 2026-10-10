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
const pending = new Map<string, Promise<ReadyWorkspace>>();

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

/** The task's result in your repo: a fetched commit that passed the final gate. Landing and you use this one. */
export const taskRef = (taskId: string) => `refs/nightcrew/tasks/${taskId}`;
/** The task's work in progress in your repo: every fetch from its clone, checked or not. A new clone resumes from it. */
export const wipRef = (taskId: string) => `refs/nightcrew/wip/${taskId}`;
/** Where a fetch lands first, so a failed one never looks current. */
const incomingRef = (taskId: string) => `refs/nightcrew/incoming/${taskId}`;
/** The work in progress from before the crew last rewrote the branch's history, so commits from then aren't taken for yours. */
const rewrittenRef = (taskId: string) => `refs/nightcrew/rewritten/${taskId}`;

/**
 * How to throw away what NightCrew has for a task, in words: its workspace
 * (when given), its refs, and the task branch (when given, for a start
 * that shares no history with the earlier work).
 */
export function startFreshHint(taskId: string, o: { clone?: string; branch?: string } = {}): string {
  const parts = [
    ...(o.clone ? [`the task's workspace at ${o.clone}`] : []),
    `its refs (git update-ref -d ${wipRef(taskId)} && git update-ref -d ${taskRef(taskId)})`,
    ...(o.branch ? [`the ${o.branch} branch, yours and origin's if it was pushed`] : []),
  ];
  return `delete ${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]}`;
}

const segment = (s: string) => s.replace(/[^\w.-]+/g, "-").replace(/^\.+/, "_");

export function workspaceDir(dataDir: string, repoId: string, taskId: string): string {
  return join(dataDir, "work", segment(repoId), segment(taskId));
}

export interface WorkspaceOptions {
  dataDir: string;
  /** `defaultBranch`, when known, gets a branch in the clone at the gate base, for the agent's own diffs. */
  repo: { id: string; path: string; defaultBranch?: string };
  task: { id: string; branch: string };
  /** Where a task with no earlier work starts: the gate base, a commit on the default branch. */
  base: string;
  signal?: AbortSignal;
}

export type ReadyWorkspace = Workspace & {
  fresh: boolean;
  /** Commits taken in from origin's copy of the task branch (say, GitHub's "Update branch"), if any. */
  pickedUp: number;
};

/**
 * The task's clone, made if it doesn't exist yet. A new clone checks out the
 * task branch at the task's work in progress, else at its last checked
 * result, else at the branch an earlier version left in your repo (a legacy
 * worktree's branch, whose worktree stays where it is), else at the base.
 * When origin's copy of the branch builds on that work (GitHub's "Update
 * branch", a reviewer's commit), it carries on from origin's tip. Refuses
 * when your local branch, or origin's, has history NightCrew didn't make.
 */
export function ensureWorkspace(o: WorkspaceOptions): Promise<ReadyWorkspace> {
  const dir = workspaceDir(o.dataDir, o.repo.id, o.task.id);
  const running = pending.get(dir);
  if (running) return running;
  const p = setUp(o, dir).finally(() => pending.delete(dir));
  pending.set(dir, p);
  return p;
}

async function setUp(o: WorkspaceOptions, dir: string): Promise<ReadyWorkspace> {
  const ws: Workspace = { dir, repoPath: o.repo.path, taskId: o.task.id, branch: o.task.branch };
  // The repo lock covers only reading your repo's refs. Cloning reads your
  // repo without changing it, so it runs outside the lock.
  const { start, pickedUp } = await withRepoLock(
    o.repo.path,
    async () => {
      const existing = existsSync(dir);
      // A clone owns its git folder. Anything else here wasn't made by NightCrew.
      if (existing && !lstatSync(join(dir, ".git"), { throwIfNoEntry: false })?.isDirectory())
        throw new Error(
          `The task's workspace at ${dir} isn't a NightCrew clone. Delete that folder and the next run makes a new clone that picks up from ${wipRef(o.task.id)}. To start the task over from scratch, also ${startFreshHint(o.task.id, { branch: o.task.branch })}.`,
        );
      const pickedUp = await checkBranches(o.repo.path, o.task, o.repo.defaultBranch, existing ? dir : null);
      if (existing) return { start: null, pickedUp };
      const start =
        (await resolveSha(o.repo.path, wipRef(o.task.id))) ??
        (await resolveSha(o.repo.path, taskRef(o.task.id))) ??
        (await resolveSha(o.repo.path, `refs/heads/${o.task.branch}`)) ??
        o.base;
      return { start, pickedUp };
    },
    o.signal,
  );
  if (start === null) {
    known.set(realKey(dir), ws);
    if (pickedUp) {
      // Origin's commits are in your repo already; the clone takes them from there, inside the sandbox.
      const pulled = await pullIntoClone(ws, wipRef(o.task.id), { signal: o.signal });
      if (!pulled.ok)
        throw new Error(
          `Couldn't bring origin's commits on ${o.task.branch} into the task's workspace: ${lastLine(pulled.stderr) || "git failed"}`,
        );
    }
    return { ...ws, fresh: false, pickedUp };
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
  // the gate base, whatever your own checkout is on.
  const main = o.repo.defaultBranch;
  if (main && main !== o.task.branch) await step(tmp, ["update-ref", `refs/heads/${main}`, o.base]);
  // Submodule URLs as your repo resolves them, so `git submodule update --init`
  // still works once the clone has no origin to resolve relative ones against.
  for (const [key, url] of await submoduleUrls(o.repo.path, o.base)) await step(tmp, ["config", key, url]);
  await step(tmp, ["remote", "remove", "origin"]);
  renameSync(tmp, dir);
  known.set(realKey(dir), ws);
  return { ...ws, fresh: true, pickedUp };
}

/** Whether `a` is an ancestor of (or is) `b`; null when git couldn't say. */
async function isAncestor(repoPath: string, a: string, b: string): Promise<boolean | null> {
  const r = await git(repoPath, "merge-base", "--is-ancestor", a, b);
  return r.ok ? true : r.code === 1 ? false : null;
}

/**
 * Compare the task branch, yours and origin's as last fetched, with what
 * NightCrew has for the task. Origin ahead of the work in progress (GitHub's
 * "Update branch", a bot or a reviewer) is taken in: the work in progress
 * moves to origin's tip, and the count of commits it brought is returned.
 * History NightCrew didn't make stops the task, rather than be dropped.
 */
async function checkBranches(
  repoPath: string,
  task: { id: string; branch: string },
  defaultBranch: string | undefined,
  clone: string | null,
): Promise<number> {
  const wip = await resolveSha(repoPath, wipRef(task.id));
  const last = wip ?? (await resolveSha(repoPath, taskRef(task.id)));
  if (!last) return 0;
  const ours = [wip, await resolveSha(repoPath, taskRef(task.id)), await resolveSha(repoPath, rewrittenRef(task.id))];
  /** Under something NightCrew made for this task. A check git can't run doesn't stop the task. */
  const made = async (sha: string) => {
    for (const r of ours) if (r && (await isAncestor(repoPath, sha, r)) !== false) return true;
    return false;
  };
  const fresh = startFreshHint(task.id, { clone: clone ?? undefined });
  const local = await resolveSha(repoPath, `refs/heads/${task.branch}`);
  if (local && !(await made(local)))
    throw new Error(
      `${task.branch} in your repo has commits NightCrew didn't make. To carry on from NightCrew's copy, reset ${task.branch} to ${wipRef(task.id)}. To start from your branch instead, ${fresh}.`,
    );
  const origin = await resolveSha(repoPath, `refs/remotes/origin/${task.branch}`);
  if (!origin || (await made(origin))) return 0;
  if ((await isAncestor(repoPath, last, origin)) !== true)
    throw new Error(
      `${task.branch} on origin has history that doesn't build on NightCrew's copy (${wipRef(task.id)}). Push that ref over it to keep NightCrew's work, or bring origin's commits into your local ${task.branch} and ${fresh} to start from there.`,
    );
  const moved = await git(repoPath, "update-ref", wipRef(task.id), origin, ...(wip ? [wip] : []));
  if (!moved.ok) throw new Error(`Couldn't take in origin's commits on ${task.branch}: ${lastLine(moved.stderr)}`);
  // Commits from the default branch (an "Update branch" merge brings them) aren't the branch's own.
  const exclude: string[] = [];
  const mains = defaultBranch ? [`refs/heads/${defaultBranch}`, `refs/remotes/origin/${defaultBranch}`] : [];
  for (const r of mains) if (await resolveSha(repoPath, r)) exclude.push(`^${r}`);
  const count = await git(repoPath, "rev-list", "--count", origin, `^${last}`, ...exclude);
  return Math.max(1, Number(count.stdout.trim()) || 0);
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
 * Take the clone's checked-out commit into your repo as the task's work in
 * progress (refs/nightcrew/wip/<id>) and return its sha. Nothing is checked
 * yet: the result ref moves only once the final gate passes (acceptTask).
 * HEAD, not the branch: a branch switch in the clone can't hand over an
 * older, untested tip.
 */
export function fetchTask(ws: Workspace, signal?: AbortSignal): Promise<string> {
  return withRepoLock(
    ws.repoPath,
    async () => {
      // Into a fresh ref first: a fetch git declines (say, one that would need
      // your repo's shallow file updated) must not leave the last copy looking current.
      const incoming = incomingRef(ws.taskId);
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
      await recordWip(ws.repoPath, ws.taskId, sha);
      return sha;
    },
    signal,
  );
}

/**
 * Move the work-in-progress ref. When the new commit doesn't build on the
 * old one (the crew amended or reset), the old tip is kept aside so commits
 * from before the rewrite still count as NightCrew's, not yours.
 */
async function recordWip(repoPath: string, taskId: string, sha: string) {
  const prev = await resolveSha(repoPath, wipRef(taskId));
  if (prev && prev !== sha && (await isAncestor(repoPath, prev, sha)) === false)
    await git(repoPath, "update-ref", rewrittenRef(taskId), prev);
  const u = await git(repoPath, "update-ref", wipRef(taskId), sha);
  if (!u.ok) throw new Error(`Couldn't record the task's work: ${lastLine(u.stderr)}`);
}

/**
 * The final gate passed on `sha`: make it the task's result
 * (refs/nightcrew/tasks/<id>), what you check out and what lands. Returns
 * the result it replaced, or null.
 */
export function acceptTask(repoPath: string, taskId: string, sha: string): Promise<string | null> {
  return withRepoLock(repoPath, async () => {
    const prev = await resolveSha(repoPath, taskRef(taskId));
    const u = await git(repoPath, "update-ref", taskRef(taskId), sha);
    if (!u.ok) throw new Error(`Couldn't record the task's result: ${lastLine(u.stderr)}`);
    return prev;
  });
}

/**
 * Cloud work fetched from origin's task branch into your repo, as the work
 * in progress, only when it builds on `start` (where the session began).
 * False, with the work in progress untouched, otherwise.
 */
export function fetchCloudWork(ws: Workspace, branch: string, start: string | null, timeoutMs = GIT_MS) {
  return withRepoLock(ws.repoPath, async () => {
    const incoming = incomingRef(ws.taskId);
    await git(ws.repoPath, "update-ref", "-d", incoming);
    const f = await gitRun(
      ws.repoPath,
      [
        ...FETCH_FSCK,
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-recurse-submodules",
        "--no-write-fetch-head",
        "origin",
        `+refs/heads/${branch}:${incoming}`,
      ],
      { timeoutMs },
    );
    const sha = f.ok ? await resolveSha(ws.repoPath, incoming) : null;
    await git(ws.repoPath, "update-ref", "-d", incoming);
    if (!sha || (start && (await isAncestor(ws.repoPath, start, sha)) !== true)) return false;
    await recordWip(ws.repoPath, ws.taskId, sha);
    return true;
  });
}

interface CloneOpts {
  signal?: AbortSignal;
  warn?: (text: string) => void;
}

/** A shell script in the clone, in the check sandbox, with hardened git. Its output is the clone's word, not proof. */
export async function inClone(dir: string, script: string, o: CloneOpts & { timeoutMs?: number } = {}): Promise<Exec> {
  return runCheck(script, dir, {
    timeoutMs: o.timeoutMs ?? GIT_MS,
    signal: o.signal,
    warn: o.warn,
    env: GIT_ENV,
    clone: true,
    objects: await cloneObjects(dir),
  });
}

/**
 * The object folder in your repo that a clone NightCrew set up borrows from,
 * from NightCrew's own records (never the clone's alternates file), so the
 * check sandbox can let git read it.
 */
export async function cloneObjects(dir: string): Promise<string[]> {
  const ws = workspaceFor(dir);
  if (!ws) return [];
  const common = await git(ws.repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir");
  return common.ok && common.stdout.trim() ? [join(common.stdout.trim(), "objects")] : [];
}

/**
 * Point the clone's default branch at the gate base, so the crew's own
 * `git diff <default>...HEAD` shows what the gate will check. From inside
 * the sandbox; left alone when the crew has that branch checked out.
 */
export async function pointDefaultBranch(ws: Workspace, branch: string, base: string, o: CloneOpts = {}) {
  if (!branch || branch === ws.branch) return;
  const ref = `refs/heads/${branch}`;
  const r = await inClone(
    ws.dir,
    `[ "$(${gitShell("symbolic-ref", "-q", "HEAD")})" = ${shellQuote(ref)} ] || ${gitShell("update-ref", ref, base)}`,
    o,
  );
  if (!r.ok) o.warn?.(`Couldn't point ${branch} in the task's workspace at the base: ${lastLine(r.stderr)}`);
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
 * the final checks. Fast-forwards, or moves off NightCrew's own earlier
 * result (`previous`) when the crew rewrote its history, and never a branch
 * that's checked out or has commits of yours. Says why when it couldn't; the
 * work is in refs/nightcrew/tasks/<id> either way.
 */
export async function updateLocalBranch(
  repoPath: string,
  branch: string,
  sha: string,
  previous: string | null = null,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  return withRepoLock(repoPath, async () => {
    const current = await resolveSha(repoPath, `refs/heads/${branch}`);
    if (current === sha) return { ok: true };
    const ours = async (c: string) =>
      (await git(repoPath, "merge-base", "--is-ancestor", c, sha)).ok ||
      (previous !== null && (await git(repoPath, "merge-base", "--is-ancestor", c, previous)).ok);
    if (current && !(await ours(current)))
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

function readText(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/**
 * The first attribute line, across these files, that sets `filter=<name>`
 * (or `filter=<name>-<key>`), as "<file>: <pattern> filter=<value>".
 * Comments don't count.
 */
function filterLine(files: [label: string, text: string][], name: string): string | null {
  const re = new RegExp(`(?:^|\\s)filter=(${name}(?:-[\\w.-]+)?)(?=\\s|$)`);
  for (const [label, text] of files) {
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const m = re.exec(line);
      if (m) return `${label}: ${line.split(/\s+/)[0]} filter=${m[1]}`;
    }
  }
  return null;
}

/**
 * Why NightCrew can't work in this repo yet, or null when it can. Repos that
 * rely on local git setup (git-lfs, git-crypt, a sparse checkout) don't come
 * through a plain clone intact. Only setup that's in effect counts: an
 * attribute line, not a comment, and git-lfs config that points somewhere,
 * not what an old install left behind.
 */
export async function repoSupport(repoPath: string): Promise<string | null> {
  const why = (what: string) => `NightCrew can't work in this repo yet: it uses ${what}. ${UNSUPPORTED}`;
  const out = async (cwd: string, ...args: string[]) => {
    const r = await git(cwd, ...args);
    return r.ok ? r.stdout.trim() : "";
  };
  const top = (await out(repoPath, "rev-parse", "--show-toplevel")) || repoPath;
  const gitPath = async (p: string) =>
    (await out(top, "rev-parse", "--path-format=absolute", "--git-path", p)) || join(top, ".git", p);
  const listed = await git(top, "ls-files", "-z", "--", ".gitattributes", ":(glob)**/.gitattributes");
  const attributeFiles = [...new Set([".gitattributes", ...(listed.ok ? nulList(listed.stdout) : [])])];
  const attributes: [string, string][] = attributeFiles.map((f) => [f, readText(join(top, f))]);
  attributes.push([".git/info/attributes", readText(await gitPath("info/attributes"))]);

  const lfs = filterLine(attributes, "lfs");
  if (lfs) return why(`git-lfs (${lfs})`);
  // An LFS endpoint in the repo's config or .lfsconfig means objects live on an LFS server.
  const endpoint = "^lfs\\.(url|.*\\.access)$";
  const configured = (await out(top, "config", "--local", "--get-regexp", endpoint)).split("\n")[0]?.split(" ")[0];
  if (configured) return why(`git-lfs (${configured} in git config)`);
  if (existsSync(join(top, ".lfsconfig"))) {
    const inFile = (await out(top, "config", "-f", join(top, ".lfsconfig"), "--get-regexp", endpoint))
      .split("\n")[0]
      ?.split(" ")[0];
    if (inFile) return why(`git-lfs (${inFile} in .lfsconfig)`);
  }
  const crypt = filterLine(attributes, "git-crypt");
  if (crypt) return why(`git-crypt (${crypt})`);
  const sparse = (await out(top, "config", "--bool", "--get", "core.sparseCheckout")) === "true";
  const patterns = readText(await gitPath("info/sparse-checkout"))
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && l !== "/*");
  if (sparse || patterns.length) return why("sparse checkout");
  return null;
}
