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
    const timer = opts.timeoutMs ? setTimeout(() => proc.kill(), opts.timeoutMs) : undefined;
    let stopped = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      stopped = true;
      proc.kill("SIGTERM");
      forceKill = setTimeout(() => proc.kill("SIGKILL"), KILL_GRACE_MS);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    clearTimeout(timer);
    clearTimeout(forceKill);
    opts.signal?.removeEventListener("abort", onAbort);
    // A stopped command's children can hold its pipes open; don't wait on them.
    const [stdout, stderr] = stopped
      ? await Promise.race([output, Bun.sleep(1000).then(() => ["", ""] as const)])
      : await output;
    if (stopped) return { ok: false, code: code ?? -1, stdout, stderr: `${stderr}\nStopped.`.trim() };
    return { ok: code === 0, code, stdout, stderr };
  } catch (e) {
    return { ok: false, code: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Flags on every git command NightCrew runs: no hooks (a repo's own
 * core.hooksPath, like husky's, would otherwise run planted scripts during
 * NightCrew's commits, merges and pushes) and no fsmonitor daemon. `-c`
 * reaches child git processes too (submodules, a local receive-pack).
 */
export const GIT_HARDEN = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
/** And its environment: replace refs never swap objects, and nothing prompts. */
export const GIT_ENV: Record<string, string> = { GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0" };

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
 * parallel agents never race on .git/worktrees or an integration branch.
 */
export function withRepoLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(repoPath) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  repoLocks.set(
    repoPath,
    next.catch(() => {}),
  );
  return next;
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

/** Push a commit (by sha) or ref to origin's `branch`, never by a short name git could resolve elsewhere. */
export async function pushTo(dir: string, src: string, branch: string, timeoutMs?: number): Promise<Exec> {
  return gitRun(dir, ["push", "--quiet", "--no-verify", "origin", `${src}:refs/heads/${branch}`], { timeoutMs });
}

export interface PrRef {
  url: string;
  number: number;
}

/** Open a draft PR for the branch, or update the body of the one already open. */
export async function openOrUpdatePr(
  dir: string,
  input: { branch: string; base: string; title: string; body: string },
): Promise<PrRef> {
  const existing = await run(
    ["gh", "pr", "list", "--head", input.branch, "--state", "open", "--json", "url,number"],
    dir,
  );
  const list = existing.ok ? (JSON.parse(existing.stdout || "[]") as PrRef[]) : [];
  const tmp = mkdtempSync(join(tmpdir(), "nightcrew-pr-"));
  const bodyFile = join(tmp, `${slugify(input.branch)}.md`);
  await Bun.write(bodyFile, input.body);
  try {
    if (list[0]) {
      await run(["gh", "pr", "edit", String(list[0].number), "--body-file", bodyFile], dir);
      return list[0];
    }
    const created = await run(
      [
        "gh",
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
      ],
      dir,
    );
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
