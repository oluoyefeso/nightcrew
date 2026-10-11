// Prompts for each phase. Ported from the classic templates and tightened:
// artifacts go to NightCrew's own folder, never into the user's repo.

import {
  policyEvidence,
  policySummary,
  type Repo,
  type ResolvedPolicy,
  resolvePolicy,
  type Task,
  type TaskNote,
} from "@nightcrew/core";

export interface PromptContext {
  task: Task;
  repo: Repo;
  artifactsDir: string;
  /** Your notes from earlier attempts, newest last. */
  feedback: TaskNote[];
  /** Commits already on the branch from an earlier attempt. */
  resumeCommits: number;
  plan?: string;
  /** Summary of the evidence NightCrew gathered itself. */
  evidence?: string;
  policy?: ResolvedPolicy;
}

const scopeLine = (t: Task) => (t.scope.length ? t.scope.join(", ") : "anything in the repository (no scope was set)");
const criteria = (t: Task) =>
  t.criteria.length ? t.criteria.map((c) => `- ${c}`).join("\n") : "- Do what the brief asks, with tests.";

function taskBlock({ task, repo, policy }: PromptContext) {
  return `## Task
${task.title}

${task.brief || "(No further detail. Infer the intent from the title and the code.)"}

## Acceptance criteria
${criteria(task)}

## Evidence the reviewer expects
${policyEvidence(policy ?? resolvePolicy(repo, task.type))
  .map((e) => `- ${e}`)
  .join("\n")}

## Route
${policySummary(policy ?? resolvePolicy(repo, task.type))}

## Limits
- Repository: ${repo.name}. Branch: \`${task.branch}\` (based on \`${repo.defaultBranch}\`).
- You may only change: ${scopeLine(task)}.
- Protected branches, never check out: ${repo.protectedBranches.join(", ")}.
- Workflows, secrets files and .git are off limits. Pushing and opening PRs is done for you afterwards.`;
}

function feedbackBlock(ctx: PromptContext) {
  const parts: string[] = [];
  if (ctx.resumeCommits > 0) {
    parts.push(`## Earlier attempt
This branch already has ${ctx.resumeCommits} commit(s) from a previous night. Start with \`git log --oneline ${ctx.repo.defaultBranch}..HEAD\` and \`git diff ${ctx.repo.defaultBranch}...HEAD\`. Build on that work; don't redo it.`);
  }
  const yours = ctx.feedback.filter((n) => n.author === "you");
  if (yours.length) {
    parts.push(`## Feedback from the person who reviewed the last attempt
${yours.map((n) => `- ${n.body}`).join("\n")}

This feedback overrides the original brief where they conflict.`);
  }
  return parts.join("\n\n");
}

export function planPrompt(ctx: PromptContext): { system: string; prompt: string } {
  return {
    system: `You are the planning step of NightCrew, a coding crew. A separate agent will implement your plan without relying on a person answering questions during execution, so the plan must settle every decision.

You are NOT implementing. Read the code, then reply with the plan.`,
    prompt: `${taskBlock(ctx)}

${feedbackBlock(ctx)}

## How to plan
1. Scope: what existing code already solves part of this? What's the smallest change that meets every criterion? Flag anything that could be deferred.
2. Decide. Pick an approach for every open question and say why in one line. Rate your confidence 1–10 next to each decision; the reviewer will look hardest at the low ones.
3. Files: list each file to change or add, in order, with what changes.
4. Tests: which tests prove each acceptance criterion. For a bug fix, the test must fail on the current code and pass after the fix.
5. Risks: what could break, and how the implementer should check it.
6. Not in scope: what you deliberately left out.

Keep it tight. Reply with the plan as markdown, starting with a one-line summary. Nothing else.`,
  };
}

export function implementPrompt(ctx: PromptContext): { system: string; prompt: string } {
  return {
    system: `You are NightCrew's implementer. You work independently within the task's scope and repo policy. Record blockers and decisions for the conductor.

When something is ambiguous, don't stop. Choose the most conservative reasonable option, note it in ${ctx.artifactsDir}/DECISIONS.md (what, why, alternatives, risk) and keep going.

Rules:
- Only change files the task allows. Changes elsewhere are refused automatically.
- Never check out another branch. Never push. Don't install global packages.
- Run the tests after significant changes and before you finish. Fix what you broke.
- Don't add features nobody asked for.
- Write DECISIONS.md and any notes to ${ctx.artifactsDir}, never into the repository.`,
    prompt: `${taskBlock(ctx)}

${feedbackBlock(ctx)}

${ctx.plan ? `## The plan to follow\n${ctx.plan}\n` : ""}
When you're done, reply with one or two plain sentences saying what you changed and how you verified it (for example "Added cursor pagination to /api/users; 14 new tests pass."). That line goes straight into the morning report.`,
  };
}

export function repairPrompt(ctx: PromptContext, failure: string): { system: string; prompt: string } {
  const impl = implementPrompt(ctx);
  return {
    system: impl.system,
    prompt: `${taskBlock(ctx)}

The work on this branch failed NightCrew's checks:

\`\`\`
${failure.slice(-6000)}
\`\`\`

Find the root cause and fix it. Don't weaken or delete tests to make them pass. If a check is wrong rather than the code, explain why in ${ctx.artifactsDir}/DECISIONS.md and leave the code correct.

Reply with one sentence on what you fixed.`,
  };
}

export const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["ready", "needs_eyes", "not_done"],
      description:
        "ready: meets every criterion and is safe to merge after a skim. needs_eyes: works but a person should look closely. not_done: doesn't meet the criteria.",
    },
    summary: { type: "string", description: "One sentence for the morning report." },
    criteria: {
      type: "array",
      items: {
        type: "object",
        properties: { criterion: { type: "string" }, met: { type: "boolean" }, evidence: { type: "string" } },
        required: ["criterion", "met", "evidence"],
      },
    },
    concerns: { type: "array", items: { type: "string" } },
    challenges: {
      type: "array",
      description:
        "Each way you tried to show the work is wrong or incomplete, and whether that challenge held (found a real problem) or failed (the work survived it).",
      items: {
        type: "object",
        properties: { challenge: { type: "string" }, held: { type: "boolean" }, detail: { type: "string" } },
        required: ["challenge", "held", "detail"],
      },
    },
    report: { type: "string", description: "The full review in markdown." },
  },
  required: ["verdict", "summary", "criteria", "concerns", "challenges", "report"],
} as const;

export interface ReviewOutput {
  verdict: "ready" | "needs_eyes" | "not_done";
  summary: string;
  criteria: { criterion: string; met: boolean; evidence: string }[];
  concerns: string[];
  challenges?: { challenge: string; held: boolean; detail: string }[];
  report: string;
}

export function reviewPrompt(ctx: PromptContext): { system: string; prompt: string } {
  return {
    system: `You are NightCrew's Skeptic. The implementer was a different agent; don't take its word for anything. Your job is to try to show the task is NOT done. Read the diff, run the tests, and check each acceptance criterion against real evidence. Make at least five concrete challenges (an edge case, a criterion, a test that might pass for the wrong reason, a regression, a scope problem) and record whether each one held.

You may fix small mechanical problems (typos, lint, a missing import) inside the task's scope. Anything bigger goes in your concerns.`,
    prompt: `${taskBlock(ctx)}

Review the work: \`git diff ${ctx.repo.defaultBranch}...HEAD\` plus anything uncommitted (\`git status\`, \`git diff\`).

## Evidence NightCrew gathered itself (trust this over the implementer's claims)
${ctx.evidence ?? "- None for this task type."}

Check:
1. Each acceptance criterion: met or not, with the evidence (a test name, a command and its output, a file and line).
2. Scope: did anything change that the task didn't ask for?
3. Correctness: missing edge cases, error paths, race conditions, security issues.
4. Tests: do they test the behaviour, or would they pass no matter what?

Then give your verdict.`,
  };
}

export function researchPrompt(ctx: PromptContext): { system: string; prompt: string } {
  return {
    system: `You are NightCrew's researcher. You work independently within the task's scope. Read code and the web as needed, but don't change the repository. Write your report to ${ctx.artifactsDir}/REPORT.md.`,
    prompt: `${taskBlock(ctx)}

${feedbackBlock(ctx)}

Answer the question thoroughly. Cite files with paths and line numbers, and web sources with URLs. Start the report with a short answer, then the detail. When finished, reply with the one-sentence answer.`,
  };
}
