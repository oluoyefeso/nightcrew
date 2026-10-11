// One environment policy for everything NightCrew starts outside itself: the
// agent's process (sdk-engine) and the repo's own commands (sandbox). Both get
// this process's environment minus credentials, plus git config that blocks
// pushes and credential helpers.

import { homedir } from "node:os";
import { join } from "node:path";

/** Credentials by name, for the ones the pattern below doesn't catch. */
const SECRET_NAMES = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AZURE_CLIENT_SECRET",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "SSH_AUTH_SOCK",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "SUDO_ASKPASS",
]);

/**
 * Names that carry a secret. `_AUTH` only as a whole word, so NPM_CONFIG__AUTH
 * and SSH_AUTH_SOCK go and GIT_AUTHOR_NAME stays. `_KEY`, `_DSN`, `_PAT` and
 * `_PWD` only at the end (MYSQL_PWD goes, PWD and OLDPWD stay). Connection
 * URLs for databases and queues carry their password. Prefixes like AWS_
 * aren't stripped wholesale: AWS_REGION and AWS_PROFILE are config.
 */
const SECRET_PATTERNS = [
  /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIAL|WEBHOOK|CONNECTION_STRING|_AUTH(_|$)/i,
  /_(KEY|DSN|PAT|PWD)$/i,
  /(^|_)(DATABASE|DB|REDIS|MONGO|MONGODB|AMQP|POSTGRES|POSTGRESQL|MYSQL|RABBITMQ)_UR[LI]$/i,
];

/** Config names a pattern above would catch. Kept on purpose. */
const CONFIG_NAMES = new Set([
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_PROFILE",
  "AWS_ENDPOINT_URL",
  "TOKENIZERS_PARALLELISM",
]);

/**
 * Git variables that point at a repo. Inherited from a hook or a shell, they
 * would aim the child's git at some other repo than its own cwd.
 */
const GIT_LOCATION = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
]);

/** The agent signs in with these; repo commands have no use for them. */
const SIGN_IN_PREFIXES = ["ANTHROPIC_", "CLAUDE_"];

export function isSecretVar(name: string): boolean {
  const upper = name.toUpperCase();
  if (CONFIG_NAMES.has(upper)) return false;
  return SECRET_NAMES.has(upper) || SECRET_PATTERNS.some((p) => p.test(name));
}

/** Prefixes of real remote URLs. Pushes to them are rewritten to a scheme git can't speak. */
const PUSH_PREFIXES = ["https://", "http://", "ssh://", "git://", "git@"];

/**
 * Git config every child gets, through GIT_CONFIG_* so it outranks the
 * system, global and repo files:
 * - pushes to any real URL go to an address git can't reach. pushInsteadOf
 *   matches URL prefixes, which misses scp-style aliases like `gh:acme/x`, so
 *   origin also gets a blocked push URL;
 * - an empty `credential.helper` clears every helper configured before it
 *   (osxkeychain, `gh auth git-credential`), so none can hand out a token;
 * - an empty `core.askPass` stops a GUI prompt from asking for one.
 */
export const GIT_BLOCK: readonly [string, string][] = [
  ...PUSH_PREFIXES.map((prefix): [string, string] => ["url.nightcrew-blocked://.pushInsteadOf", prefix]),
  ["remote.origin.pushurl", "nightcrew-blocked://blocked"],
  ["credential.helper", ""],
  ["core.askPass", ""],
];

/**
 * The environment for a child NightCrew starts: `base` minus credentials and
 * git location variables, plus the git block. `agent` keeps ANTHROPIC_* and
 * CLAUDE_* so the Claude process can sign in; repo commands lose them.
 */
export function childEnv(base: NodeJS.ProcessEnv, opts: { agent: boolean }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || GIT_LOCATION.has(k)) continue;
    const signIn = SIGN_IN_PREFIXES.some((p) => k.startsWith(p));
    if (signIn ? !opts.agent : isSecretVar(k)) continue;
    env[k] = v;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  // Append after any GIT_CONFIG_* entries already set, rather than clobber them.
  const start = Number.parseInt(base.GIT_CONFIG_COUNT ?? "0", 10) || 0;
  GIT_BLOCK.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${start + i}`] = key;
    env[`GIT_CONFIG_VALUE_${start + i}`] = value;
  });
  env.GIT_CONFIG_COUNT = String(start + GIT_BLOCK.length);
  return env;
}

/** Package manager caches, relative to home. Installs inside either sandbox may write them. */
const CACHE_DIRS = [
  ".npm",
  ".bun/install/cache",
  ".cache",
  ".pnpm-store",
  "Library/pnpm",
  ".yarn",
  "Library/Caches",
  ".cargo/registry",
  ".cargo/git",
  "go/pkg/mod",
  ".local/share/uv",
];

export function cacheDirs(home = homedir()): string[] {
  return CACHE_DIRS.map((d) => join(home, d));
}

/** The dashboard API's port, from NIGHTCREW_API_PORT. Sandboxes block it on loopback. */
export function dashboardPort(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const port = Number(env.NIGHTCREW_API_PORT);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}
