import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { slugify } from "@nightcrew/core";

export interface Exec {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

/** How long a stopped command gets to exit after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 2000;
/** How long a killed command's output gets once it has exited; its children can hold the pipes. */
const PIPE_GRACE_MS = 1000;
/** How long a command that exited on its own gets for its output to finish before leftovers holding it are killed. */
const EXIT_GRACE_MS = 1000;
/** Output kept per stream: the start and the end, with the middle dropped. */
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 1024 * 1024;

/**
 * Signal a command and everything in its process group. Checks lead their own
 * group (they start a new session), so a stop also reaches what they spawned.
 * A command that isn't a group leader gets the signal by pid.
 */
export function signalTree(pid: number, sig: NodeJS.Signals | 0, fallback: () => void): boolean {
  try {
    process.kill(-pid, sig);
    return true;
  } catch {
    try {
      fallback();
    } catch {}
    return false;
  }
}

type Proc = {
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | number | null;
  kill: (sig?: NodeJS.Signals) => void;
};

const alive = (proc: Proc) => proc.exitCode === null && proc.signalCode === null;

/**
 * Commands that may still have a live process group. While the leader runs,
 * `-pid` can only be its own group, and once it's gone a group by that id is
 * still its own until the group empties; so NightCrew only signals tracked ids.
 */
const live = new Map<number, Proc>();
let exitHook = false;

/** Keep a command (and its group) on the list SIGKILLed when NightCrew exits. Returns the untrack. */
export function trackTree(proc: Proc): () => void {
  if (!exitHook) {
    exitHook = true;
    process.on("exit", () => {
      for (const [pid, p] of live) signalTree(pid, "SIGKILL", () => alive(p) && p.kill("SIGKILL"));
    });
  }
  live.set(proc.pid, proc);
  return () => {
    if (live.get(proc.pid) === proc) live.delete(proc.pid);
  };
}

const terminating = new WeakMap<Proc, Promise<void>>();

/**
 * SIGTERM a command and its group, then SIGKILL whatever is left after
 * `graceMs`. Resolves once the leader and the group are gone (or SIGKILLed).
 * The group is re-checked every tick, so a group that empties is never
 * signalled again, even if its id gets reused.
 */
export function terminateTree(proc: Proc, graceMs = KILL_GRACE_MS): Promise<void> {
  const prior = terminating.get(proc);
  if (prior) return prior;
  const untrack = trackTree(proc);
  const group = signalTree(proc.pid, "SIGTERM", () => alive(proc) && proc.kill("SIGTERM"));
  const started = Date.now();
  const done = new Promise<void>((resolve) => {
    const tick = () => {
      const leader = alive(proc);
      const gone = group ? !leader && !signalTree(proc.pid, 0, () => {}) : !leader;
      if (!gone && Date.now() - started >= graceMs) {
        if (group && (leader || signalTree(proc.pid, 0, () => {}))) signalTree(proc.pid, "SIGKILL", () => {});
        else if (leader) proc.kill("SIGKILL");
      } else if (!gone) return void setTimeout(tick, 100);
      untrack();
      resolve();
    };
    tick();
  });
  terminating.set(proc, done);
  return done;
}

/** Read a stream, keeping only its first HEAD_BYTES and last TAIL_BYTES. */
function boundedReader(stream: ReadableStream<Uint8Array>) {
  const head: Uint8Array[] = [];
  let headLen = 0;
  const tail: Uint8Array[] = [];
  let tailLen = 0;
  let omitted = 0;
  const reader = stream.getReader();
  const done = (async () => {
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) return;
        let chunk = r.value;
        if (headLen < HEAD_BYTES) {
          const take = Math.min(HEAD_BYTES - headLen, chunk.length);
          head.push(chunk.slice(0, take));
          headLen += take;
          chunk = chunk.subarray(take);
        }
        if (!chunk.length) continue;
        tail.push(chunk);
        tailLen += chunk.length;
        while (tail.length > 1 && tailLen - (tail[0]?.length ?? 0) >= TAIL_BYTES) {
          const dropped = tail.shift()?.length ?? 0;
          tailLen -= dropped;
          omitted += dropped;
        }
        if (tailLen > TAIL_BYTES && tail[0]) {
          const extra = tailLen - TAIL_BYTES;
          tail[0] = tail[0].slice(extra);
          tailLen -= extra;
          omitted += extra;
        }
      }
    } catch {}
  })();
  const decode = (parts: Uint8Array[]) => new TextDecoder().decode(Buffer.concat(parts));
  return {
    done,
    stop: () => void reader.cancel().catch(() => {}),
    text: () =>
      omitted ? `${decode(head)}\n… ${omitted} bytes omitted …\n${decode(tail)}` : decode([...head, ...tail]),
  };
}

export async function run(
  cmd: string[],
  cwd: string,
  opts: {
    timeoutMs?: number;
    env?: Record<string, string>;
    /** The environment to start from instead of NightCrew's own. */
    baseEnv?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
): Promise<Exec> {
  if (opts.signal?.aborted) return { ok: false, code: -1, stdout: "", stderr: "Stopped." };
  try {
    const proc = Bun.spawn(cmd, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...(opts.baseEnv ?? process.env), ...opts.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const untrack = trackTree(proc);
    const out = boundedReader(proc.stdout);
    const err = boundedReader(proc.stderr);
    const output = Promise.all([out.done, err.done]);
    let killed: "Stopped." | "Timed out." | undefined;
    let leftovers = false;
    let wake = () => {};
    const woken = new Promise<void>((r) => {
      wake = r;
    });
    // Armed until the output settles, not just until the leader exits: a stop
    // or timeout still reaches what's left of the group.
    const kill = (why: "Stopped." | "Timed out.") => {
      if (killed) return;
      killed = why;
      void terminateTree(proc);
      wake();
    };
    const timer = opts.timeoutMs ? setTimeout(() => kill("Timed out."), opts.timeoutMs) : undefined;
    const onAbort = () => kill("Stopped.");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const code = await proc.exited;
      if (!killed) {
        const settled = await Promise.race([
          output.then(() => true),
          woken.then(() => false),
          Bun.sleep(EXIT_GRACE_MS).then(() => false),
        ]);
        // Finished, but something it left behind still holds the output.
        if (!settled && !killed) {
          leftovers = true;
          void terminateTree(proc);
        }
      }
      // A killed command's children can hold its pipes open; don't wait on them.
      if (killed || leftovers) await Promise.race([output, Bun.sleep(PIPE_GRACE_MS)]);
      out.stop();
      err.stop();
      const stdout = out.text();
      const stderr = err.text();
      if (killed) return { ok: false, code: code ?? -1, stdout, stderr: `${stderr}\n${killed}`.trim() };
      return { ok: code === 0, code, stdout, stderr };
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      // A group being terminated stays tracked until it's gone.
      if (!terminating.has(proc)) untrack();
    }
  } catch (e) {
    return { ok: false, code: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Flags on every git command NightCrew runs: no hooks (a repo's own
 * core.hooksPath, like husky's, would otherwise run planted scripts during
 * NightCrew's commits, merges and pushes), no fsmonitor daemon, no git-lfs
 * downloads on checkout or merge, and no submodule recursion. `-c` reaches
 * child git processes in the same repo, submodules included. It does not
 * reach a local upload-pack or receive-pack: git starts those with the other
 * repo's own config.
 */
export const GIT_HARDEN = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "filter.lfs.process=",
  "-c",
  "filter.lfs.smudge=cat",
  "-c",
  "filter.lfs.required=false",
  "-c",
  "submodule.recurse=false",
];
/** And its environment: replace refs never swap objects, git-lfs never downloads, and nothing prompts. */
export const GIT_ENV: Record<string, string> = {
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_LFS_SKIP_SMUDGE: "1",
  GIT_TERMINAL_PROMPT: "0",
};

/** For fetches of commits NightCrew didn't make: check every object that comes in. */
export const FETCH_FSCK = ["-c", "fetch.fsckObjects=true", "-c", "transfer.fsckObjects=true"];

/** Hardened git. Every git command NightCrew runs on the host goes through here. */
export function gitRun(cwd: string, args: string[], opts: { timeoutMs?: number; signal?: AbortSignal } = {}) {
  return run(["git", ...GIT_HARDEN, ...args], cwd, { ...opts, env: GIT_ENV });
}

export const git = (cwd: string, ...args: string[]) => gitRun(cwd, args);

/** One shell word. */
export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Hardened git as a shell command, for running inside the check sandbox. */
export function gitShell(...args: string[]): string {
  return ["git", ...GIT_HARDEN, ...args].map(shellQuote).join(" ");
}

/** The last line of a command's error output, for messages. */
export function lastLine(s: string): string {
  return s.trim().split("\n").pop() ?? "";
}

const repoLocks = new Map<string, Promise<unknown>>();

/**
 * Run git admin work (worktrees, trains, ships) for one repo at a time, so
 * parallel agents never race on .git/worktrees or an integration branch. A
 * stop while waiting gives up the wait, and `fn` never runs.
 */
export function withRepoLock<T>(repoPath: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const prev = repoLocks.get(repoPath) ?? Promise.resolve();
  let started = false;
  const go = () => {
    if (signal?.aborted) return Promise.reject(new Error("Stopped."));
    started = true;
    return fn();
  };
  const next = prev.then(go, go);
  repoLocks.set(
    repoPath,
    next.catch(() => {}),
  );
  if (!signal) return next;
  return new Promise<T>((resolve, reject) => {
    // Once `fn` has the lock it finishes; only the wait is given up.
    const onAbort = () => {
      if (!started) reject(new Error("Stopped."));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    next.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export interface RepoInfo {
  path: string;
  name: string;
  defaultBranch: string;
  remote: string | null;
}

/** Look at a folder and describe the git repo in it. */
export async function inspectRepo(input: string): Promise<RepoInfo> {
  const path = resolve(input);
  const top = await git(path, "rev-parse", "--show-toplevel");
  if (!top.ok) throw new Error(`${path} isn't a git repository.`);
  const root = top.stdout.trim();
  const remote = (await git(root, "remote", "get-url", "origin")).stdout.trim() || null;
  let defaultBranch = (await git(root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")).stdout
    .trim()
    .replace(/^origin\//, "");
  if (!defaultBranch) {
    for (const b of ["main", "master", "develop"]) {
      if ((await git(root, "rev-parse", "--verify", "--quiet", b)).ok) {
        defaultBranch = b;
        break;
      }
    }
  }
  if (!defaultBranch) defaultBranch = (await git(root, "branch", "--show-current")).stdout.trim() || "main";
  const name = remote
    ? (remote
        .replace(/\.git$/, "")
        .split(/[/:]/)
        .pop() ?? basename(root))
    : basename(root);
  return { path: root, name, defaultBranch, remote };
}

/** Guess the test command from the files in a repo. */
export function detectTestCommand(path: string): string | null {
  const has = (f: string) => existsSync(join(path, f));
  if (has("package.json")) {
    try {
      const pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf8")) as { scripts?: Record<string, string> };
      if (pkg.scripts?.test && !pkg.scripts.test.includes("no test specified")) {
        const pm =
          has("bun.lock") || has("bun.lockb")
            ? "bun"
            : has("pnpm-lock.yaml")
              ? "pnpm"
              : has("yarn.lock")
                ? "yarn"
                : "npm";
        return pm === "npm" ? "npm test" : `${pm} run test`;
      }
    } catch {}
  }
  if (has("Cargo.toml")) return "cargo test";
  if (has("go.mod")) return "go test ./...";
  if (has("pyproject.toml") || has("pytest.ini")) return "pytest -q";
  if (has("Makefile") && /^test:/m.test(readFileSync(join(path, "Makefile"), "utf8"))) return "make test";
  return null;
}

type PackageJson = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function readPackage(path: string): PackageJson | null {
  try {
    return JSON.parse(readFileSync(join(path, "package.json"), "utf8")) as PackageJson;
  } catch {
    return null;
  }
}

function packageManager(path: string): "bun" | "pnpm" | "yarn" | "npm" {
  const has = (f: string) => existsSync(join(path, f));
  return has("bun.lock") || has("bun.lockb")
    ? "bun"
    : has("pnpm-lock.yaml")
      ? "pnpm"
      : has("yarn.lock")
        ? "yarn"
        : "npm";
}

/** How to install dependencies in a fresh worktree. */
export function detectSetupCommand(path: string): string | null {
  const has = (f: string) => existsSync(join(path, f));
  if (has("package.json")) {
    const pm = packageManager(path);
    return pm === "bun"
      ? "bun install --frozen-lockfile"
      : pm === "pnpm"
        ? "pnpm install --frozen-lockfile"
        : pm === "yarn"
          ? "yarn install --frozen-lockfile"
          : has("package-lock.json")
            ? "npm ci"
            : // No lockfile: install without creating one, so setup never adds files to the task.
              "npm install --no-package-lock --no-save";
  }
  if (has("uv.lock")) return "uv sync";
  if (has("requirements.txt")) return "pip install -r requirements.txt";
  return null;
}

/**
 * How to run the app for screenshots. "static" means NightCrew serves the
 * folder itself. $PORT is set in the environment.
 */
export function detectPreview(path: string): { command: string; url: string } | null {
  const pkg = readPackage(path);
  if (pkg?.scripts) {
    const pm = packageManager(path);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const run = (script: string, args = "") => `${pm} run ${script}${args ? ` -- ${args}` : ""}`;
    const script = pkg.scripts.dev ? "dev" : pkg.scripts.start ? "start" : pkg.scripts.preview ? "preview" : null;
    if (script) {
      const body = pkg.scripts[script] ?? "";
      if (deps.vite || /\bvite\b/.test(body))
        return { command: run(script, "--port $PORT --strictPort"), url: "http://localhost:{port}" };
      if (deps.next || /\bnext\b/.test(body))
        return { command: run(script, "-p $PORT"), url: "http://localhost:{port}" };
      if (deps.astro || /\bastro\b/.test(body))
        return { command: run(script, "--port $PORT"), url: "http://localhost:{port}" };
      return { command: run(script), url: "http://localhost:{port}" };
    }
  }
  if (existsSync(join(path, "index.html"))) return { command: "static", url: "http://localhost:{port}" };
  return null;
}

/** A throwaway checkout of the base branch, for before-screenshots and fail-then-pass. */
export function baseWorktree(
  repoPath: string,
  base: string,
  label: string,
): Promise<{ dir: string; remove: () => Promise<void> }> {
  return withRepoLock(repoPath, () => baseWorktreeUnlocked(repoPath, base, label));
}

async function baseWorktreeUnlocked(
  repoPath: string,
  base: string,
  label: string,
): Promise<{ dir: string; remove: () => Promise<void> }> {
  const dir = join(repoPath, ".worktrees", `_base-${slugify(label, 40)}`);
  excludeWorktrees(repoPath);
  if (existsSync(dir)) await git(repoPath, "worktree", "remove", "--force", dir);
  const add = await git(repoPath, "worktree", "add", "--detach", dir, base);
  if (!add.ok) throw new Error(`Couldn't check out ${base} for comparison: ${add.stderr.trim()}`);
  return {
    dir,
    remove: () =>
      withRepoLock(repoPath, async () => {
        await git(repoPath, "worktree", "remove", "--force", dir);
      }),
  };
}

/** Keep .worktrees out of `git status` without touching the repo's .gitignore. */
function excludeWorktrees(repoPath: string) {
  const gitDir = join(repoPath, ".git");
  if (!existsSync(gitDir)) return;
  const exclude = join(gitDir, "info", "exclude");
  try {
    mkdirSync(join(gitDir, "info"), { recursive: true });
    const text = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    if (!/^\/?\.worktrees\/?$/m.test(text))
      appendFileSync(exclude, `${text.endsWith("\n") || !text ? "" : "\n"}.worktrees/\n`);
  } catch {}
}

/** Paths from `-z` output. */
export function nulList(out: string): string[] {
  return out.split("\0").filter(Boolean);
}

/**
 * Every file a fetched task commit changes against the pinned base, read by
 * your repo's own git. The commit must build on the base. Throws rather than
 * guess: a check that can't run is a failed check.
 */
export async function taskChangedFiles(repoPath: string, base: string, sha: string): Promise<string[]> {
  const anc = await git(repoPath, "merge-base", "--is-ancestor", base, sha);
  if (anc.code === 1)
    throw new Error("The task's work doesn't build on the commit it started from, so NightCrew won't trust its diff.");
  if (!anc.ok) throw new Error(`Couldn't check the task's history: ${lastLine(anc.stderr)}`);
  // --no-renames: a rename would otherwise list only the new path and hide the old one.
  const d = await git(repoPath, "diff", "--name-only", "-z", "--no-renames", base, sha);
  if (!d.ok) throw new Error(`Couldn't list the task's changed files: ${lastLine(d.stderr)}`);
  return [...new Set(nulList(d.stdout))].sort();
}

/** Content hash of each file (or "missing"), to tell setup's changes from the agent's. Never follows a symlink. */
export async function fingerprints(dir: string, files: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const f of files) {
    if (isAbsolute(f) || f.split("/").includes("..")) {
      out.set(f, "missing");
      continue;
    }
    try {
      const p = join(dir, f);
      const st = lstatSync(p);
      const hash = (data: string | Uint8Array) => new Bun.CryptoHasher("sha1").update(data).digest("hex");
      out.set(f, st.isSymbolicLink() ? `link:${hash(readlinkSync(p))}` : st.isFile() ? hash(readFileSync(p)) : "other");
    } catch {
      out.set(f, "missing");
    }
  }
  return out;
}

/**
 * Files NightCrew's own setup (dependency install) created or changed, and
 * nobody has touched since. They don't count against the task's scope and
 * aren't committed.
 */
export async function untouchedSetupFiles(dir: string, setup: Map<string, string>): Promise<Set<string>> {
  const now = await fingerprints(dir, [...setup.keys()]);
  return new Set([...setup].filter(([f, hash]) => now.get(f) === hash).map(([f]) => f));
}

/** Lines added and removed between two commits. */
export async function diffStat(
  dir: string,
  base: string,
  head: string,
): Promise<{ additions: number; deletions: number; files: number }> {
  const out = (await git(dir, "diff", "--numstat", "--no-renames", base, head)).stdout;
  let additions = 0;
  let deletions = 0;
  let files = 0;
  for (const line of out.split("\n").filter(Boolean)) {
    const [a, d] = line.split("\t");
    additions += Number(a) || 0;
    deletions += Number(d) || 0;
    files++;
  }
  return { additions, deletions, files };
}

export async function commitsAhead(dir: string, base: string, head = "HEAD"): Promise<number> {
  return Number((await git(dir, "rev-list", "--count", `${base}..${head}`)).stdout.trim()) || 0;
}

/** The commit a ref points at, or null. */
export async function resolveSha(dir: string, ref: string): Promise<string | null> {
  const r = await git(dir, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
  return r.ok ? r.stdout.trim() : null;
}

/**
 * The commit a task branch forked from. Diffs and scope checks use this sha,
 * not the default branch's name, so moving the local default branch can't
 * hide a change. Computed in your repo before any agent runs. `head` is the
 * task's tip, or null for a task that hasn't started.
 */
export async function forkPoint(dir: string, defaultBranch: string, head: string | null = "HEAD"): Promise<string> {
  const tip = head ? await resolveSha(dir, head) : null;
  const local = await resolveSha(dir, `refs/heads/${defaultBranch}`);
  const remote = await resolveSha(dir, `refs/remotes/origin/${defaultBranch}`);
  // A fresh branch sits exactly on the default branch it was made from.
  if (!tip || tip === local) return local ?? remote ?? defaultBranch;
  for (const ref of [`refs/remotes/origin/${defaultBranch}`, `refs/heads/${defaultBranch}`]) {
    const mb = await git(dir, "merge-base", ref, tip);
    if (mb.ok && mb.stdout.trim()) return mb.stdout.trim();
  }
  return local ?? remote ?? defaultBranch;
}

/** Default limits for publishing, so a stalled remote fails the step instead of hanging it. */
export const PUSH_TIMEOUT_MS = 120_000;
export const GH_TIMEOUT_MS = 60_000;

/** Push a commit (by sha) or ref to origin's `branch`, never by a short name git could resolve elsewhere. */
export async function pushTo(
  dir: string,
  src: string,
  branch: string,
  timeoutMs: number = PUSH_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<Exec> {
  return gitRun(dir, ["push", "--quiet", "--no-verify", "origin", `${src}:refs/heads/${branch}`], {
    timeoutMs,
    signal,
  });
}

export interface PrRef {
  url: string;
  number: number;
  /** Set when the PR exists but updating it failed, e.g. `gh pr edit` didn't take the new body. */
  warning?: string;
}

/** A gh failure for messages: the last line, which says "Timed out." or "Stopped." when NightCrew cut it off. */
const ghError = (r: Exec) => lastLine(r.stderr) || `exit ${r.code}`;
const cutOff = (r: Exec) => /^(Timed out|Stopped)\.$/.test(lastLine(r.stderr));

/**
 * Open a draft PR for the branch, or update the body of the one already open.
 * Each gh call gets `timeoutMs` (default GH_TIMEOUT_MS); a timeout or stop
 * throws rather than hang.
 */
export async function openOrUpdatePr(
  dir: string,
  input: { branch: string; base: string; title: string; body: string },
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<PrRef> {
  const gh = (args: string[]) =>
    run(["gh", ...args], dir, { timeoutMs: opts.timeoutMs ?? GH_TIMEOUT_MS, signal: opts.signal });
  const existing = await gh(["pr", "list", "--head", input.branch, "--state", "open", "--json", "url,number"]);
  if (cutOff(existing)) throw new Error(`gh pr list failed: ${ghError(existing)}`);
  let list: PrRef[] = [];
  try {
    list = existing.ok ? (JSON.parse(existing.stdout || "[]") as PrRef[]) : [];
  } catch {}
  const tmp = mkdtempSync(join(tmpdir(), "nightcrew-pr-"));
  const bodyFile = join(tmp, `${slugify(input.branch)}.md`);
  await Bun.write(bodyFile, input.body);
  try {
    const open = list[0];
    if (open) {
      const edit = await gh(["pr", "edit", String(open.number), "--body-file", bodyFile]);
      const pr = { url: open.url, number: open.number };
      return edit.ok ? pr : { ...pr, warning: `gh pr edit failed, so the PR body is out of date: ${ghError(edit)}` };
    }
    const created = await gh([
      "pr",
      "create",
      "--draft",
      "--base",
      input.base,
      "--head",
      input.branch,
      "--title",
      input.title,
      "--body-file",
      bodyFile,
    ]);
    if (!created.ok) throw new Error(`gh pr create failed: ${created.stderr.trim()}`);
    const url = created.stdout.trim().split("\n").pop() ?? "";
    return { url, number: Number(url.split("/").pop()) || 0 };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function absolute(p: string, cwd: string) {
  return isAbsolute(p) ? p : resolve(cwd, p);
}
