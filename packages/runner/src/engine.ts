// The engine runs one agent phase. The pipeline doesn't care whether that
// happens through the local Agent SDK, Claude Managed Agents (M4) or a script
// in tests.

import type { AutonomyLevel, Task } from "@nightcrew/core";
import { type GuardContext, guardToolCall } from "@nightcrew/core/guard";

export interface PhaseRequest {
  phase: "plan" | "implement" | "repair" | "review" | "compose" | "research";
  cwd: string;
  /**
   * cwd is a task's standalone clone. Set by NightCrew from its own records,
   * never by looking at files in cwd, which the agent can change.
   */
  isolated?: boolean;
  prompt: string;
  systemPrompt: string;
  model: string;
  guard: GuardContext;
  /** Most tokens (input, cache and output) this phase may use. */
  maxTokens: number;
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
  /** Successful results without a status are treated as reported; failures default to partial/unknown. */
  usageStatus?: "reported" | "partial" | "unknown";
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
  /** Cumulative phase totals, including cached input once. No prompts or tool contents. */
  | { kind: "usage"; text: string; tokensIn: number; tokensOut: number }
  | { kind: "text"; text: string }
  | { kind: "tool"; text: string; tool: string; input: unknown }
  | { kind: "denied"; text: string; tool: string }
  | { kind: "info"; text: string };

export interface AgentEngine {
  readonly name: string;
  readonly capabilities: EngineCapabilities;
  runPhase(req: PhaseRequest, onEvent: (e: EngineEvent) => void): Promise<PhaseResult>;
}

/** Adapter behavior, not a model competence score or a grant of repository authority. */
export interface EngineCapabilities {
  readonly phases: readonly PhaseRequest["phase"][];
  readonly structuredOutput: boolean;
  readonly sessionContinuation: boolean;
}
export const ENGINE_PHASES = ["plan", "implement", "repair", "review", "compose", "research"] as const;

/** A missing declaration fails closed, including adapters loaded from older integrations. */
function capabilityError(
  engine: AgentEngine,
  phases: readonly PhaseRequest["phase"][],
  structured: boolean,
): string | null {
  const capabilities = engine.capabilities;
  if (!capabilities || !Array.isArray(capabilities.phases)) return "The engine has not declared its supported phases.";
  if (phases.some((phase) => !capabilities.phases.includes(phase)))
    return "The engine does not support every phase required for this work.";
  if (structured && capabilities.structuredOutput !== true)
    return "The engine does not support the structured result required for this work.";
  return null;
}

/** Hold the entire possible route before setup, rather than discovering a missing reviewer after building. */
export function taskEngineError(
  engine: AgentEngine,
  task: Pick<Task, "type"> & Partial<Pick<Task, "workflow">>,
  authority: AutonomyLevel,
): string | null {
  const phases: PhaseRequest["phase"][] =
    task.type === "research"
      ? ["research"]
      : authority === "propose"
        ? ["plan"]
        : task.workflow === "quick"
          ? ["implement", "repair", "review"]
          : ["plan", "implement", "repair", "review"];
  return capabilityError(engine, phases, phases.includes("review"));
}

export function phaseAdmissionError(engine: AgentEngine, req: PhaseRequest): string | null {
  if (!ENGINE_PHASES.includes(req.phase)) return "The requested agent phase is unsupported.";
  const error = capabilityError(engine, [req.phase], Boolean(req.outputSchema));
  if (error) return error;
  if (req.resumeSession && engine.capabilities.sessionContinuation !== true)
    return "The engine cannot continue the requested session.";
  if (["plan", "research", "compose"].includes(req.phase) && req.guard.readOnly !== true)
    return "Planning, research and task drafting require a read-only guard.";
  if (["review", "compose"].includes(req.phase) && !req.outputSchema)
    return "Review and task drafting require a structured result schema.";
  if (!Number.isFinite(req.maxTokens) || req.maxTokens <= 0 || !Number.isSafeInteger(req.maxTurns) || req.maxTurns <= 0)
    return "An agent phase requires positive token and turn limits.";
  return null;
}

/** Zero usage here is known: admission happens before any provider call. */
export function admissionResult(error: string): PhaseResult {
  return { ...stoppedResult(), error, usageStatus: "reported" };
}
export async function runEnginePhase(
  engine: AgentEngine,
  req: PhaseRequest,
  onEvent: (e: EngineEvent) => void,
): Promise<PhaseResult> {
  if (req.signal.aborted) return stoppedResult();
  const error = phaseAdmissionError(engine, req);
  return error ? admissionResult(error) : engine.runPhase(req, onEvent);
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

export const STOPPED = "Stopped: the task ran out of time or was cancelled.";

/** The result for a phase that was stopped before it did anything. */
export function stoppedResult(): PhaseResult {
  return {
    ok: false,
    text: "",
    structured: null,
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    turns: 0,
    error: STOPPED,
    rateLimited: false,
  };
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
  readonly capabilities: EngineCapabilities = {
    phases: ENGINE_PHASES,
    structuredOutput: true,
    sessionContinuation: true,
  };
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

/**
 * A dollar ceiling derived from a token cap, passed to APIs that only take a
 * cost limit. Deliberately generous (cache reads cost far less than this);
 * the token cap is the real limit.
 */
export function backstopUsd(maxTokens: number): number {
  return Math.max(0.1, (maxTokens / 1_000_000) * 15);
}
