// The guardrail every tool call passes through while the crew works unattended.
// Pure: given a tool call and the task's limits, allow it or say why not.

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
const ALWAYS_PROTECTED = [
  ".github/workflows/**",
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  ".git/**",
  "**/*.pem",
  "**/id_rsa*",
];

const BASH_RULES: { test: RegExp; reason: string }[] = [
  { test: /\bgit\s+push\b/, reason: "NightCrew pushes the branch itself after checks pass." },
  { test: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/, reason: "Destructive git commands are blocked." },
  { test: /\bgit\s+(remote|config)\b/, reason: "Changing git remotes or config is blocked." },
  { test: /\bgit\s+rebase\b/, reason: "Rewriting history is blocked." },
  { test: /\bgit\s+(branch\s+-[dD]|tag\b)/, reason: "Deleting branches and tagging are blocked." },
  { test: /\bgh\s+(pr|release|repo|api|secret|workflow)\b/, reason: "NightCrew opens the pull request itself." },
  {
    test: /\b(npm|pnpm|yarn|bun)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/,
    reason: "Publishing packages is blocked.",
  },
  { test: /\bsudo\b|\bsu\s+-/, reason: "Elevated privileges are blocked." },
  {
    test: /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(\/|~|\$HOME|\.\.)(\s|$|\/)/,
    reason: "Deleting outside the worktree is blocked.",
  },
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
  {
    test: /(^|[;&|]\s*)(cat|less|head|tail|source|\.)\s+[^\s]*\.env(\.|\s|$)/,
    reason: "Reading secrets files is blocked.",
  },
];

export function guardToolCall(tool: string, input: Record<string, unknown>, ctx: GuardContext): GuardDecision {
  if (WRITE_TOOLS.has(tool)) {
    const path = String(input.file_path ?? input.notebook_path ?? "");
    return guardWrite(path, ctx);
  }

  if (tool === "Bash") {
    const cmd = String(input.command ?? "");
    for (const rule of BASH_RULES) if (rule.test.test(cmd)) return deny(rule.reason);
    const checkout = cmd.match(/\bgit\s+(checkout|switch)\s+(?:-[bBc]\s+)?([^\s;&|]+)/);
    if (checkout?.[2] && ctx.protectedBranches.includes(checkout[2])) {
      return deny(`Branch "${checkout[2]}" is protected. Stay on the task branch.`);
    }
    if (
      ctx.readOnly &&
      /(^|[;&|]\s*)(rm|mv|cp|touch|mkdir|tee|sed\s+-i|git\s+(add|commit|mv|rm))\b|>\s*[^&\s]/.test(cmd)
    ) {
      return deny("Research tasks don't change files. Write findings to the report instead.");
    }
    return { allow: true };
  }

  if (tool === "Read") {
    const path = String(input.file_path ?? "");
    if (matchesAny(baseName(path), [".env", ".env.*"]) || /(^|\/)\.env(\.|$)/.test(path)) {
      return deny("Reading secrets files is blocked.");
    }
  }

  return { allow: true };
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
