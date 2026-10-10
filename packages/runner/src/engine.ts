// The engine runs one agent phase. The pipeline doesn't care whether that
// happens through the local Agent SDK, Claude Managed Agents (M4) or a script
// in tests.

import { type GuardContext, guardToolCall } from "@nightcrew/core/guard";

export interface PhaseRequest {
  phase: "plan" | "implement" | "repair" | "review" | "compose" | "research";
  cwd: string;
  prompt: string;
  systemPrompt: string;
  model: string;
  guard: GuardContext;
  maxBudgetUsd: number;
  maxTurns: number;
  /** Tools the phase may not use at all. */
  disallowedTools?: string[];
  /** Ask for a JSON result matching this schema. */
  outputSchema?: Record<string, unknown>;
  /** Continue an earlier phase's session, so its context and cache carry over. */
  resumeSession?: string;
  signal: AbortSignal;
}

export interface PhaseResult {
  ok: boolean;
  text: string;
  structured: unknown;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  turns: number;
  /** Why the phase ended badly, in words a person can act on. */
  error: string | null;
  rateLimited: boolean;
  /** Session id, for resuming in a later phase. */
  sessionId?: string;
  /** Per-model token and cost breakdown, for diagnosing spend. */
  usage?: Record<
    string,
    { input: number; output: number; thinking: number; cacheRead: number; cacheWrite: number; costUsd: number }
  >;
}

export type EngineEvent =
  | { kind: "text"; text: string }
  | { kind: "tool"; text: string; tool: string; input: unknown }
  | { kind: "denied"; text: string; tool: string }
  | { kind: "info"; text: string };

export interface AgentEngine {
  readonly name: string;
  runPhase(req: PhaseRequest, onEvent: (e: EngineEvent) => void): Promise<PhaseResult>;
}

/** Short human description of a tool call for the live run view. */
export function describeTool(tool: string, input: Record<string, unknown>, cwd: string): string {
  const rel = (p: unknown) => String(p ?? "").replace(`${cwd}/`, "");
  switch (tool) {
    case "Read":
      return `Read ${rel(input.file_path)}`;
    case "Write":
      return `Wrote ${rel(input.file_path)}`;
    case "Edit":
    case "MultiEdit":
      return `Edited ${rel(input.file_path)}`;
    case "Bash":
      return `$ ${String(input.command ?? "")
        .split("\n")[0]
        ?.slice(0, 160)}`;
    case "Glob":
      return `Looked for ${input.pattern}`;
    case "Grep":
      return `Searched for "${String(input.pattern ?? "").slice(0, 80)}"`;
    case "WebFetch":
      return `Fetched ${input.url}`;
    case "WebSearch":
      return `Searched the web for "${input.query}"`;
    case "Task":
    case "Agent":
      return `Started a helper: ${String(input.description ?? "").slice(0, 100)}`;
    case "TodoWrite":
      return "Updated its checklist";
    default:
      return tool;
  }
}

/** Shared guard check used by every engine. */
export function checkGuard(req: PhaseRequest, tool: string, input: Record<string, unknown>) {
  return guardToolCall(tool, input, req.guard);
}

// ── Scripted engine for tests ───────────────────────────────────────────────

export type Script = (
  req: PhaseRequest,
  emit: (e: EngineEvent) => void,
) => Promise<Partial<PhaseResult>> | Partial<PhaseResult>;

export class ScriptedEngine implements AgentEngine {
  readonly name = "scripted";
  readonly calls: PhaseRequest[] = [];
  constructor(private readonly scripts: Partial<Record<PhaseRequest["phase"], Script>>) {}

  async runPhase(req: PhaseRequest, onEvent: (e: EngineEvent) => void): Promise<PhaseResult> {
    this.calls.push(req);
    const script = this.scripts[req.phase];
    const out = script ? await script(req, onEvent) : {};
    return {
      ok: true,
      text: "",
      structured: null,
      costUsd: 0.1,
      tokensIn: 100,
      tokensOut: 50,
      turns: 1,
      error: null,
      rateLimited: false,
      ...out,
    };
  }
}
