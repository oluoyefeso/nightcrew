// Repo commands (setup, tests, previews) and NightCrew's git inside a task's
// clone run in a sandbox: they can write to their own clone or worktree, temp
// dirs and package caches, and nowhere else. They start without NightCrew's
// terminal and get an environment without credentials (see env.ts).

import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { browserProfileDirs } from "@nightcrew/core/guard";
import { cacheDirs, childEnv, dashboardPort } from "./env";
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

/** Where a check runs. A task's clone is decided by NightCrew's records, never by files in the dir. */
export interface CheckPlace {
  /** The dir is a task's clone: the agent owns all of it, `.git` included. */
  clone?: boolean;
  /**
   * The host repo's object dirs a clone borrows from, from NightCrew's records
   * (never the clone's alternates file). bwrap binds them read-only over its
   * private /tmp, so a repo under /tmp still reads.
   */
  objects?: string[];
}

/**
 * Paths a check may not write inside its dir. A task's clone has none. In a
 * worktree NightCrew owns (integration, `_base`), the `.git` pointer file
 * stays put, so the next host git command there can't be aimed at another
 * repo. Its git data outside the dir isn't writable at all.
 */
function denies(dir: string, place: CheckPlace): string[] {
  return place.clone ? [] : [join(dir, ".git")];
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
 * Device files a check may write. Not the rest of /dev, which includes the
 * terminals NightCrew was started from.
 */
const DEVICES = [
  '(literal "/dev/null")',
  '(literal "/dev/zero")',
  '(literal "/dev/random")',
  '(literal "/dev/urandom")',
  '(literal "/dev/dtracehelper")',
  '(subpath "/dev/fd")',
];

/**
 * The macOS Seatbelt profile for a command in `dir`. Seatbelt applies the
 * last matching rule, so the denies come after the allows.
 */
export function seatbeltProfile(dir: string, place: CheckPlace = {}, home = homedir()): string {
  const wt = real(dir);
  const allow = [
    `(subpath ${sbString(wt)})`,
    `(subpath ${sbString(real(tmpdir()))})`,
    '(subpath "/private/tmp")',
    '(subpath "/private/var/folders")',
    ...DEVICES,
    ...cacheDirs(home).map((d) => `(subpath ${sbString(real(d))})`),
  ];
  const deny = denies(wt, place).map((p) => `(literal ${sbString(p)})`);
  const launchers = [...new Set(LAUNCHERS.flatMap((p) => [p, real(p)]))];
  const port = dashboardPort();
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write*\n  ${allow.join("\n  ")})`,
    ...(deny.length ? [`(deny file-write*\n  ${deny.join("\n  ")})`] : []),
    `(deny process-exec\n  ${launchers.map((p) => `(literal ${sbString(p)})`).join("\n  ")})`,
    `(deny mach-lookup\n  ${LAUNCH_SERVICES.join("\n  ")})`,
    // No typing into a terminal through an inherited descriptor (TIOCSTI).
    '(deny file-ioctl (literal "/dev/tty") (regex #"^/dev/ttys"))',
    // No opening another terminal to read what's typed there, or a new pty.
    '(deny file-read* (literal "/dev/tty") (regex #"^/dev/ttys[0-9]+$") (literal "/dev/ptmx"))',
    // The dashboard token lives in the browser's localStorage, on disk here.
    `(deny file-read*\n  ${browserProfileDirs(home)
      .map((d) => `(subpath ${sbString(real(d))})`)
      .join("\n  ")})`,
    // The dashboard API. Seatbelt's "localhost" covers 127.0.0.1 and ::1; it
    // takes no other host name or address.
    ...(port ? [`(deny network-outbound (remote ip "localhost:${port}"))`] : []),
  ].join("\n");
}

/**
 * The bubblewrap arguments for a command in `dir`. A new session (no
 * TIOCSTI into the caller's terminal), its own pid namespace, and it dies
 * with NightCrew. Network stays on, the dashboard API's port included: bwrap
 * can't filter one port without a network namespace. A repo or clone under
 * /tmp is hidden by the private /tmp; NightCrew keeps clones under its data dir.
 */
export function bwrapArgs(dir: string, place: CheckPlace = {}, home = homedir()): string[] {
  const wt = real(dir);
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
  args.push("--bind", wt, wt);
  for (const d of cacheDirs(home)) if (existsSync(d)) args.push("--bind", real(d), real(d));
  // After the private /tmp, so a clone of a repo under /tmp reads the objects it borrows.
  if (place.clone) for (const o of place.objects ?? []) if (existsSync(o)) args.push("--ro-bind", real(o), real(o));
  // Browser profiles (the dashboard token's localStorage) read as empty.
  for (const d of browserProfileDirs(home)) if (existsSync(d)) args.push("--tmpfs", real(d));
  // Later mounts win, so the denies go last.
  for (const p of denies(wt, place)) if (existsSync(p)) args.push("--ro-bind", p, p);
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
 * `argv` started in a new session, so it has no controlling terminal and
 * can't open /dev/tty. macOS has no setsid binary; perl ships with it. The
 * exec keeps the pid, so stopping the check still works. Without perl or
 * python3 the argv runs as is, and Seatbelt's ioctl deny still applies.
 */
function newSession(argv: string[]): string[] {
  const perl = existsSync("/usr/bin/perl") ? "/usr/bin/perl" : onPath("perl");
  // Either fails the check if setsid() fails, rather than run it with the terminal.
  if (perl)
    return [
      perl,
      "-e",
      'use POSIX qw(setsid); setsid() >= 0 or die "setsid: $!"; exec { $ARGV[0] } @ARGV or die "exec: $!"',
      "--",
      ...argv,
    ];
  const python = onPath("python3");
  // os.setsid() raises on failure.
  if (python) return [python, "-c", "import os,sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])", ...argv];
  return argv;
}

/**
 * The argv that runs shell command `cmd` sandboxed to `dir`. With no
 * sandbox available, `warn` hears about it once per process. `place.clone`
 * comes from NightCrew's records for a task's clone.
 */
export function sandboxed(cmd: string, dir: string, warn?: (text: string) => void, place: CheckPlace = {}): string[] {
  const plain = ["sh", "-c", cmd];
  if (process.env[UNSANDBOXED_ENV] === "1") return plain;
  const k = sandboxKind();
  if (k === "seatbelt") return ["/usr/bin/sandbox-exec", "-p", seatbeltProfile(dir, place), "--", ...newSession(plain)];
  if (k === "bwrap") {
    // bwrap can only bind what exists. Made here, a first install fills the
    // real cache instead of failing on a read-only one.
    for (const d of cacheDirs()) {
      try {
        mkdirSync(d, { recursive: true });
      } catch {}
    }
    return ["bwrap", ...bwrapArgs(dir, place), "--", ...plain];
  }
  if (warn && !warned) {
    warned = true;
    warn(NO_SANDBOX_WARNING);
  }
  return newSession(plain);
}

/** Run a repo command (setup, tests, git in a clone) in its dir, sandboxed and without credentials. */
export function runCheck(
  cmd: string,
  dir: string,
  opts: {
    timeoutMs?: number;
    signal?: AbortSignal;
    env?: Record<string, string>;
    warn?: (text: string) => void;
    /** `dir` is a task's clone (from NightCrew's records). */
    clone?: boolean;
    /** The host repo's object dirs the clone borrows (from NightCrew's records). */
    objects?: string[];
  } = {},
): Promise<Exec> {
  return run(sandboxed(cmd, dir, opts.warn, { clone: opts.clone, objects: opts.objects }), dir, {
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    baseEnv: checkEnv(opts.env),
  });
}
