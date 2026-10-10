// Repo commands (setup, tests, previews) and NightCrew's git inside a task's
// clone run in a sandbox: they can write to their own clone or worktree, temp
// dirs and package caches, and nowhere else. They also get an environment
// without credentials (see env.ts).

import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { cacheDirs, childEnv } from "./env";
import { type Exec, run } from "./git";

/** Set to 1 to run checks without a sandbox, for test suites that need it. */
export const UNSANDBOXED_ENV = "NIGHTCREW_UNSANDBOXED_CHECKS";

/**
 * The environment a repo command gets: NightCrew's own, minus credentials and
 * the agent's sign-in, plus the git block. `extra` wins, except that its
 * GIT_CONFIG_* entries go before the block instead of over it.
 */
export function checkEnv(extra: Record<string, string> = {}): Record<string, string> {
  const gitConfig: Record<string, string> = {};
  const rest: Record<string, string> = {};
  for (const [k, v] of Object.entries(extra)) (k.startsWith("GIT_CONFIG_") ? gitConfig : rest)[k] = v;
  return { ...childEnv({ ...process.env, ...gitConfig }, { agent: false }), ...rest, GIT_TERMINAL_PROMPT: "0" };
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

interface GitPaths {
  /** The linked worktree's .git pointer file. */
  pointer: string | null;
  /** The linked worktree's own git dir, `<common>/worktrees/<name>`. */
  gitdir: string | null;
  /** The shared git dir of a linked worktree's repo. */
  common: string | null;
  /** Object dirs a clone borrows through alternates (`git clone --shared`). */
  alternates: string[];
}

/**
 * Where a worktree's git data lives. A standalone clone (`.git` is a folder)
 * owns all of it, inside the worktree. A linked worktree (`.git` is a pointer
 * file) shares the repo's git dir with the host.
 */
function gitPaths(worktree: string): GitPaths {
  const dotGit = join(worktree, ".git");
  const none: GitPaths = { pointer: null, gitdir: null, common: null, alternates: [] };
  try {
    if (statSync(dotGit).isDirectory()) {
      let alternates: string[] = [];
      try {
        const objects = join(dotGit, "objects");
        alternates = readFileSync(join(objects, "info", "alternates"), "utf8")
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("#"))
          .map((l) => real(resolve(objects, l)));
      } catch {}
      return { ...none, alternates };
    }
    const m = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)$/m);
    if (!m?.[1]) return { ...none, pointer: dotGit };
    const gitdir = real(resolve(worktree, m[1].trim()));
    const commondir = join(gitdir, "commondir");
    const common = existsSync(commondir) ? real(resolve(gitdir, readFileSync(commondir, "utf8").trim())) : gitdir;
    return { pointer: dotGit, gitdir: common === gitdir ? null : gitdir, common, alternates: [] };
  } catch {
    return none;
  }
}

/**
 * Git paths a check in a linked worktree may write beyond the worktree: its
 * own git dir (index, logs, stash refs), and the repo's lfs and modules dirs.
 * The denies win: the pointer file and the files that tie the worktree to a
 * repo and a branch, plus the shared hooks and config.
 */
function linkedGit(git: GitPaths): { allow: string[]; deny: string[] } {
  if (!git.pointer) return { allow: [], deny: [] };
  const allow: string[] = [];
  const deny = [git.pointer];
  if (git.gitdir) {
    allow.push(git.gitdir);
    deny.push(...["HEAD", "commondir", "gitdir", "config.worktree"].map((f) => join(git.gitdir as string, f)));
  }
  if (git.common) {
    allow.push(join(git.common, "lfs"), join(git.common, "modules"));
    deny.push(join(git.common, "hooks"), join(git.common, "config"));
  }
  return { allow, deny };
}

/** A path as a Seatbelt string literal. */
function sbString(p: string): string {
  return `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Programs that hand work to launchd or another app, which would run it
 * outside the sandbox: a `.command` file opened in Terminal, a job submitted
 * to launchd, an AppleScript `do shell script` in another app.
 */
const LAUNCHERS = ["/bin/launchctl", "/usr/bin/open", "/usr/bin/osascript"];

/**
 * The Mach services those programs, or a test calling the same APIs, talk to.
 * On macOS 26 an app launch through LaunchServices goes through the
 * quarantine resolver; Apple Events let any process script another app.
 */
const LAUNCH_SERVICES = [
  '(global-name "com.apple.coreservices.launchservicesd")',
  '(global-name "com.apple.coreservices.quarantine-resolver")',
  '(global-name "com.apple.coreservices.appleevents")',
  '(global-name-regex #"^com\\.apple\\.lsd\\.")',
];

/**
 * The macOS Seatbelt profile for a command in `worktree`. Seatbelt applies the
 * last matching rule, so the git denies come after the allows.
 */
export function seatbeltProfile(worktree: string): string {
  const wt = real(worktree);
  const git = linkedGit(gitPaths(wt));
  const allow = [
    `(subpath ${sbString(wt)})`,
    ...git.allow.map((p) => `(subpath ${sbString(p)})`),
    `(subpath ${sbString(real(tmpdir()))})`,
    '(subpath "/private/tmp")',
    '(subpath "/private/var/folders")',
    '(literal "/dev/null")',
    '(subpath "/dev")',
    ...cacheDirs().map((d) => `(subpath ${sbString(real(d))})`),
  ];
  const deny = git.deny.map((p) => (p.endsWith("/hooks") ? `(subpath ${sbString(p)})` : `(literal ${sbString(p)})`));
  const launchers = [...new Set(LAUNCHERS.flatMap((p) => [p, real(p)]))];
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write*\n  ${allow.join("\n  ")})`,
    ...(deny.length ? [`(deny file-write*\n  ${deny.join("\n  ")})`] : []),
    `(deny process-exec\n  ${launchers.map((p) => `(literal ${sbString(p)})`).join("\n  ")})`,
    `(deny mach-lookup\n  ${LAUNCH_SERVICES.join("\n  ")})`,
  ].join("\n");
}

/**
 * The bubblewrap arguments for a command in `worktree`. A new session (no
 * TIOCSTI into the caller's terminal), its own pid namespace, and it dies
 * with NightCrew. Network stays on.
 */
export function bwrapArgs(worktree: string): string[] {
  const wt = real(worktree);
  const args = [
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    "--new-session",
    "--die-with-parent",
    "--unshare-pid",
  ];
  const tmp = real(tmpdir());
  if (tmp !== "/tmp" && existsSync(tmp)) args.push("--bind", tmp, tmp);
  const paths = gitPaths(wt);
  // Shared git data stays readable even when the repo lives under /tmp.
  for (const ro of [paths.common, ...paths.alternates])
    if (ro && existsSync(ro) && !ro.startsWith(`${wt}/`)) args.push("--ro-bind", ro, ro);
  const git = linkedGit(paths);
  args.push("--bind", wt, wt);
  for (const p of git.allow) if (existsSync(p)) args.push("--bind", p, p);
  for (const d of cacheDirs()) if (existsSync(d)) args.push("--bind", real(d), real(d));
  // Later mounts win, so the denies go last.
  for (const p of git.deny) if (existsSync(p)) args.push("--ro-bind", p, p);
  return [...args, "--chdir", wt];
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
    kind = works([
      "bwrap",
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--new-session",
      "--unshare-pid",
      "--",
      "true",
    ])
      ? "bwrap"
      : "none";
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
  if (k === "bwrap") {
    // bwrap can only bind what exists. Made here, a first install fills the
    // real cache instead of failing on a read-only one.
    for (const d of cacheDirs()) {
      try {
        mkdirSync(d, { recursive: true });
      } catch {}
    }
    return ["bwrap", ...bwrapArgs(worktree), "--", ...plain];
  }
  if (warn && !warned) {
    warned = true;
    warn(NO_SANDBOX_WARNING);
  }
  return plain;
}

/** Run a repo command (setup, tests, git in a clone) in its worktree, sandboxed and without credentials. */
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
