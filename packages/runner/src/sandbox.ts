// Repo commands (setup, tests, previews) run inside a sandbox: they can write
// to their own worktree, temp dirs and package caches, and nowhere else. They
// also get an environment without NightCrew's tokens. NightCrew's own git
// commands don't go through here.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { type Exec, run } from "./git";

/** Set to 1 to run checks without a sandbox, for test suites that need it. */
export const UNSANDBOXED_ENV = "NIGHTCREW_UNSANDBOXED_CHECKS";

const SECRET_VARS = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_PAT",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "TYPESAFE_API_KEY",
]);
const SECRET_PREFIXES = ["AWS_", "AZURE_", "SLACK_"];

/** The environment a repo command gets: NightCrew's own, minus credentials. */
export function checkEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || SECRET_VARS.has(k) || SECRET_PREFIXES.some((p) => k.startsWith(p))) continue;
    env[k] = v;
  }
  return { ...env, ...extra, GIT_TERMINAL_PROMPT: "0" };
}

/** Package manager caches a setup or test command may fill. */
function cacheDirs(): string[] {
  const home = homedir();
  return [
    ".npm",
    ".bun/install/cache",
    ".cache",
    ".pnpm-store",
    ".yarn",
    "Library/Caches",
    "Library/pnpm",
    ".cargo/registry",
    ".cargo/git",
    "go/pkg/mod",
  ].map((d) => join(home, d));
}

/** The real path, following symlinks as far as the path exists (macOS /var is /private/var). */
function real(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    return parent === abs ? abs : join(real(parent), basename(abs));
  }
}

/** The worktree's .git pointer file and the repo's shared git dir, if it's a linked worktree. */
function gitPaths(worktree: string): { pointer: string | null; common: string | null } {
  const pointer = join(worktree, ".git");
  try {
    const text = readFileSync(pointer, "utf8");
    const m = text.match(/^gitdir:\s*(.+)$/m);
    if (!m?.[1]) return { pointer, common: null };
    const gitdir = resolve(worktree, m[1].trim());
    let common = gitdir;
    const commondir = join(gitdir, "commondir");
    if (existsSync(commondir)) common = resolve(gitdir, readFileSync(commondir, "utf8").trim());
    return { pointer, common: real(common) };
  } catch {
    // A plain checkout: .git is the repo's own folder.
    return existsSync(pointer) ? { pointer: null, common: real(pointer) } : { pointer: null, common: null };
  }
}

/** A path as a Seatbelt string literal. */
function sbString(p: string): string {
  return `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The macOS Seatbelt profile for a command in `worktree`. Seatbelt applies the
 * last matching rule, so the git denies come after the allows.
 */
export function seatbeltProfile(worktree: string): string {
  const wt = real(worktree);
  const allow = [
    `(subpath ${sbString(wt)})`,
    `(subpath ${sbString(real(tmpdir()))})`,
    '(subpath "/private/tmp")',
    '(subpath "/private/var/folders")',
    '(literal "/dev/null")',
    '(subpath "/dev")',
    ...cacheDirs().map((d) => `(subpath ${sbString(real(d))})`),
  ];
  const git = gitPaths(wt);
  const deny = [
    ...(git.pointer ? [`(literal ${sbString(git.pointer)})`] : []),
    ...(git.common
      ? [`(subpath ${sbString(join(git.common, "hooks"))})`, `(literal ${sbString(join(git.common, "config"))})`]
      : []),
  ];
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write*\n  ${allow.join("\n  ")})`,
    ...(deny.length ? [`(deny file-write*\n  ${deny.join("\n  ")})`] : []),
  ].join("\n");
}

/** The bubblewrap arguments for a command in `worktree` (network stays on). */
export function bwrapArgs(worktree: string): string[] {
  const wt = real(worktree);
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
  const tmp = real(tmpdir());
  if (tmp !== "/tmp" && existsSync(tmp)) args.push("--bind", tmp, tmp);
  const git = gitPaths(wt);
  // The shared git dir stays readable even when the repo lives under /tmp.
  if (git.common && existsSync(git.common)) args.push("--ro-bind", git.common, git.common);
  args.push("--bind", wt, wt);
  for (const d of cacheDirs()) if (existsSync(d)) args.push("--bind", real(d), real(d));
  if (git.pointer && existsSync(git.pointer)) args.push("--ro-bind", git.pointer, git.pointer);
  return [...args, "--die-with-parent", "--chdir", wt];
}

type Kind = "seatbelt" | "bwrap" | "none";
let kind: Kind | undefined;
let warned = false;

function onPath(bin: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const p = join(dir, bin);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Which sandbox this machine has, checked once with a real run. */
function sandboxKind(): Kind {
  if (kind) return kind;
  const works = (cmd: string[]) => {
    try {
      return Bun.spawnSync(cmd, { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
    } catch {
      return false;
    }
  };
  if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec"))
    kind = works(["/usr/bin/sandbox-exec", "-p", "(version 1)(allow default)", "--", "/usr/bin/true"])
      ? "seatbelt"
      : "none";
  else if (process.platform === "linux" && onPath("bwrap"))
    kind = works(["bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--", "true"]) ? "bwrap" : "none";
  else kind = "none";
  return kind;
}

export const NO_SANDBOX_WARNING =
  process.platform === "linux"
    ? "Checks run without a sandbox: install bubblewrap"
    : "Checks run without a sandbox on this machine";

/**
 * The argv that runs shell command `cmd` sandboxed to `worktree`. With no
 * sandbox available, `warn` hears about it once per process.
 */
export function sandboxed(cmd: string, worktree: string, warn?: (text: string) => void): string[] {
  const plain = ["sh", "-c", cmd];
  if (process.env[UNSANDBOXED_ENV] === "1") return plain;
  const k = sandboxKind();
  if (k === "seatbelt") return ["/usr/bin/sandbox-exec", "-p", seatbeltProfile(worktree), "--", ...plain];
  if (k === "bwrap") return ["bwrap", ...bwrapArgs(worktree), "--", ...plain];
  if (warn && !warned) {
    warned = true;
    warn(NO_SANDBOX_WARNING);
  }
  return plain;
}

/** Run a repo command (setup, tests) in its worktree, sandboxed and without NightCrew's tokens. */
export function runCheck(
  cmd: string,
  worktree: string,
  opts: { timeoutMs?: number; signal?: AbortSignal; env?: Record<string, string>; warn?: (text: string) => void } = {},
): Promise<Exec> {
  return run(sandboxed(cmd, worktree, opts.warn), worktree, {
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    baseEnv: checkEnv(opts.env),
  });
}
