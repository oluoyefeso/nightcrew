import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { slugify } from "@nightcrew/core";

export interface Exec {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export async function run(
  cmd: string[],
  cwd: string,
  opts: { timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<Exec> {
  try {
    const proc = Bun.spawn(cmd, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...opts.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const timer = opts.timeoutMs ? setTimeout(() => proc.kill(), opts.timeoutMs) : undefined;
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    return { ok: code === 0, code, stdout, stderr };
  } catch (e) {
    return { ok: false, code: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}

export const git = (cwd: string, ...args: string[]) => run(["git", ...args], cwd);

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
            : "npm install";
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

/**
 * Create (or reuse) the worktree for a task branch under <repo>/.worktrees.
 * A branch that already exists, from a sent-back task, is checked out as-is
 * so the crew continues where it left off.
 */
export async function ensureWorktree(repoPath: string, branch: string, base: string): Promise<string> {
  const dir = join(repoPath, ".worktrees", slugify(branch.replace(/\//g, "-"), 64));
  excludeWorktrees(repoPath);
  if (existsSync(join(dir, ".git"))) {
    const current = (await git(dir, "branch", "--show-current")).stdout.trim();
    if (current === branch) return dir;
    throw new Error(`Worktree ${dir} is on ${current || "a detached HEAD"}, not ${branch}.`);
  }
  mkdirSync(join(repoPath, ".worktrees"), { recursive: true });
  await git(repoPath, "worktree", "prune");
  const exists = (await git(repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)).ok;
  const add = exists
    ? await git(repoPath, "worktree", "add", dir, branch)
    : await git(repoPath, "worktree", "add", "-b", branch, dir, base);
  if (!add.ok) throw new Error(`Couldn't create a worktree for ${branch}: ${add.stderr.trim()}`);
  return dir;
}

/** A throwaway checkout of the base branch, for before-screenshots and fail-then-pass. */
export async function baseWorktree(
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
    remove: async () => {
      await git(repoPath, "worktree", "remove", "--force", dir);
    },
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

export async function currentBranch(dir: string): Promise<string> {
  return (await git(dir, "branch", "--show-current")).stdout.trim();
}

/** Every file the task changed: committed on the branch, staged, unstaged or new. */
export async function changedFiles(dir: string, base: string): Promise<string[]> {
  const committed = (await git(dir, "diff", "--name-only", `${base}...HEAD`)).stdout;
  const working = (await git(dir, "status", "--porcelain", "--untracked-files=all")).stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const p = l.slice(3);
      return p.includes(" -> ") ? (p.split(" -> ")[1] ?? p) : p;
    });
  return [...new Set([...committed.split("\n").filter(Boolean), ...working.map(unquote)])].sort();
}

function unquote(p: string) {
  return p.startsWith('"') && p.endsWith('"') ? JSON.parse(p) : p;
}

export async function diffStat(
  dir: string,
  base: string,
): Promise<{ additions: number; deletions: number; files: number }> {
  const out = (await git(dir, "diff", "--numstat", base)).stdout;
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

export async function commitAll(dir: string, message: string): Promise<boolean> {
  await git(dir, "add", "-A");
  const staged = await git(dir, "diff", "--cached", "--quiet");
  if (staged.ok) return false; // nothing to commit
  const c = await git(
    dir,
    "-c",
    "user.name=NightCrew",
    "-c",
    "user.email=crew@nightcrew.dev",
    "commit",
    "-m",
    message,
    "--no-verify",
  );
  if (!c.ok) throw new Error(`git commit failed: ${c.stderr.trim()}`);
  return true;
}

export async function commitsAhead(dir: string, base: string): Promise<number> {
  return Number((await git(dir, "rev-list", "--count", `${base}..HEAD`)).stdout.trim()) || 0;
}

export async function push(dir: string, branch: string): Promise<Exec> {
  return git(dir, "push", "-u", "origin", branch);
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
  const bodyFile = join(dir, "..", `.pr-body-${slugify(input.branch)}.md`);
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
    await Bun.file(bodyFile)
      .delete()
      .catch(() => {});
  }
}

export function absolute(p: string, cwd: string) {
  return isAbsolute(p) ? p : resolve(cwd, p);
}
