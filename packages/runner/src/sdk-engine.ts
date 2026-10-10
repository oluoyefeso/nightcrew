// Runs a phase through the Claude Agent SDK on this machine. Uses
// ANTHROPIC_API_KEY when it's set, otherwise the local Claude Code login.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
  type HookCallback,
  type Options,
  query,
  type SandboxSettings,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type AgentEngine,
  backstopUsd,
  checkGuard,
  describeTool,
  type EngineEvent,
  type PhaseRequest,
  type PhaseResult,
  STOPPED,
  stoppedResult,
} from "./engine";
import { cacheDirs, childEnv } from "./env";

const TOOLS = ["Read", "Write", "Edit", "MultiEdit", "Bash", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite"];

export class SdkEngine implements AgentEngine {
  readonly name = "agent-sdk";
  constructor(private readonly opts: { claudePath?: string } = {}) {}

  async runPhase(req: PhaseRequest, onEvent: (e: EngineEvent) => void): Promise<PhaseResult> {
    // Stopped before it started: don't spend anything.
    if (req.signal.aborted) return stoppedResult();
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    req.signal.addEventListener("abort", onAbort, { once: true });

    // Every tool call goes through the guard, whatever permission rules the
    // repo's own settings contain.
    const guardHook: HookCallback = async (input) => {
      if (input.hook_event_name !== "PreToolUse") return {};
      const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
      const decision = checkGuard(req, input.tool_name, toolInput);
      if (decision.allow) {
        onEvent({
          kind: "tool",
          tool: input.tool_name,
          input: toolInput,
          text: describeTool(input.tool_name, toolInput, req.cwd),
        });
        return {};
      }
      onEvent({
        kind: "denied",
        tool: input.tool_name,
        text: `Blocked ${describeTool(input.tool_name, toolInput, req.cwd)}: ${decision.reason}`,
      });
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: decision.reason,
        },
      };
    };

    const tools =
      req.outputSchema && req.phase === "compose" ? [] : TOOLS.filter((t) => !req.disallowedTools?.includes(t));
    const options: Options = {
      cwd: req.cwd,
      model: req.model,
      abortController: abort,
      tools,
      allowedTools: tools,
      // Unattended: nobody is there to answer a permission prompt. The guard
      // hook above is the boundary.
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      // Isolation: no filesystem settings, MCP servers, skills or plugins from
      // this machine. Each one adds to every turn's context; with a typical
      // setup that measured 48x the cost per turn ($1.05 vs $0.022 for the
      // same five turns), and it keeps the crew's tool surface to what the
      // task needs. The repo's own instructions are passed in explicitly.
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      skills: [],
      plugins: [],
      systemPrompt: { type: "preset", preset: "claude_code", append: withRepoInstructions(req.systemPrompt, req.cwd) },
      maxTurns: req.maxTurns,
      // The token cap below is the real limit; this is only a backstop.
      maxBudgetUsd: backstopUsd(req.maxTokens),
      hooks: { PreToolUse: [{ hooks: [guardHook] }] },
      // Kept so later phases can resume with a warm cache. Compose never resumes.
      persistSession: req.phase !== "compose",
      ...(req.resumeSession ? { resume: req.resumeSession } : {}),
      ...(req.outputSchema ? { outputFormat: { type: "json_schema", schema: req.outputSchema } } : {}),
      ...(this.opts.claudePath ? { pathToClaudeCodeExecutable: this.opts.claudePath } : {}),
      // Bash runs in the OS sandbox: it can only write to the clone, the
      // artifact folder, temp and package caches. Network stays open.
      sandbox: sandboxFor(req),
      // The agent's process (not this one) gets no credentials and can't push.
      env: agentEnv(process.env),
    };

    const result: PhaseResult = {
      ok: false,
      text: "",
      structured: null,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      turns: 0,
      error: null,
      rateLimited: false,
    };

    let gotResult = false;
    let lastText = "";
    // Count tokens per API call as they stream, and stop at the phase's cap.
    // One call can stream as several messages with the same id; keep the
    // largest usage seen for each. The live counts also stand in for the
    // totals when no result arrives.
    const calls = new Map<string, { in: number; out: number }>();
    let liveIn = 0;
    let liveOut = 0;
    let overBudget = false;
    try {
      for await (const msg of query({ prompt: req.prompt, options }) as AsyncIterable<SDKMessage>) {
        if ("session_id" in msg && msg.session_id) result.sessionId = msg.session_id;
        if (msg.type === "assistant") {
          const u = msg.message.usage as
            | {
                input_tokens?: number;
                output_tokens?: number;
                cache_read_input_tokens?: number;
                cache_creation_input_tokens?: number;
              }
            | undefined;
          if (u && msg.message.id) {
            const prev = calls.get(msg.message.id) ?? { in: 0, out: 0 };
            const next = {
              in: Math.max(
                prev.in,
                (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
              ),
              out: Math.max(prev.out, u.output_tokens ?? 0),
            };
            calls.set(msg.message.id, next);
            liveIn += next.in - prev.in;
            liveOut += next.out - prev.out;
            if (liveIn + liveOut > req.maxTokens && !overBudget) {
              overBudget = true;
              abort.abort();
            }
          }
          for (const block of msg.message.content) {
            if (block.type === "text" && block.text.trim()) {
              lastText = block.text.trim();
              onEvent({ kind: "text", text: lastText });
            }
          }
        } else if (msg.type === "result") {
          gotResult = true;
          result.costUsd = msg.total_cost_usd ?? 0;
          result.turns = msg.num_turns ?? 0;
          result.usage = Object.fromEntries(
            Object.entries(msg.modelUsage ?? {}).map(([model, u]) => [
              model,
              {
                input: u.inputTokens,
                output: u.outputTokens,
                thinking: u.thinkingTokens ?? 0,
                cacheRead: u.cacheReadInputTokens,
                cacheWrite: u.cacheCreationInputTokens,
                costUsd: u.costUSD,
              },
            ]),
          );
          const usage = Object.values(msg.modelUsage ?? {});
          result.tokensIn = usage.reduce(
            (n, u) => n + u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens,
            0,
          );
          result.tokensOut = usage.reduce((n, u) => n + u.outputTokens, 0);
          if (msg.subtype === "success" && !msg.is_error) {
            result.ok = true;
            result.text = msg.result;
            result.structured = msg.structured_output ?? null;
          } else {
            const status = "api_error_status" in msg ? msg.api_error_status : null;
            result.rateLimited = status === 429;
            result.error = describeFailure(msg.subtype, status, "result" in msg ? String(msg.result ?? "") : "");
            if ("result" in msg && typeof msg.result === "string") result.text = msg.result;
          }
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      result.ok = false;
      if (overBudget) result.error = "Hit the task's token budget before finishing.";
      else if (req.signal.aborted) result.error = STOPPED;
      else if (/maximum budget/i.test(message)) result.error = "Hit the task's token budget before finishing.";
      else if (/rate.?limit|429/i.test(message)) {
        result.error = "Rate limited by the API (429).";
        result.rateLimited = true;
      } else if (!gotResult) result.error = `The agent crashed: ${message}`;
      else result.error ??= message.slice(0, 240);
    } finally {
      req.signal.removeEventListener("abort", onAbort);
    }
    // The stream can also just end on an abort, without a result or an error.
    if (!gotResult && !result.error)
      result.error = overBudget
        ? "Hit the task's token budget before finishing."
        : req.signal.aborted
          ? STOPPED
          : "The agent stopped without a result.";
    // Stopped, timed out, rate limited or crashed before the result: count
    // what streamed, so the task and daily budgets still see the spend.
    if (result.tokensIn + result.tokensOut < liveIn + liveOut) {
      result.tokensIn = Math.max(result.tokensIn, liveIn);
      result.tokensOut = Math.max(result.tokensOut, liveOut);
    }
    // Whatever it said last is still useful (a plan cut short by the budget).
    if (!result.text && lastText) result.text = lastText;
    return result;
  }
}

/**
 * The agent's environment: this process's, minus credentials (it keeps
 * ANTHROPIC_* and CLAUDE_* to sign in), plus git config that makes any
 * `git push` to a real remote fail and turns off credential helpers. Only the
 * agent's subprocess gets it. The SDK's `env` replaces the child's
 * environment, so the base is copied in. See env.ts for the policy.
 */
export function agentEnv(base: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return childEnv(base, { agent: true });
}

/**
 * OS sandbox for Bash (Seatbelt on macOS, bubblewrap on Linux). The model
 * can't opt out of it. Network is left open: tests and installs need it, and
 * the guard handles network writes. Where the sandbox can't start (Linux
 * without bubblewrap), Bash runs unsandboxed with the guard only.
 *
 * In a task's standalone clone (`.git` is a folder with alternates, as `git
 * clone --shared` makes it) the agent may write all of it, its own `.git`
 * included: nothing there is shared with the host repo, and NightCrew reads
 * results back by commit SHA. Plus the artifact folder, temp and package
 * caches. In a legacy linked worktree or the repo's main checkout, the git
 * denies below still apply.
 */
export function sandboxFor(req: PhaseRequest, home = homedir()): SandboxSettings {
  const git = isClone(req.cwd) ? null : gitWrites(req.cwd, req.guard.protectedBranches);
  const allowWrite = [req.cwd, ...req.guard.writableDirs, tmpdir(), ...(git?.allow ?? []), ...cacheDirs(home)];
  return {
    enabled: true,
    failIfUnavailable: false,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    filesystem: {
      allowWrite: [...new Set(allowWrite)],
      ...(git ? { denyWrite: git.deny } : {}),
    },
    network: { allowedDomains: ["*"], allowLocalBinding: true },
  };
}

/**
 * A standalone clone: `.git` is a folder that borrows objects through
 * alternates. The repo's own main checkout has a `.git` folder too, but no
 * alternates, and keeps the deny list.
 */
function isClone(cwd: string): boolean {
  try {
    return statSync(join(cwd, ".git")).isDirectory() && existsSync(join(cwd, ".git", "objects", "info", "alternates"));
  } catch {
    return false;
  }
}

/**
 * The git paths the agent may write, and the ones it may not. A commit in a
 * linked worktree writes the worktree's own git dir (index, logs/HEAD, a
 * short-lived HEAD.lock), new objects, and the task branch's ref through
 * `<ref>.lock` then a rename; stash writes refs/stash. Those are allowed.
 *
 * Claude Code's sandbox also opens the whole shared .git to a linked
 * worktree, so the denies are the real boundary, and they win over any allow:
 * every other branch that exists now and every protected branch (main, the
 * ship and train branches) even if it doesn't exist yet, tags, packed-refs,
 * the other worktrees, the main checkout's HEAD and index, this worktree's
 * HEAD (so it can't be pointed at another branch for NightCrew's next git
 * command), the pointer files (so another repo can't be swapped in), and
 * hooks, config, legacy remotes, submodules and alternates (code or URLs this
 * machine's git would act on). A branch the agent creates under a new name is
 * not covered; it can't move one NightCrew relies on.
 */
function gitWrites(cwd: string, protectedBranches: string[]): { allow: string[]; deny: string[] } | null {
  const git = gitDirs(cwd);
  if (!git) return null;
  const { dir, common, branch } = git;
  const deny = [
    join(dir, "HEAD"),
    join(common, "HEAD"),
    join(common, "index"),
    join(common, "hooks"),
    join(common, "config"),
    join(common, "config.worktree"),
    join(common, "info"),
    join(common, "commondir"),
    join(common, "packed-refs"),
    join(common, "remotes"),
    join(common, "branches"),
    join(common, "modules"),
    join(common, "objects", "info", "alternates"),
    join(common, "refs", "tags"),
  ];
  // The repo's main checkout: its .git sits inside the writable cwd, so deny
  // every ref. Tasks run in clones; this covers compose.
  if (dir === common) return { allow: [], deny: [...new Set([...deny, join(common, "refs")])] };

  deny.push(join(cwd, ".git"), join(dir, "commondir"), join(dir, "gitdir"), join(dir, "config.worktree"));
  for (const other of [...new Set([...localBranches(common), ...protectedBranches])]) {
    if (other === branch && !protectedBranches.includes(other)) continue;
    const ref = join(common, "refs", "heads", other);
    deny.push(ref, `${ref}.lock`);
  }
  for (const wt of listDir(join(common, "worktrees"))) {
    if (join(common, "worktrees", wt) !== dir) deny.push(join(common, "worktrees", wt));
  }

  const allow = [dir, join(common, "objects")];
  for (const ref of ["refs/stash", ...(branch ? [`refs/heads/${branch}`] : [])]) {
    const file = join(common, ref);
    const log = join(common, "logs", ref);
    allow.push(file, `${file}.lock`, log);
    // A branch with a slash lives in a nested folder, and a packed branch has
    // none; make it here, on the host, in case the sandbox can't.
    for (const d of [dirname(file), dirname(log)]) {
      try {
        mkdirSync(d, { recursive: true });
      } catch {}
    }
  }
  return { allow, deny: [...new Set(deny)] };
}

/** Local branch names: loose ref files under refs/heads plus packed ones. */
function localBranches(common: string): string[] {
  const heads = join(common, "refs", "heads");
  const loose = listDir(heads, true).filter((f) => !f.endsWith(".lock"));
  let packed: string[] = [];
  try {
    packed = [...readFileSync(join(common, "packed-refs"), "utf8").matchAll(/^[0-9a-f]+ refs\/heads\/(.+)$/gm)].map(
      (m) => m[1] as string,
    );
  } catch {}
  return [...new Set([...loose, ...packed])];
}

/** File names in a folder (relative paths when recursive). Empty if it can't be read. */
function listDir(path: string, recursive = false): string[] {
  try {
    return readdirSync(path, { withFileTypes: true, recursive })
      .filter((e) => (recursive ? e.isFile() : true))
      .map((e) => relative(path, join(e.parentPath, e.name)));
  } catch {
    return [];
  }
}

/** The worktree's own git dir, the repo's shared one and the checked out branch. Null if cwd isn't a repo root. */
function gitDirs(cwd: string): { dir: string; common: string; branch: string | null } | null {
  const dotGit = join(cwd, ".git");
  try {
    let dir = dotGit;
    let common = dotGit;
    if (!statSync(dotGit).isDirectory()) {
      const pointer = readFileSync(dotGit, "utf8")
        .match(/^gitdir:\s*(.+)$/m)?.[1]
        ?.trim();
      if (!pointer) return null;
      dir = resolve(cwd, pointer);
      const commondir = join(dir, "commondir");
      common = existsSync(commondir) ? resolve(dir, readFileSync(commondir, "utf8").trim()) : dir;
    }
    const head = readFileSync(join(dir, "HEAD"), "utf8")
      .match(/^ref:\s*refs\/heads\/(.+)$/m)?.[1]
      ?.trim();
    // A name that climbs out of refs/heads gets no ref at all.
    const branch = head && !head.split("/").includes("..") ? head : null;
    return { dir, common, branch };
  } catch {
    return null;
  }
}

const INSTRUCTION_FILES = ["CLAUDE.md", "AGENTS.md", ".claude/CLAUDE.md"];
const MAX_INSTRUCTIONS = 24_000;

/** Append the repo's CLAUDE.md / AGENTS.md so the crew follows the project's conventions. */
export function withRepoInstructions(system: string, cwd: string): string {
  const parts: string[] = [];
  let budget = MAX_INSTRUCTIONS;
  for (const name of INSTRUCTION_FILES) {
    const path = join(cwd, name);
    if (!existsSync(path) || budget <= 0) continue;
    try {
      const text = readFileSync(path, "utf8").slice(0, budget);
      budget -= text.length;
      parts.push(`### ${name}\n${text}`);
    } catch {}
  }
  return parts.length
    ? `${system}\n\n## Repository instructions\nThe project's own guidance. Follow it unless it conflicts with your limits.\n\n${parts.join("\n\n")}`
    : system;
}

function describeFailure(subtype: string, status: number | null | undefined, text: string): string {
  if (status === 429) return "Rate limited by the API (429).";
  if (status) return `API error ${status}.`;
  switch (subtype) {
    case "error_max_turns":
      return "Hit the turn limit before finishing.";
    case "error_max_budget_usd":
      return "Hit the task's token budget before finishing.";
    case "error_max_structured_output_retries":
      return "Couldn't produce a valid structured answer.";
    default:
      return text.trim().slice(0, 240) || "The agent stopped with an error.";
  }
}
