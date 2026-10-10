// The guardrail every tool call passes through while the crew works unattended.
// Pure: given a tool call and the task's limits, allow it or say why not.

import { realpathSync } from "node:fs";
import { isAbsolute, normalize, relative, resolve } from "node:path";

export interface GuardContext {
  /** The task's worktree. Writes outside it are refused. */
  worktree: string;
  /** Extra directories the agent may write to (NightCrew's artifact folder). */
  writableDirs: string[];
  /** Globs relative to the worktree. Empty means anything in the worktree. */
  scope: string[];
  protectedBranches: string[];
  /** Research tasks read and write reports only. */
  readOnly: boolean;
}

export type GuardDecision = { allow: true } | { allow: false; reason: string };

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Paths no task may touch, whatever its scope says. */
export const ALWAYS_PROTECTED = [
  ".github/workflows/**",
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  ".git",
  ".git/**",
  "**/.git",
  "**/*.pem",
  "**/id_rsa*",
];

/** Secret file names: .env, .env.local, key.pem, id_rsa. Not .envrc, environment or a template like .env.example. */
const SECRET_NAMES = [".env", ".env.*", "*.pem", "id_rsa*"];
const ENV_TEMPLATE = /^\.env\.(example|sample|template|dist)$/;
const SECRET_WORD =
  /(^|[\s/=<>:;&|(`])(\.env(?!\.(example|sample|template|dist)(?=$|[\s;&|)<>`]))(\.[\w.-]+)?|[\w.-]*\.pem|id_rsa[\w.-]*)(?=$|[\s;&|)<>`])/;

// Git global options (-C dir, -c k=v, --git-dir x, --no-pager) may sit before the subcommand.
const GIT_OPT = String.raw`(?:-[cC]\s+\S+|--(?:git-dir|work-tree|namespace|config-env)\s+\S+|-[\w-]+(?:=\S+)?)`;
const git = (sub: string) => new RegExp(String.raw`\bgit(?:\s+${GIT_OPT})*\s+(?:${sub})`);

const BASH_RULES: { test: RegExp; reason: string }[] = [
  { test: git(String.raw`push\b`), reason: "NightCrew pushes the branch itself after checks pass." },
  {
    test: git(String.raw`reset\b[^;&|]*--hard|clean\b[^;&|]*(\s-[a-zA-Z]*f|--force)`),
    reason: "Destructive git commands are blocked.",
  },
  { test: git(String.raw`(remote|config)\b`), reason: "Changing git remotes or config is blocked." },
  { test: git(String.raw`rebase\b`), reason: "Rewriting history is blocked." },
  {
    test: git(String.raw`branch\b[^;&|]*\s(-[a-zA-Z]*[dD](?=\s|$)|--delete)|tag\b`),
    reason: "Deleting branches and tagging are blocked.",
  },
  { test: /\bgh\s+(pr|release|repo|api|secret|workflow)\b/, reason: "NightCrew opens the pull request itself." },
  {
    test: /\b(npm|pnpm|yarn|bun)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/,
    reason: "Publishing packages is blocked.",
  },
  { test: /\bsudo\b|\bsu\s+-/, reason: "Elevated privileges are blocked." },
  {
    test: /\b(curl|wget|http)\b[^|]*\s(-X\s*(POST|PUT|PATCH|DELETE)|--data|-d\s|--upload-file|-T\s)/i,
    reason: "Network writes are blocked. Read-only requests are fine.",
  },
  { test: /\b(npm|pnpm|yarn|bun)\s+(i|install|add)\s+(-g|--global)\b/, reason: "Global installs are blocked." },
  {
    test: /\b(brew|apt(-get)?|yum|dnf|pacman)\s+(install|remove|upgrade)\b/,
    reason: "System package changes are blocked.",
  },
  { test: /\b(shutdown|reboot|mkfs|dd\s+if=)/, reason: "System commands are blocked." },
  { test: SECRET_WORD, reason: "Reading secrets files is blocked." },
];

export function guardToolCall(tool: string, input: Record<string, unknown>, ctx: GuardContext): GuardDecision {
  if (WRITE_TOOLS.has(tool)) {
    const path = String(input.file_path ?? input.notebook_path ?? "");
    return guardWrite(path, ctx);
  }

  if (tool === "Bash") {
    // Quotes and backslashes only hide words from the rules: gi''t push, "git" push, g\it push.
    const cmd = String(input.command ?? "").replace(/["'\\]/g, "");
    for (const rule of BASH_RULES) if (rule.test.test(cmd)) return deny(rule.reason);
    for (const words of segments(cmd)) {
      const branch = protectedBranchIn(words, ctx.protectedBranches);
      if (branch) return deny(`Branch "${branch}" is protected. Stay on the task branch.`);
      if (deletesOutside(words, ctx)) return deny("Deleting outside the worktree is blocked.");
    }
    if (
      ctx.readOnly &&
      (/(^|[;&|]\s*)(rm|mv|cp|touch|mkdir|tee|sed\s+-i)\b|>\s*[^&\s]/.test(cmd) ||
        git(String.raw`(add|commit|mv|rm)\b`).test(cmd))
    ) {
      return deny("Research tasks don't change files. Write findings to the report instead.");
    }
    return { allow: true };
  }

  if (tool === "Read") {
    const path = String(input.file_path ?? "");
    const abs = isAbsolute(path) ? path : resolve(ctx.worktree, path);
    if (isSecret(path) || isSecret(realPath(abs))) return deny("Reading secrets files is blocked.");
  }

  if (tool === "Grep" || tool === "Glob") {
    const targets = [input.path, input.glob, tool === "Glob" ? input.pattern : undefined];
    if (targets.some((t) => typeof t === "string" && isSecret(t))) return deny("Reading secrets files is blocked.");
  }

  return { allow: true };
}

/** A path or glob whose last part names a secret file (.env*, *.pem, id_rsa*). */
function isSecret(target: string): boolean {
  const last = baseName(target.replace(/\/+$/, ""));
  if (ENV_TEMPLATE.test(last)) return false;
  if (matchesAny(last, SECRET_NAMES)) return true;
  // A glob like **/.env* or *.{pem,key}: does it reach a secret name?
  if (!/[*?{]/.test(last) || !/\.env|pem|id_rsa/.test(last)) return false;
  const re = globToRegExp(last);
  return [".env", ".env.local", "key.pem", "id_rsa"].some((name) => re.test(name));
}

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Split a command into simple commands, each a list of words. */
function segments(cmd: string): string[][] {
  return cmd
    .split(/\$\(|[;&|\n()`]+/)
    .map((s) => s.trim().split(/\s+/).filter(Boolean))
    .filter((w) => w.length);
}

const isCmd = (word: string, name: string) => word === name || word.endsWith(`/${name}`);
const GIT_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
const CREATE_OPTS = new Set(["-b", "-B", "-c", "-C", "--create", "--force-create", "--orphan"]);

/** The protected branch a checkout, switch, branch -f/-m or update-ref would land on, if any. */
function protectedBranchIn(words: string[], protectedBranches: string[]): string | undefined {
  let i = words.findIndex((w) => isCmd(w, "git"));
  if (i < 0) return undefined;
  for (i++; i < words.length && (words[i] as string).startsWith("-"); i++) {
    if (GIT_VALUE_OPTS.has(words[i] as string)) i++;
  }
  const sub = words[i];
  const args = words.slice(i + 1);
  const isProtected = (w: string) => protectedBranches.includes(w.replace(/^(refs\/)?heads\//, ""));

  if (sub === "checkout" || sub === "switch") {
    // Creating a branch: only the new name matters, the start point may be main.
    const create = args.findIndex((a) => CREATE_OPTS.has(a));
    if (create >= 0) return [args[create + 1] ?? ""].find(isProtected);
    // --track origin/main makes and checks out a local main.
    const track = args.some((a) => a === "-t" || a.startsWith("--track"));
    return args
      .filter((a) => !a.startsWith("-"))
      .map((a) => (track ? a.replace(/^[^/]+\//, "") : a))
      .find(isProtected);
  }
  if (sub === "branch") {
    const forced = args.some((a) => /^-[a-zA-Z]*[fmMcC]/.test(a) || ["--force", "--move", "--copy"].includes(a));
    return forced ? args.filter((a) => !a.startsWith("-")).find(isProtected) : undefined;
  }
  if (sub === "update-ref" || sub === "symbolic-ref") {
    return args.filter((a) => a.startsWith("refs/heads/")).find(isProtected);
  }
  return undefined;
}

/** rm -r aimed at /, ~, $HOME or .. (absolute paths inside the worktree are fine). */
function deletesOutside(words: string[], ctx: GuardContext): boolean {
  const i = words.findIndex((w) => isCmd(w, "rm"));
  if (i < 0) return false;
  const args = words.slice(i + 1);
  const end = args.indexOf("--");
  const flags = (end < 0 ? args : args.slice(0, end)).filter((a) => a.startsWith("-"));
  if (!flags.some((f) => /^-[a-zA-Z]*[rR]/.test(f) || f === "--recursive")) return false;
  const targets = args.filter((a, n) => (end >= 0 && n > end) || !a.startsWith("-"));
  return targets.some((t) => {
    if (/^(~|\$HOME|\$\{HOME\})/.test(t) || t === ".." || t.startsWith("../") || t.includes("/../")) return true;
    if (!t.startsWith("/")) return false;
    const abs = normalize(t);
    return ![ctx.worktree, ...ctx.writableDirs].some((d) => isInside(abs, d) && abs !== normalize(d));
  });
}

function guardWrite(path: string, ctx: GuardContext): GuardDecision {
  if (!path) return deny("A write needs a file path.");
  const abs = isAbsolute(path) ? normalize(path) : resolve(ctx.worktree, path);

  for (const dir of ctx.writableDirs) {
    if (isInside(abs, dir)) return { allow: true };
  }
  if (!isInside(abs, ctx.worktree)) return deny("Writes must stay inside the task's worktree.");
  if (ctx.readOnly) return deny("Research tasks don't change the code. Write the report to the artifacts folder.");

  const rel = relative(ctx.worktree, abs);
  if (matchesAny(rel, ALWAYS_PROTECTED)) return deny(`${rel} is protected (workflows, secrets and git internals).`);
  if (ctx.scope.length && !matchesAny(rel, ctx.scope)) {
    return deny(`${rel} is outside this task's scope (${ctx.scope.join(", ")}).`);
  }
  return { allow: true };
}

function deny(reason: string): GuardDecision {
  return { allow: false, reason };
}

function isInside(path: string, dir: string): boolean {
  const rel = relative(normalize(dir), path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function baseName(p: string): string {
  return p.split("/").pop() ?? p;
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

const cache = new Map<string, RegExp>();

/** Glob → RegExp supporting **, *, ? and {a,b}. Paths use forward slashes. */
export function globToRegExp(input: string): RegExp {
  const glob = input.replace(/^\.\//, "").replace(/\/+$/, "");
  const hit = cache.get(glob);
  if (hit) return hit;
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end > i) {
        re += `(?:${glob
          .slice(i + 1, end)
          .split(",")
          .map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&"))
          .join("|")})`;
        i = end;
      } else re += "\\{";
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  // A bare directory ("src/auth" or "src/auth/") covers everything under it.
  const dirLike = !/[*?{]/.test(glob) && !/\.[^/]+$/.test(glob);
  const out = new RegExp(`^${re}${dirLike ? "(?:/.*)?" : ""}$`);
  cache.set(glob, out);
  return out;
}
