// One task, start to finish: worktree → plan → implement → validate (with one
// repair attempt) → review → commit, push and draft PR. Every step is written
// to run_events so the dashboard can show it live.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { nightIdFor, type Repo, type Task } from "@nightcrew/core";
import { matchesAny } from "@nightcrew/core/guard";
import {
  addRunEvent,
  countRunsForTask,
  type Db,
  getRepo,
  getTask,
  listNotes,
  type RunEvent,
  updateTask,
  upsertRuns,
} from "@nightcrew/db";
import type { AgentEngine, EngineEvent, PhaseRequest, PhaseResult } from "./engine";
import { changedFiles, commitAll, commitsAhead, diffStat, ensureWorktree, openOrUpdatePr, push, run } from "./git";
import {
  implementPrompt,
  type PromptContext,
  planPrompt,
  REVIEW_SCHEMA,
  type ReviewOutput,
  repairPrompt,
  researchPrompt,
  reviewPrompt,
} from "./prompts";

export interface PipelineDeps {
  db: Db;
  engine: AgentEngine;
  dataDir: string;
  models: { plan: string; build: string; review: string };
  /** Publish branches and PRs. Off in tests and dry runs. */
  publish: boolean;
  onEvent?: (e: RunEvent) => void;
}

export interface TaskOutcome {
  runId: string;
  status: "complete" | "failed" | "timeout";
  costCents: number;
  prUrl: string | null;
  reason: string | null;
}

const PHASE_NAME: Record<string, string> = {
  plan: "Planning",
  implement: "Building",
  repair: "Repairing",
  review: "Review",
  research: "Research",
};

const ALWAYS_PROTECTED = [".github/workflows/**", ".env", ".env.*", "**/.env", "**/.env.*"];

export async function runTask(deps: PipelineDeps, taskId: string, signal: AbortSignal): Promise<TaskOutcome> {
  const { db } = deps;
  const task = getTask(db, taskId);
  if (!task) throw new Error(`Task ${taskId} not found.`);
  const repo = getRepo(db, task.repoId);
  if (!repo) throw new Error(`Repo for task ${taskId} not found.`);

  const startedAt = new Date().toISOString();
  const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const artifactsDir = join(deps.dataDir, "runs", runId);
  mkdirSync(artifactsDir, { recursive: true });

  const attempts = countRunsForTask(db, task.id);
  const state = {
    status: "running" as "running" | "complete" | "failed" | "timeout",
    phase: "setup",
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    reason: null as string | null,
    summary: null as string | null,
    verdict: null as string | null,
    prUrl: null as string | null,
    prNumber: null as number | null,
    worktree: null as string | null,
    stat: null as { additions: number; deletions: number; files: number } | null,
  };
  const artifacts = new Map<string, { kind: string; name: string; content: string }>();

  const save = () =>
    upsertRuns(db, [
      {
        run: {
          id: runId,
          nightId: nightIdFor(startedAt),
          sessionId: runId,
          taskId: task.id,
          title: task.title,
          repo: repo.name,
          repoPath: repo.path,
          type: task.type,
          status: state.status,
          source: "local",
          startedAt,
          endedAt: state.status === "running" ? null : new Date().toISOString(),
          model: deps.models.build,
          costCents: Math.round(state.costUsd * 100),
          tokensIn: state.tokensIn,
          tokensOut: state.tokensOut,
          attempt: attempts + 1,
          prUrl: state.prUrl,
          prNumber: state.prNumber,
          prState: state.prUrl ? "draft" : null,
          branch: task.branch,
          additions: state.stat?.additions ?? null,
          deletions: state.stat?.deletions ?? null,
          changedFiles: state.stat?.files ?? null,
          reason: state.reason,
          summary: state.summary,
          phase: state.status === "running" ? state.phase : null,
          worktree: state.worktree,
          verdict: state.verdict,
        },
        artifacts: [...artifacts.values()],
      },
    ]);

  const emit = (kind: RunEvent["kind"], text: string, data: unknown = null) => {
    const e = addRunEvent(db, { runId, phase: state.phase, kind, text, data });
    deps.onEvent?.(e);
  };
  const phase = (name: string, label: string) => {
    state.phase = name;
    save();
    emit("phase", label);
  };
  const onEngine = (e: EngineEvent) => emit(e.kind, e.text, "tool" in e ? { tool: e.tool } : null);
  const account = (r: PhaseResult) => {
    state.costUsd += r.costUsd;
    state.tokensIn += r.tokensIn;
    state.tokensOut += r.tokensOut;
    if (r.costUsd > 0)
      emit(
        "info",
        `${PHASE_NAME[state.phase] ?? state.phase} used $${r.costUsd.toFixed(2)} over ${r.turns} ${r.turns === 1 ? "turn" : "turns"}.`,
        { costUsd: r.costUsd, turns: r.turns, usage: r.usage },
      );
  };
  const remainingBudget = () => Math.max(0.05, task.budgetCents / 100 - state.costUsd);
  // The reviewer always gets something, however hungry the build was.
  const reviewReserve = () => Math.min(1.2, (task.budgetCents / 100) * 0.25);
  const buildBudget = () => Math.max(0.05, remainingBudget() - reviewReserve());
  const artifact = (kind: string, name: string, content: string) => {
    if (content.trim()) artifacts.set(kind, { kind, name, content });
  };

  updateTask(db, task.id, { status: "running", lastRunId: runId });
  save();
  emit("info", `Started ${task.title} in ${repo.name}`);

  // The task's own time limit, on top of whatever stopped the whole night.
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), task.maxMinutes * 60_000);
  const stop = AbortSignal.any([signal, timeout.signal]);

  const finish = async (status: "complete" | "failed" | "timeout", reason: string | null): Promise<TaskOutcome> => {
    clearTimeout(timer);
    // Keep unfinished work on the branch (locally) so the next attempt resumes it.
    if (status !== "complete" && state.worktree) {
      const kept = await commitAll(
        state.worktree,
        `WIP: ${task.title}\n\nNightCrew stopped early: ${reason ?? status}.`,
      ).catch(() => false);
      if (kept) emit("info", "Saved the unfinished work on the branch so the next attempt can pick it up.");
    }
    state.status = status;
    state.reason = reason;
    const decisions = join(artifactsDir, "DECISIONS.md");
    if (existsSync(decisions)) artifact("decisions", "DECISIONS.md", readFileSync(decisions, "utf8"));
    const report = join(artifactsDir, "REPORT.md");
    if (existsSync(report)) artifact("report", "REPORT.md", readFileSync(report, "utf8"));
    save();
    updateTask(db, task.id, { status: "done" });
    emit(status === "complete" ? "result" : "error", reason ?? state.summary ?? "Done.");
    return { runId, status, costCents: Math.round(state.costUsd * 100), prUrl: state.prUrl, reason };
  };

  try {
    phase("setup", "Preparing the worktree");
    const worktree = await ensureWorktree(repo.path, task.branch, repo.defaultBranch);
    state.worktree = worktree;
    const ctx: PromptContext = {
      task,
      repo,
      artifactsDir,
      feedback: listNotes(db, task.id),
      resumeCommits: await commitsAhead(worktree, repo.defaultBranch),
    };
    const base = {
      cwd: worktree,
      guard: {
        worktree,
        writableDirs: [artifactsDir],
        scope: task.scope,
        protectedBranches: repo.protectedBranches,
        readOnly: false,
      },
      signal: stop,
    } satisfies Partial<PhaseRequest>;

    // Research: one phase, a report, no code.
    if (task.type === "research") {
      phase("research", "Researching");
      const p = researchPrompt(ctx);
      const r = await deps.engine.runPhase(
        {
          ...base,
          phase: "research",
          prompt: p.prompt,
          systemPrompt: p.system,
          model: deps.models.plan,
          maxBudgetUsd: remainingBudget(),
          maxTurns: 80,
          guard: { ...base.guard, readOnly: true },
        },
        onEngine,
      );
      account(r);
      if (!r.ok) return await finish(stop.aborted ? "timeout" : "failed", r.error);
      state.summary = firstSentence(r.text);
      state.verdict = "ready";
      return await finish("complete", null);
    }

    // Plan
    phase("plan", "Planning");
    const pp = planPrompt(ctx);
    const plan = await deps.engine.runPhase(
      {
        ...base,
        phase: "plan",
        prompt: pp.prompt,
        systemPrompt: pp.system,
        model: deps.models.plan,
        maxBudgetUsd: Math.min(remainingBudget() * 0.3, Math.max(0.75, remainingBudget() * 0.2)),
        maxTurns: 40,
        guard: { ...base.guard, readOnly: true },
      },
      onEngine,
    );
    account(plan);
    // Build in the planner's session so what it already read stays in context.
    // Only when planner and builder are the same model; otherwise start fresh.
    let session = plan.sessionId && deps.models.plan === (task.model ?? deps.models.build) ? plan.sessionId : undefined;
    if (plan.text.trim()) {
      ctx.plan = plan.text;
      artifact("plan", "PLAN.md", plan.text);
      if (!plan.ok) emit("info", `Planning stopped early (${plan.error}), but wrote enough of a plan to build from.`);
    } else {
      // The classic runner learned this the hard way: a failed plan shouldn't sink the task.
      emit("info", `Planning didn't finish (${plan.error ?? "no plan"}). Implementing from the brief instead.`);
      session = undefined;
      if (stop.aborted) return await finish("timeout", "Ran out of time while planning.");
    }

    if (repo.level === "propose") {
      state.summary = ctx.plan ? firstSentence(ctx.plan) : null;
      state.verdict = "needs_eyes";
      return await finish(ctx.plan ? "complete" : "failed", ctx.plan ? null : plan.error);
    }

    // Implement
    phase("implement", "Implementing");
    const ip = implementPrompt(ctx);
    const impl = await deps.engine.runPhase(
      {
        ...base,
        phase: "implement",
        prompt: session ? `${ip.prompt}\n\nYou wrote the plan above in this session. Now implement it.` : ip.prompt,
        systemPrompt: ip.system,
        model: task.model ?? deps.models.build,
        maxBudgetUsd: buildBudget(),
        maxTurns: 150,
        resumeSession: session,
      },
      onEngine,
    );
    account(impl);
    session = impl.sessionId ?? session;
    if (!impl.ok) return await finish(stop.aborted ? "timeout" : "failed", impl.error);
    state.summary = firstSentence(impl.text);

    // Validate, with one repair attempt
    phase("validate", "Checking the work");
    let check = await validate(worktree, task, repo);
    artifact("tests", "Checks", check.log);
    if (!check.ok && !stop.aborted) {
      emit("info", `Checks failed: ${check.reason}. Trying one repair.`);
      phase("repair", "Repairing");
      const rp = repairPrompt(ctx, check.log);
      const fix = await deps.engine.runPhase(
        {
          ...base,
          phase: "repair",
          prompt: rp.prompt,
          systemPrompt: rp.system,
          model: task.model ?? deps.models.build,
          maxBudgetUsd: buildBudget(),
          maxTurns: 80,
          resumeSession: session,
        },
        onEngine,
      );
      account(fix);
      phase("validate", "Checking the repair");
      check = await validate(worktree, task, repo);
      artifact("tests", "Checks", check.log);
    }
    if (check.noChanges) return await finish("failed", "The crew finished without changing anything.");
    if (!check.ok) return await finish(stop.aborted ? "timeout" : "failed", check.reason);

    // Review
    phase("review", "Reviewing");
    const rv = reviewPrompt(ctx);
    const review = await deps.engine.runPhase(
      {
        ...base,
        phase: "review",
        prompt: rv.prompt,
        systemPrompt: rv.system,
        model: deps.models.review,
        maxBudgetUsd: Math.max(0.05, remainingBudget()),
        maxTurns: 60,
        outputSchema: REVIEW_SCHEMA as unknown as Record<string, unknown>,
      },
      onEngine,
    );
    account(review);
    const verdict = review.ok ? (review.structured as ReviewOutput | null) : null;
    if (verdict) {
      state.verdict = verdict.verdict === "ready" ? "ready" : "needs_eyes";
      artifact("review", "REVIEW.md", renderReview(verdict));
      if (verdict.summary) state.summary = state.summary ?? verdict.summary;
    } else {
      state.verdict = "needs_eyes";
      artifact("review", "REVIEW.md", review.text || `The review didn't finish: ${review.error ?? "unknown error"}`);
    }
    // The reviewer may have fixed small things; checks must still pass.
    const recheck = await validate(worktree, task, repo);
    if (!recheck.ok) return await finish("failed", `Checks failed after review: ${recheck.reason}`);

    // Publish
    phase("publish", "Committing");
    await commitAll(worktree, `${task.title}\n\nNightCrew task ${task.id}, run ${runId}.`);
    state.stat = await diffStat(worktree, repo.defaultBranch);
    if (deps.publish) {
      const remote = (await run(["git", "remote", "get-url", "origin"], worktree)).ok;
      if (!remote) {
        emit("info", "No GitHub remote, so the branch stays local.");
      } else {
        phase("publish", "Pushing and opening a draft PR");
        const pushed = await push(worktree, task.branch);
        if (!pushed.ok) return await finish("failed", `Push failed: ${pushed.stderr.trim().split("\n").pop()}`);
        const pr = await openOrUpdatePr(worktree, {
          branch: task.branch,
          base: repo.defaultBranch,
          title: task.title,
          body: prBody({
            task,
            summary: state.summary,
            verdict,
            plan: ctx.plan ?? null,
            checks: check.log,
            costUsd: state.costUsd,
            runId,
          }),
        });
        state.prUrl = pr.url;
        state.prNumber = pr.number;
        emit("info", `Opened draft PR #${pr.number}`);
      }
    }
    return await finish("complete", null);
  } catch (e) {
    return await finish(stop.aborted ? "timeout" : "failed", e instanceof Error ? e.message : String(e));
  }
}

export interface CheckResult {
  ok: boolean;
  noChanges: boolean;
  reason: string | null;
  log: string;
  files: string[];
}

/** NightCrew's own checks, independent of what the agent claims. */
export async function validate(worktree: string, task: Task, repo: Repo): Promise<CheckResult> {
  const files = (await changedFiles(worktree, repo.defaultBranch)).filter((f) => !f.startsWith(".worktrees/"));
  const lines: string[] = [`Changed files (${files.length}):`, ...files.map((f) => `  ${f}`)];
  if (files.length === 0)
    return { ok: false, noChanges: true, reason: "No files changed.", log: lines.join("\n"), files };

  const outOfScope = files.filter(
    (f) => matchesAny(f, ALWAYS_PROTECTED) || (task.scope.length > 0 && !matchesAny(f, task.scope)),
  );
  if (outOfScope.length) {
    lines.push("", `Outside the task's scope: ${outOfScope.join(", ")}`);
    return {
      ok: false,
      noChanges: false,
      reason: `Changed files outside scope: ${outOfScope.join(", ")}`,
      log: lines.join("\n"),
      files,
    };
  }

  const cmd = task.testCommand ?? repo.testCommand;
  if (cmd) {
    const t = await run(["sh", "-c", cmd], worktree, { timeoutMs: 15 * 60_000 });
    const out = `${t.stdout}\n${t.stderr}`.trim();
    lines.push("", `$ ${cmd}  (exit ${t.code})`, out.length > 8000 ? `…\n${out.slice(-8000)}` : out);
    if (!t.ok)
      return {
        ok: false,
        noChanges: false,
        reason: `\`${cmd}\` failed (exit ${t.code}).`,
        log: lines.join("\n"),
        files,
      };
  } else {
    lines.push("", "No test command configured for this repo.");
  }
  return { ok: true, noChanges: false, reason: null, log: lines.join("\n"), files };
}

function renderReview(r: ReviewOutput): string {
  const crit = r.criteria.map((c) => `- [${c.met ? "x" : " "}] **${c.criterion}**: ${c.evidence}`).join("\n");
  const concerns = r.concerns.length ? r.concerns.map((c) => `- ${c}`).join("\n") : "- None.";
  return `# Review: ${r.verdict === "ready" ? "Ready" : r.verdict === "needs_eyes" ? "Needs your eyes" : "Not done"}\n\n${r.summary}\n\n## Acceptance criteria\n${crit}\n\n## Concerns\n${concerns}\n\n${r.report}`;
}

function prBody(input: {
  task: Task;
  summary: string | null;
  verdict: ReviewOutput | null;
  plan: string | null;
  checks: string;
  costUsd: number;
  runId: string;
}): string {
  const { task, verdict } = input;
  const crit = verdict?.criteria.length
    ? verdict.criteria.map((c) => `- [${c.met ? "x" : " "}] ${c.criterion}: ${c.evidence}`).join("\n")
    : task.criteria.map((c) => `- [ ] ${c}`).join("\n");
  const details = (title: string, body: string | null) =>
    body?.trim() ? `<details><summary>${title}</summary>\n\n${body.trim()}\n\n</details>\n` : "";
  return `${input.summary ?? task.title}

${task.brief ? `> ${task.brief.split("\n").join("\n> ")}\n` : ""}
### Acceptance criteria
${crit || "- (none set)"}

${verdict?.concerns.length ? `### Reviewer concerns\n${verdict.concerns.map((c) => `- ${c}`).join("\n")}\n` : ""}
${details("Plan", input.plan)}${details("Review", verdict?.report ?? null)}${details("Checks", `\`\`\`\n${input.checks.slice(-4000)}\n\`\`\``)}
---
Made overnight by [NightCrew](https://github.com/oluoyefeso/nightcrew) · run \`${input.runId}\` · $${input.costUsd.toFixed(2)}`;
}

function firstSentence(text: string): string | null {
  const line = text
    .split("\n")
    .map((l) =>
      l
        .replace(/^[#>*\s-]+/, "")
        .replace(/\*\*/g, "")
        .trim(),
    )
    .find((l) => l && !l.startsWith("```"));
  if (!line) return null;
  return line.length > 220 ? `${line.slice(0, 217)}…` : line;
}
