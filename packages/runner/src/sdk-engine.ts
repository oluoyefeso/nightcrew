// Runs a phase through the Claude Agent SDK on this machine. Uses
// ANTHROPIC_API_KEY when it's set, otherwise the local Claude Code login.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type HookCallback, type Options, query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  type AgentEngine,
  backstopUsd,
  checkGuard,
  describeTool,
  type EngineEvent,
  type PhaseRequest,
  type PhaseResult,
} from "./engine";

const TOOLS = ["Read", "Write", "Edit", "MultiEdit", "Bash", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite"];

export class SdkEngine implements AgentEngine {
  readonly name = "agent-sdk";
  constructor(private readonly opts: { claudePath?: string } = {}) {}

  async runPhase(req: PhaseRequest, onEvent: (e: EngineEvent) => void): Promise<PhaseResult> {
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
    const seen = new Set<string>();
    let liveTokens = 0;
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
          if (u && msg.message.id && !seen.has(msg.message.id)) {
            seen.add(msg.message.id);
            liveTokens +=
              (u.input_tokens ?? 0) +
              (u.output_tokens ?? 0) +
              (u.cache_read_input_tokens ?? 0) +
              (u.cache_creation_input_tokens ?? 0);
            if (liveTokens > req.maxTokens && !overBudget) {
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
      if (overBudget) {
        result.error = "Hit the task's token budget before finishing.";
        result.tokensIn ||= liveTokens;
      } else if (req.signal.aborted) result.error = "Stopped: the task ran out of time or was cancelled.";
      else if (/maximum budget/i.test(message)) result.error = "Hit the task's token budget before finishing.";
      else if (/rate.?limit|429/i.test(message)) {
        result.error = "Rate limited by the API (429).";
        result.rateLimited = true;
      } else if (!gotResult) result.error = `The agent crashed: ${message}`;
      else result.error ??= message.slice(0, 240);
    } finally {
      req.signal.removeEventListener("abort", onAbort);
    }
    // Whatever it said last is still useful (a plan cut short by the budget).
    if (!result.text && lastText) result.text = lastText;
    return result;
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
