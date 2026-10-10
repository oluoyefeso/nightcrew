// Reflexes: the crew's fast, typed judgement calls (is this task ready to run
// unattended, which workflow fits, how confident are we in the result, what
// kind of failure was that). Jev, TypeSafe's System One model, answers them in
// ~100ms when TYPESAFE_API_KEY is set; otherwise simple rules stand in.

import type { Task } from "@nightcrew/core";

export type Question =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export type Answer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number };

export interface Reflexes {
  readonly name: string;
  ask(state: string, questions: Record<string, Question>): Promise<Record<string, Answer> | null>;
}

/** Jev over HTTP: https://docs.typesafe.ai/introduction/quickstart */
export class JevReflexes implements Reflexes {
  readonly name = "jev";
  constructor(
    private readonly apiKey: string,
    private readonly opts: { model?: string; fetch?: typeof fetch; endpoint?: string } = {},
  ) {}

  async ask(state: string, questions: Record<string, Question>): Promise<Record<string, Answer> | null> {
    try {
      const res = await (this.opts.fetch ?? fetch)(this.opts.endpoint ?? "https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ state: state.slice(0, 60_000), model: this.opts.model ?? "jev-latest", questions }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { answers?: Record<string, Answer> };
      return body.answers ?? null;
    } catch {
      return null;
    }
  }
}

/** No model: answers nothing, so every caller falls back to its rule. */
export class NoReflexes implements Reflexes {
  readonly name = "rules";
  async ask() {
    return null;
  }
}

export function reflexesFromEnv(): Reflexes {
  const key = process.env.TYPESAFE_API_KEY;
  return key ? new JevReflexes(key) : new NoReflexes();
}

// ── The questions NightCrew asks ────────────────────────────────────────────

/** quick: build directly. planned: plan first. Planning costs a phase; small tasks don't need it. */
export async function chooseWorkflow(r: Reflexes, task: Task): Promise<"quick" | "planned"> {
  if (task.workflow === "quick" || task.workflow === "planned") return task.workflow;
  const a = await r.ask(taskState(task), {
    workflow: {
      type: "choice",
      instructions: "How should an autonomous coding agent approach this task?",
      criteria: {
        quick: "Small and well specified: one or two files, the change is obvious from the brief",
        planned: "Several files, design decisions, unclear approach, or risk of breaking things",
      },
    },
  });
  const w = a?.workflow;
  if (w?.type === "choice" && w.confidence >= 0.6 && (w.choice === "quick" || w.choice === "planned")) return w.choice;
  return ruleWorkflow(task);
}

export function ruleWorkflow(task: Task): "quick" | "planned" {
  if (task.type === "refactor") return "planned";
  const narrowScope = task.scope.length > 0 && task.scope.length <= 3;
  const short = task.brief.length < 500 && task.criteria.length <= 3;
  return narrowScope && short ? "quick" : "planned";
}

/** 0–1 confidence that a careful reviewer would merge this unchanged. */
export async function scoreConfidence(
  r: Reflexes,
  input: {
    task: Task;
    review: {
      verdict: string;
      challenges?: { challenge?: string; held: boolean; detail?: string }[];
      concerns: string[];
    } | null;
    /** Rendered evidence, for the model's prompt only. */
    evidence: string | null;
    /** How many required pieces of evidence couldn't be gathered. */
    evidenceMissing: number;
    checksPassed: boolean;
  },
): Promise<number> {
  const state = `${taskState(input.task)}\n\nReview verdict: ${input.review?.verdict ?? "none"}\nConcerns: ${input.review?.concerns.join("; ") || "none"}\nEvidence:\n${input.evidence ?? "none"}\nChecks passed: ${input.checksPassed}`;
  const a = await r.ask(state, {
    merge_confidence: {
      type: "score",
      instructions: "How confident would a careful senior engineer be merging this change without edits?",
      criteria: ["Would not merge", "Needs changes", "Probably fine after a skim", "Clearly ready"],
    },
  });
  const s = a?.merge_confidence;
  if (s?.type === "score" && s.confidence >= 0.5) return Math.max(0, Math.min(1, s.score));
  return ruleConfidence(input);
}

export function ruleConfidence(input: {
  review: {
    verdict: string;
    challenges?: { challenge?: string; held: boolean; detail?: string }[];
    concerns: string[];
  } | null;
  evidenceMissing: number;
  checksPassed: boolean;
}): number {
  if (!input.checksPassed || !input.review) return 0.2;
  if (input.evidenceMissing > 0) return 0.45;
  const held = input.review.challenges?.filter((c) => c.held).length ?? 0;
  if (input.review.verdict !== "ready") return 0.5;
  return Math.max(0.5, 0.95 - held * 0.15 - input.review.concerns.length * 0.05);
}

export type FailureKind = "rate_limit" | "flaky" | "environment" | "real";

/** What kind of failure was that? Decides whether a retry is worth it. */
export async function classifyFailure(r: Reflexes, reason: string, log: string): Promise<FailureKind> {
  if (/\b429\b|rate.?limit/i.test(reason)) return "rate_limit";
  const a = await r.ask(`Failure: ${reason}\n\nLog tail:\n${log.slice(-6000)}`, {
    kind: {
      type: "choice",
      instructions: "What caused this automated coding task to fail?",
      criteria: {
        flaky: "A flaky or timing-dependent test, network blip, or intermittent tool error; a retry would likely pass",
        environment: "Missing dependency, misconfigured tooling, or setup problem unrelated to the change",
        real: "The change itself is wrong or incomplete",
      },
    },
  });
  const k = a?.kind;
  if (
    k?.type === "choice" &&
    k.confidence >= 0.7 &&
    (k.choice === "flaky" || k.choice === "environment" || k.choice === "real")
  )
    return k.choice;
  if (/ETIMEDOUT|ECONNRESET|socket hang up|EAI_AGAIN|flaky/i.test(log)) return "flaky";
  if (/command not found|Cannot find module|ENOENT.*node_modules|No such file or directory: .*bin/i.test(log))
    return "environment";
  return "real";
}

function taskState(t: Task): string {
  return `Task: ${t.title}\nType: ${t.type}\nScope: ${t.scope.join(", ") || "whole repo"}\nCriteria:\n${t.criteria.map((c) => `- ${c}`).join("\n") || "- none"}\n\nBrief:\n${t.brief}`;
}
