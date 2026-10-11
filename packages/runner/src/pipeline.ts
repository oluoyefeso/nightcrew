// One task, start to finish: its own clone → plan → implement → validate
// (with one repair attempt) → review → commit, fetch into your repo, check
// there, then land (push and draft PR, train or ship). Every step is written
// to run_events so the dashboard can show it live.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  formatTokens,
  nightIdFor,
  policyEvidence,
  policySummary,
  type Repo,
  resolvePolicy,
  type Task,
  tightenPolicy,
} from "@nightcrew/core";
import { isAlwaysProtected, matchesAny } from "@nightcrew/core/guard";
import {
  addCar,
  addRunEvent,
  countRunsForTask,
  createTrain,
  type Db,
  getMission,
  getOpenTrain,
  getRepo,
  getTask,
  getTrain,
  listNotes,
  listTrains,
  markShipped,
  type RunEvent,
  setRunTrain,
  updateTask,
  upsertRuns,
} from "@nightcrew/db";
import type { AgentEngine, EngineEvent, PhaseRequest, PhaseResult } from "./engine";
import { type Evidence, gatherEvidence, missingPolicyEvidence, summarizeEvidence } from "./evidence";
import {
  commitsAhead,
  diffStat,
  fingerprints,
  git,
  lastLine,
  openOrUpdatePr,
  pushTo,
  resolveSha,
  taskChangedFiles,
  untouchedSetupFiles,
} from "./git";
import {
  boardTrain,
  buildsOnTakenOff,
  canShip,
  type Earlier,
  setLandingHome,
  shipTask,
  type TakenOff,
  trainBranch,
} from "./landing";
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
import { chooseWorkflow, NoReflexes, type Reflexes, scoreConfidence } from "./reflexes";
import { runCheck } from "./sandbox";
import { cloneIntact, TAMPERED } from "./sdk-engine";
import {
  acceptTask,
  cloneChangedFiles,
  cloneObjects,
  commitInClone,
  dropSetupFiles,
  ensureWorkspace,
  fetchTask,
  pointDefaultBranch,
  repoSupport,
  startFreshHint,
  taskRef,
  updateLocalBranch,
  type Workspace,
  wipRef,
  workspaceDir,
} from "./workspace";

export interface PipelineDeps {
  db: Db;
  engine: AgentEngine;
  dataDir: string;
  models: { plan: string; build: string; review: string };
  /** Publish branches and PRs. Off in tests and dry runs. */
  publish: boolean;
  /** Fast typed judgement calls (Jev, or rules). */
  reflexes?: Reflexes;
  onEvent?: (e: RunEvent) => void;
}

export interface TaskOutcome {
  runId: string;
  status: "complete" | "failed" | "timeout";
  costCents: number;
  /** Input (including cache) plus output tokens. */
  tokens: number;
  prUrl: string | null;
  reason: string | null;
  /** The run failed and its last phase hit a rate limit. */
  rateLimited: boolean;
  /** Tail of the failing check's output, or the last error, for telling flaky from real. */
  log?: string;
}

const PHASE_NAME: Record<string, string> = {
  evidence: "Evidence",
  plan: "Planning",
  implement: "Building",
  repair: "Repairing",
  review: "Review",
  research: "Research",
};

export async function runTask(deps: PipelineDeps, taskId: string, signal: AbortSignal): Promise<TaskOutcome> {
  const { db } = deps;
  const task = getTask(db, taskId);
  if (!task) throw new Error(`Task ${taskId} not found.`);
  const mission = task.missionId ? getMission(db, task.missionId) : null;
  const repo = getRepo(db, task.repoId);
  if (!repo) throw new Error(`Repo for task ${taskId} not found.`);
  const startingPolicy = resolvePolicy(repo, task.type);
  let policy = startingPolicy;

  setLandingHome(deps.dataDir);
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
    confidence: null as number | null,
    worktree: null as string | null,
    stat: null as { additions: number; deletions: number; files: number } | null,
    rateLimited: false,
    log: null as string | null,
  };
  const artifacts = new Map<string, { kind: string; name: string; content: string }>();
  /** Files the dependency install wrote, with their hashes: NightCrew's, not the agent's. */
  let setupFiles = new Map<string, string>();
  let workspace: Workspace | null = null;

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
          confidence: state.confidence,
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
    // Only the latest phase counts: an early rate limit the run got past isn't why it ended.
    state.rateLimited = r.rateLimited;
    state.costUsd += r.costUsd;
    state.tokensIn += r.tokensIn;
    state.tokensOut += r.tokensOut;
    if (r.tokensIn + r.tokensOut > 0)
      emit(
        "info",
        `${PHASE_NAME[state.phase] ?? state.phase} used ${formatTokens(r.tokensIn + r.tokensOut)} tokens over ${r.turns} ${r.turns === 1 ? "turn" : "turns"}.`,
        { tokens: r.tokensIn + r.tokensOut, turns: r.turns, usage: r.usage },
      );
  };
  const used = () => state.tokensIn + state.tokensOut;
  const remainingTokens = () => Math.max(10_000, task.tokenBudget - used());
  // The reviewer always gets something, however hungry the build was.
  const reviewReserve = () => Math.min(300_000, task.tokenBudget * 0.25);
  const buildTokens = () => Math.max(10_000, remainingTokens() - reviewReserve());
  const artifact = (kind: string, name: string, content: string) => {
    if (content.trim()) artifacts.set(kind, { kind, name, content });
  };
  const recordPolicy = (reasons: string[] = []) =>
    artifact(
      "policy",
      "ROUTE.md",
      `# Route\n\nAt dispatch: ${policySummary(startingPolicy)}\n\nCurrent route: ${policySummary(policy)}\n\n## Required evidence\n${policyEvidence(
        policy,
      )
        .map((e) => `- ${e}`)
        .join(
          "\n",
        )}\n\n${reasons.length ? `## Why it stopped here\n${reasons.map((r) => `- ${r}`).join("\n")}` : "Repository path rules and protected branches also apply. The route is rechecked before landing."}`,
    );
  recordPolicy();

  updateTask(db, task.id, { status: "running", lastRunId: runId });
  save();
  emit("info", `Started ${task.title} in ${repo.name}`);
  emit("info", `Route: ${policySummary(policy)}`);

  // The task's own time limit, on top of a stop from you or the crew.
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), task.maxMinutes * 60_000);
  const stop = AbortSignal.any([signal, timeout.signal]);
  const stoppedReason = (when: string) => `${timeout.signal.aborted ? "Ran out of time" : "Stopped"} ${when}.`;

  const finish = async (status: "complete" | "failed" | "timeout", reason: string | null): Promise<TaskOutcome> => {
    clearTimeout(timer);
    // Keep unfinished work on the task's branch in its clone so the next attempt resumes it.
    // Not from a clone whose .git was swapped: its git would act on whatever that points at.
    if (status !== "complete" && workspace && cloneIntact(workspace.dir)) {
      const ws = workspace;
      await dropSetupFiles(ws.dir, setupFiles).catch(() => {});
      const kept = await commitInClone(
        ws.dir,
        `WIP: ${task.title}\n\nNightCrew stopped early: ${reason ?? status}.`,
      ).catch(() => false);
      if (kept) {
        // A copy in your repo too, so the work outlives the clone.
        const saved = await fetchTask(ws).catch(() => null);
        emit(
          "info",
          saved
            ? `Saved the unfinished work at ${wipRef(task.id)} so the next attempt can pick it up.`
            : "Saved the unfinished work in the task's workspace so the next attempt can pick it up.",
        );
      }
    }
    state.status = status;
    state.reason = reason;
    const decisions = join(artifactsDir, "DECISIONS.md");
    if (existsSync(decisions)) artifact("decisions", "DECISIONS.md", readFileSync(decisions, "utf8"));
    const report = join(artifactsDir, "REPORT.md");
    if (existsSync(report)) artifact("report", "REPORT.md", readFileSync(report, "utf8"));
    save();
    // Archived while it ran: it stays archived.
    if (getTask(db, task.id)?.status !== "archived") updateTask(db, task.id, { status: "done" });
    emit(status === "complete" ? "result" : "error", reason ?? state.summary ?? "Done.");
    return {
      runId,
      status,
      costCents: Math.round(state.costUsd * 100),
      tokens: used(),
      prUrl: state.prUrl,
      reason,
      rateLimited: status === "failed" && state.rateLimited,
      log: status === "complete" ? undefined : (state.log ?? reason ?? "").slice(-4000),
    };
  };
  /** Stopped or out of time: keep the work, run nothing more. */
  const halt = (when: string) => finish("timeout", stoppedReason(when));
  const fresh = (clone: string) =>
    `Start the task fresh: ${startFreshHint(task.id, { clone, branch: task.branch })}, then run it again.`;
  /**
   * Refuse to build on work you pulled or undid: a run on top of it could
   * land only what's new, with the taken-off part left out. `base` is the
   * gate's base for `tip`.
   */
  const buildsOnPulled = async (tip: string | null, base: string, clone: string) => {
    if (!tip) return null;
    const off = await buildsOnTakenOff(repo.path, await takenOffLandings(db, repo, task), [tip], base);
    return off
      ? `This task's earlier work was taken off ${off.branch} (pulled or undone), and this run would build on it. ${fresh(clone)}`
      : null;
  };
  /**
   * The repo's trust settings and the task's scope as they are now: you may
   * change them (demote the repo, narrow the scope) while a task runs. Null
   * when the task or repo was deleted or the task archived meanwhile.
   */
  const live = () => {
    const r = getRepo(db, repo.id);
    const t = getTask(db, task.id);
    if (!r || !t || t.status === "archived") return null;
    const { shipBranch, allowShip, alwaysAsk, protectedBranches, policies } = r;
    policy = tightenPolicy(policy, resolvePolicy(r, task.type));
    return {
      repo: { ...repo, level: policy.authority, shipBranch, allowShip, alwaysAsk, protectedBranches, policies },
      task: { ...task, scope: t.scope, status: t.status },
    };
  };
  const gone = "The task was archived or deleted while it ran, so nothing landed.";

  try {
    phase("setup", "Preparing the workspace");
    const unsupported = await repoSupport(repo.path);
    if (unsupported) return await finish("failed", unsupported);
    // Where the task's earlier work forks from the default branch, read from your repo's refs before any agent runs.
    const before =
      (await resolveSha(repo.path, wipRef(task.id))) ??
      (await resolveSha(repo.path, taskRef(task.id))) ??
      (await resolveSha(repo.path, `refs/heads/${task.branch}`));
    const startBase = await gateBase(repo.path, repo.defaultBranch, before);
    const clone = workspaceDir(deps.dataDir, repo.id, task.id);
    const pulled = await buildsOnPulled(before, startBase, clone);
    if (pulled) return await finish("failed", pulled);
    const ws = await ensureWorkspace({ dataDir: deps.dataDir, repo, task, base: startBase, signal: stop });
    workspace = ws;
    const worktree = ws.dir;
    state.worktree = worktree;
    if (ws.pickedUp)
      emit("info", `Picked up ${ws.pickedUp} ${ws.pickedUp === 1 ? "commit" : "commits"} from origin/${task.branch}.`);
    if (!ws.fresh) emit("info", "Picking up where the last attempt left off.");
    const warn = (text: string) => emit("info", text);
    const objects = await cloneObjects(worktree);
    // A fresh clone has no dependencies; tests and previews need them.
    // Whatever the install itself writes is NightCrew's, not the agent's.
    if (
      repo.setupCommand &&
      !(repo.setupCommand.match(/\b(bun|npm|pnpm|yarn)\b/) && existsSync(join(worktree, "node_modules")))
    ) {
      emit("info", `Installing dependencies: ${repo.setupCommand}`);
      const untouched = new Set(await cloneChangedFiles(worktree, startBase, { signal: stop, warn }));
      const setup = await runCheck(repo.setupCommand, worktree, {
        timeoutMs: 10 * 60_000,
        signal: stop,
        warn,
        clone: true,
        objects,
      });
      if (!setup.ok) {
        const tail = `${setup.stdout}\n${setup.stderr}`.trim().split("\n").slice(-3).join(" ").slice(-300);
        emit(
          "info",
          `Dependency install failed (exit ${setup.code}). Continuing; the crew can install what it needs.${tail ? ` Last output: ${tail}` : ""}`,
        );
      }
      const touched = (await cloneChangedFiles(worktree, startBase, { signal: stop, warn })).filter(
        (f) => !untouched.has(f),
      );
      setupFiles = await fingerprints(worktree, touched);
    }
    if (stop.aborted) return await halt("while preparing the workspace");
    assertIntact(worktree);
    const startSha = await fetchTask(ws, stop);
    // Worked out again from where this run starts: taking in origin's "Update branch" moves it forward.
    const forkSha = await gateBase(repo.path, repo.defaultBranch, startSha);
    // Again from the clone's own tip, which may hold work your refs don't.
    const pulledInClone = await buildsOnPulled(startSha, forkSha, ws.dir);
    if (pulledInClone) return await finish("failed", pulledInClone);
    // The crew's own `git diff <default>...HEAD` then shows what the gate will check.
    await pointDefaultBranch(ws, repo.defaultBranch, forkSha, { signal: stop, warn });
    const ctx: PromptContext = {
      mission,
      task,
      repo,
      policy,
      artifactsDir,
      feedback: listNotes(db, task.id),
      resumeCommits: await commitsAhead(repo.path, forkSha, startSha),
    };
    const base = {
      cwd: worktree,
      // Every phase works in the task's own clone.
      isolated: true,
      guard: {
        worktree,
        writableDirs: [artifactsDir],
        scope: task.scope,
        // Integration branches too: only NightCrew's landing code moves them.
        protectedBranches: [...new Set([...repo.protectedBranches, ...integrationBranches(db, repo, startedAt)])],
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
          maxTokens: remainingTokens(),
          maxTurns: 80,
          guard: { ...base.guard, readOnly: true },
        },
        onEngine,
      );
      account(r);
      if (stop.aborted) return await halt("while researching");
      if (!r.ok) return await finish("failed", r.error);
      state.summary = firstSentence(r.text);
      state.verdict = "ready";
      return await finish("complete", null);
    }

    // Plan, unless the task is small enough to build directly
    const reflexes = deps.reflexes ?? new NoReflexes();
    if (!live()) return await finish("failed", gone);
    ctx.policy = policy;
    const workflow = policy.authority === "propose" ? "planned" : await chooseWorkflow(reflexes, task);
    let session: string | undefined;
    let planError: string | null = null;
    if (workflow === "planned") {
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
          maxTokens: Math.min(remainingTokens() * 0.3, Math.max(150_000, remainingTokens() * 0.2)),
          maxTurns: 40,
          guard: { ...base.guard, readOnly: true },
        },
        onEngine,
      );
      account(plan);
      // A plan cut short by a stop is not a plan to build from.
      if (stop.aborted) return await halt("while planning");
      // Build in the planner's session so what it already read stays in context.
      // Only when planner and builder are the same model; otherwise start fresh.
      session = plan.sessionId && deps.models.plan === (task.model ?? deps.models.build) ? plan.sessionId : undefined;
      if (plan.text.trim()) {
        ctx.plan = plan.text;
        artifact("plan", "PLAN.md", plan.text);
        if (!plan.ok) emit("info", `Planning stopped early (${plan.error}), but wrote enough of a plan to build from.`);
      } else {
        // The classic runner learned this the hard way: a failed plan shouldn't sink the task.
        planError = plan.error;
        emit("info", `Planning didn't finish (${plan.error ?? "no plan"}). Implementing from the brief instead.`);
        session = undefined;
      }
    } else {
      emit("info", "Small, well-specified task: building directly, without a separate planning step.");
    }

    if (!live()) return await finish("failed", gone);
    if (policy.authority === "propose") {
      state.summary = ctx.plan ? firstSentence(ctx.plan) : null;
      state.verdict = "needs_eyes";
      recordPolicy(["This route stops before implementation for your review."]);
      return await finish(
        ctx.plan ? "complete" : "failed",
        ctx.plan ? null : (planError ?? "The route now requires a plan. Dispatch again to prepare it."),
      );
    }

    // Implement
    ctx.policy = policy;
    if (stop.aborted) return await halt("before building");
    phase("implement", "Implementing");
    const ip = implementPrompt(ctx);
    const impl = await deps.engine.runPhase(
      {
        ...base,
        phase: "implement",
        prompt: session ? `${ip.prompt}\n\nYou wrote the plan above in this session. Now implement it.` : ip.prompt,
        systemPrompt: ip.system,
        model: task.model ?? deps.models.build,
        maxTokens: buildTokens(),
        maxTurns: 150,
        resumeSession: session,
      },
      onEngine,
    );
    account(impl);
    session = impl.sessionId ?? session;
    if (stop.aborted) return await halt("while building");
    if (!impl.ok) return await finish("failed", impl.error);
    state.summary = firstSentence(impl.text);

    // Validate, with one repair attempt
    phase("validate", "Checking the work");
    let check = await validate(worktree, task, repo, setupFiles, stop, forkSha, warn);
    artifact("tests", "Checks", check.log);
    if (stop.aborted) return await halt("while checking the work");
    if (!check.ok) {
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
          maxTokens: buildTokens(),
          maxTurns: 80,
          resumeSession: session,
        },
        onEngine,
      );
      account(fix);
      if (stop.aborted) return await halt("while repairing");
      phase("validate", "Checking the repair");
      check = await validate(worktree, task, repo, setupFiles, stop, forkSha, warn);
      artifact("tests", "Checks", check.log);
      if (stop.aborted) return await halt("while checking the repair");
    }
    if (check.noChanges) return await finish("failed", "The crew finished without changing anything.");
    if (!check.ok) {
      state.log = check.log;
      return await finish("failed", check.reason);
    }

    // Evidence NightCrew gathers itself
    if (!live()) return await finish("failed", gone);
    ctx.policy = policy;
    recordPolicy();
    let evidence: Evidence | null = null;
    let evidenceFiles: Map<string, string> | null = null;
    if (policy.visual || policy.regression || policy.requireTests) {
      phase("evidence", "Gathering evidence");
      if (policy.visual || policy.regression) evidenceFiles = await fingerprints(worktree, check.files);
      evidence = await gatherEvidence({
        task,
        policy,
        repo,
        worktree,
        base: forkSha,
        files: check.files,
        artifactsDir,
        branchTestsPassed: check.ok,
        log: (text) => emit("info", text),
        signal: stop,
      });
      artifact("evidence", "Evidence", JSON.stringify(evidence));
      ctx.evidence = summarizeEvidence(evidence);
      for (const m of evidence.missing) emit("info", `Missing evidence: ${m}`);
      if (stop.aborted) return await halt("while gathering evidence");
    }

    // Review: the Skeptic tries to show the work isn't done
    phase("review", "Reviewing");
    const rv = reviewPrompt(ctx);
    const review = await deps.engine.runPhase(
      {
        ...base,
        phase: "review",
        prompt: rv.prompt,
        systemPrompt: rv.system,
        model: deps.models.review,
        maxTokens: remainingTokens(),
        maxTurns: 60,
        outputSchema: REVIEW_SCHEMA as unknown as Record<string, unknown>,
      },
      onEngine,
    );
    account(review);
    if (stop.aborted) return await halt("while reviewing");
    const verdict = review.ok ? normalizeReview(review.structured) : null;
    if (verdict) {
      // Missing evidence, or a criterion unmet or never checked, means a person should look.
      const unchecked = verdict.criteria.length < task.criteria.length;
      const unmet = verdict.criteria.some((c) => !c.met);
      state.verdict =
        verdict.verdict === "ready" && !evidence?.missing.length && !unchecked && !unmet ? "ready" : "needs_eyes";
      artifact("review", "REVIEW.md", renderReview(verdict));
      if (verdict.summary) state.summary = state.summary ?? verdict.summary;
    } else {
      state.verdict = "needs_eyes";
      artifact("review", "REVIEW.md", review.text || `The review didn't finish: ${review.error ?? "unknown error"}`);
    }
    // The reviewer may have fixed small things; checks must still pass.
    const recheck = await validate(worktree, task, repo, setupFiles, stop, forkSha, warn);
    if (stop.aborted) return await halt("while rechecking after review");
    if (!recheck.ok) {
      state.log = recheck.log;
      return await finish("failed", `Checks failed after review: ${recheck.reason}`);
    }
    if (evidenceFiles && evidence) {
      const afterReview = await fingerprints(worktree, recheck.files);
      if (
        afterReview.size !== evidenceFiles.size ||
        [...afterReview].some(([file, hash]) => evidenceFiles.get(file) !== hash)
      ) {
        evidence.missing.push(
          "Files changed after evidence collection. Fresh evidence is required before automatic landing.",
        );
        state.verdict = "needs_eyes";
        artifact("evidence", "Evidence", JSON.stringify(evidence));
        ctx.evidence = summarizeEvidence(evidence);
      }
    }
    state.confidence = await scoreConfidence(reflexes, {
      task,
      review: verdict,
      evidence: ctx.evidence ?? null,
      evidenceMissing: evidence?.missing.length ?? 0,
      checksPassed: recheck.ok,
    });

    // Publish
    if (stop.aborted) return await halt("before publishing");
    phase("publish", "Committing");
    await dropSetupFiles(worktree, setupFiles, { signal: stop, warn });
    assertIntact(worktree);
    await commitInClone(worktree, `${task.title}\n\nNightCrew task ${task.id}, run ${runId}.`, { signal: stop, warn });
    assertIntact(worktree);
    // The final gate: the commit fetched into your repo, checked by your repo's git.
    const sha = await fetchTask(ws, stop);
    if (!(await git(repo.path, "merge-base", "--is-ancestor", startSha, sha)).ok)
      emit("info", "The crew rewrote the branch history this run. NightCrew checks the whole change either way.");
    // The task's whole change against the default branch, from a base worked out again from the fetched sha.
    const gateSha = await gateBase(repo.path, repo.defaultBranch, sha);
    const atGate = live();
    if (!atGate) return await finish("failed", gone);
    const gate = scopeCheck(await taskChangedFiles(repo.path, gateSha, sha), atGate.task);
    if (gate.noChanges) return await finish("failed", "The crew finished without changing anything.");
    if (!gate.ok) {
      state.log = gate.log;
      return await finish("failed", gate.reason);
    }
    const files = gate.files;
    const previous = await acceptTask(repo.path, task.id, sha);
    state.stat = await diffStat(repo.path, gateSha, sha);
    const local = await updateLocalBranch(repo.path, task.branch, sha, previous);
    if (!local.ok)
      emit(
        "info",
        `Couldn't update your ${task.branch} branch (${local.reason}). The work is at ${taskRef(task.id)}; to get it, run: git checkout -b <name> ${taskRef(task.id)}`,
      );
    const hasRemote = (await git(repo.path, "remote", "get-url", "origin")).ok;
    /** The task branch on origin, pushed from your repo by sha. */
    const pushTask = async () => {
      const p = await pushTo(repo.path, sha, task.branch);
      return p.ok ? null : lastLine(p.stderr) || "push failed";
    };

    // Land at the level the repo is at now, with the task's scope as it is now.
    const now = live();
    if (!now) return await finish("failed", gone);
    const { repo: landRepo } = now;
    let landingNote: string | null = null;
    const routeHold = (whole: string[]) => {
      const current = live();
      if (!current) return gone;
      const reasons = missingPolicyEvidence(policy, evidence, Boolean((task.testCommand ?? repo.testCommand)?.trim()));
      if (policy.authority === "propose")
        reasons.push("The route now stops at a plan; this run's work is held locally for your review.");
      const asks = whole.filter((file) => matchesAny(file, current.repo.alwaysAsk));
      if (asks.length) reasons.push(`It touches files that always wait for you: ${asks.slice(0, 4).join(", ")}.`);
      recordPolicy(reasons);
      return reasons.length ? reasons.join(" ") : null;
    };
    const hold = routeHold(files);
    if (hold) {
      landingNote = hold;
      state.verdict = "needs_eyes";
      emit("info", `Waiting for you: ${hold}`);
    }
    if (landRepo.level === "propose") return await finish("complete", landingNote);
    /** The scope check again, on the task's whole change and its scope at that moment. */
    const scopeAgain = (whole: string[]) => {
      const current = live();
      if (!current) return gone;
      const scope = scopeCheck(whole, current.task, { allowEmpty: true });
      if (!scope.ok) return scope.reason;
      const hold = routeHold(whole);
      if (hold) return hold;
      if (current.repo.level !== landRepo.level) return "The route's authority changed before landing.";
      if (landRepo.level === "ship" && current.repo.shipBranch !== landRepo.shipBranch)
        return "The ship branch changed before landing.";
      return null;
    };

    // Ship to dev: the crew merges it itself, when everything lines up.
    if (landRepo.level === "ship" && !hold) {
      const gate = canShip({
        repo: landRepo,
        files,
        verdict: state.verdict,
        evidenceMissing: evidence?.missing ?? [],
        confidence: state.confidence,
      });
      if (gate.ok) {
        const shipBranch = landRepo.shipBranch as string;
        phase("publish", `Shipping to ${shipBranch}`);
        const pushFailed = deps.publish && hasRemote ? await pushTask() : null;
        const shipped = pushFailed
          ? { ok: false as const, error: `Couldn't push ${task.branch}: ${pushFailed}` }
          : await shipTask(landRepo, sha, task.title, deps.publish, {
              base: gateSha,
              files,
              earlier: () => earlierLandings(db, landRepo, task, { ship: shipBranch }, fresh(ws.dir)),
              // Checked again, on the task's whole change and the repo's settings at that moment, before the merge stays.
              recheck: (whole) => {
                const scope = scopeAgain(whole);
                if (scope) return scope;
                const again = canShip({
                  repo: live()?.repo ?? { ...landRepo, level: "draft_pr" },
                  files: whole,
                  verdict: state.verdict,
                  evidenceMissing: evidence?.missing ?? [],
                  confidence: state.confidence,
                });
                return again.ok ? null : again.reasons.join(" ");
              },
            });
        if (shipped.ok) {
          markShipped(db, runId, shipped.sha, shipBranch);
          emit("info", `Shipped to ${shipBranch} (${shipped.sha.slice(0, 7)}). Undo is one key in the Station.`);
          return await finish("complete", null);
        }
        landingNote = `Didn't ship: ${shipped.error.split("\n")[0]} The change needs your review.`;
        emit("info", landingNote);
        state.verdict = "needs_eyes";
      } else {
        landingNote = `Waiting for you instead of shipping: ${gate.reasons.join(" ")}`;
        recordPolicy(gate.reasons);
        emit("info", landingNote);
      }
    }

    // Daily train: board today's integration branch; you merge one PR for the lot.
    if (landRepo.level === "train" && !hold && state.verdict === "ready") {
      phase("publish", "Boarding today's train");
      const nightId = nightIdFor(startedAt);
      const train =
        getOpenTrain(db, repo.id, nightId) ??
        createTrain(db, { repoId: repo.id, nightId, branch: trainBranch(nightId) });
      const pushFailed = deps.publish && hasRemote ? await pushTask() : null;
      const boarded = pushFailed
        ? { ok: false as const, error: `Couldn't push ${task.branch}: ${pushFailed}` }
        : await boardTrain(landRepo, train, sha, task.title, deps.publish, {
            base: gateSha,
            files,
            earlier: () => earlierLandings(db, landRepo, task, { trainId: train.id }, fresh(ws.dir)),
            recheck: scopeAgain,
          });
      if (boarded.ok) {
        addCar(db, train.id, { runId, taskId: task.id, title: task.title, mergeSha: boarded.sha, state: "on" });
        setRunTrain(db, runId, train.id);
        emit(
          "info",
          `On today's train (${train.branch}). Its PR opens or refreshes once no other agent is working in this repo.`,
        );
        return await finish("complete", null);
      }
      addCar(db, train.id, { runId, taskId: task.id, title: task.title, mergeSha: "", state: "broke" });
      landingNote = `Couldn't board the train: ${boarded.error.split("\n")[0]} The change needs its own review.`;
      emit("info", landingNote);
      state.verdict = "needs_eyes";
    }

    // Integration checks may have observed a stricter route. Recheck before the draft fallback, too.
    const beforeDraft = live();
    if (!beforeDraft) return await finish("failed", gone);
    const finalHold = routeHold(files);
    if (finalHold) {
      landingNote = finalHold;
      state.verdict = "needs_eyes";
    }
    if (beforeDraft.repo.level === "propose") return await finish("complete", landingNote);
    if (deps.publish) {
      if (!hasRemote) {
        emit(
          "info",
          local.ok
            ? `No GitHub remote, so the work stays local, on your ${task.branch} branch.`
            : `No GitHub remote, so the work stays local, at ${taskRef(task.id)}.`,
        );
      } else {
        if (stop.aborted) return await halt("before opening the PR");
        phase("publish", "Pushing and opening a draft PR");
        const pushFailed = await pushTask();
        if (pushFailed) return await finish("failed", `Push failed: ${pushFailed}`);
        const pr = await openOrUpdatePr(
          repo.path,
          {
            branch: task.branch,
            base: repo.defaultBranch,
            title: task.title,
            body: prBody({
              task,
              summary: state.summary,
              verdict,
              plan: ctx.plan ?? null,
              evidence: ctx.evidence ?? null,
              checks: check.log,
              tokens: used(),
              runId,
            }),
          },
          { signal: stop },
        );
        state.prUrl = pr.url;
        state.prNumber = pr.number;
        emit("info", `Opened draft PR #${pr.number}`);
        if (pr.warning) emit("info", pr.warning);
      }
    }
    recordPolicy(landingNote ? [landingNote] : []);
    return await finish("complete", landingNote);
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

/**
 * NightCrew's own checks between agent phases, independent of what the agent
 * claims. The file list comes from the clone, so it's advisory; the final
 * gate repeats the scope check on the commit fetched into your repo.
 */
export async function validate(
  worktree: string,
  task: Task,
  repo: Repo,
  setupFiles: Map<string, string> = new Map(),
  signal?: AbortSignal,
  /** The pinned fork point; the default branch's name only when there's none. */
  base: string = repo.defaultBranch,
  warn?: (text: string) => void,
): Promise<CheckResult> {
  assertIntact(worktree);
  const fromSetup = await untouchedSetupFiles(worktree, setupFiles);
  const listed = await cloneChangedFiles(worktree, base, { signal, warn });
  const scope = scopeCheck(
    listed.filter((f) => !fromSetup.has(f)),
    task,
  );
  if (!scope.ok) return scope;

  const lines = [scope.log];
  const cmd = task.testCommand ?? repo.testCommand;
  if (cmd) {
    const t = await runCheck(cmd, worktree, {
      timeoutMs: 15 * 60_000,
      signal,
      warn,
      clone: true,
      objects: await cloneObjects(worktree),
    });
    const out = `${t.stdout}\n${t.stderr}`.trim();
    lines.push("", `$ ${cmd}  (exit ${t.code})`, out.length > 8000 ? `…\n${out.slice(-8000)}` : out);
    if (!t.ok)
      return {
        ok: false,
        noChanges: false,
        reason: `\`${cmd}\` failed (exit ${t.code}).`,
        log: lines.join("\n"),
        files: scope.files,
      };
  } else {
    lines.push("", "No test command configured for this repo.");
  }
  return { ok: true, noChanges: false, reason: null, log: lines.join("\n"), files: scope.files };
}

/** Where NightCrew keeps its own checkouts in your repo. No task may commit there. */
const NIGHTCREW_PATHS = [".worktrees", ".worktrees/**"];

/** Changed files against the task's scope and the paths no task may touch. */
export function scopeCheck(changed: string[], task: Task, o: { allowEmpty?: boolean } = {}): CheckResult {
  const files = [...changed];
  const lines: string[] = [`Changed files (${files.length}):`, ...files.map((f) => `  ${f}`)];
  if (files.length === 0 && !o.allowEmpty)
    return { ok: false, noChanges: true, reason: "No files changed.", log: lines.join("\n"), files };
  const refuse = (reason: string, line = reason) => {
    lines.push("", line);
    return { ok: false, noChanges: false, reason, log: lines.join("\n"), files };
  };
  const ours = files.filter((f) => matchesAny(f, NIGHTCREW_PATHS, true));
  if (ours.length)
    return refuse(`Changed files in .worktrees, where NightCrew keeps its own checkouts: ${ours.join(", ")}`);
  const protectedFiles = files.filter((f) => isAlwaysProtected(f));
  if (protectedFiles.length) {
    const many = protectedFiles.length > 1;
    return refuse(
      `${protectedFiles.join(", ")} ${many ? "are" : "is"} always protected (workflows, secrets and git settings NightCrew won't land); take ${many ? "them" : "it"} out of the change.`,
    );
  }
  const outOfScope = files.filter((f) => task.scope.length > 0 && !matchesAny(f, task.scope));
  if (outOfScope.length)
    return refuse(
      `Changed files outside scope: ${outOfScope.join(", ")}`,
      `Outside the task's scope: ${outOfScope.join(", ")}`,
    );
  return { ok: true, noChanges: false, reason: null, log: lines.join("\n"), files };
}

const SHA = /^[0-9a-f]{40,64}$/;

/**
 * Where a task's work forks from the default branch: the merge base of its
 * tip and your default branch (local, or origin's copy, whichever has more of
 * it). Always a default-branch commit, so the crew can only move it to
 * another one, and moving it back only makes its own diff bigger. A merge of
 * the task into the default branch, or of the default branch into the task,
 * moves it forward; the diff stays the task's own. `tip` null is a task that
 * hasn't started: the default branch itself.
 */
export async function gateBase(repoPath: string, defaultBranch: string, tip: string | null): Promise<string> {
  const refs = [`refs/heads/${defaultBranch}`, `refs/remotes/origin/${defaultBranch}`];
  const found: string[] = [];
  for (const ref of refs) {
    const at = await resolveSha(repoPath, ref);
    if (!at) continue;
    if (!tip) found.push(at);
    else {
      const mb = await git(repoPath, "merge-base", ref, tip);
      if (mb.ok && SHA.test(mb.stdout.trim())) found.push(mb.stdout.trim());
    }
  }
  const [first, second] = found;
  if (!first) {
    throw new Error(
      tip
        ? `The task's work shares no history with ${defaultBranch}, so NightCrew won't trust its diff.`
        : `Couldn't find ${defaultBranch} in ${repoPath} to start the task from.`,
    );
  }
  // Origin's copy wins only when it has everything your local one does.
  if (second && second !== first && (await git(repoPath, "merge-base", "--is-ancestor", first, second)).ok)
    return second;
  return first;
}

/** Stop when the task's clone no longer has its own .git folder: its git would act on whatever that points at. */
function assertIntact(dir: string) {
  if (!cloneIntact(dir)) throw new Error(TAMPERED);
}

const taskRuns = (db: Db, taskId: string) =>
  db.query.runs.findMany({ where: (r, { eq }) => eq(r.taskId, taskId) }).sync();

/** The task's tip a landing merge brought in: NightCrew lands by --no-ff merge, the tip its second parent. */
const landedTip = (repoPath: string, merge: string) => (SHA.test(merge) ? resolveSha(repoPath, `${merge}^2`) : null);

/**
 * This task's earlier tips that were landed and then taken off, from
 * NightCrew's records: cars pulled from any of the repo's trains (earlier
 * days too) and ships undone on any branch.
 */
async function takenOffLandings(db: Db, repo: Repo, task: Task): Promise<TakenOff[]> {
  const merges = [
    ...listTrains(db)
      .filter((t) => t.repoId === repo.id)
      .flatMap((t) =>
        t.cars
          .filter((c) => c.taskId === task.id && c.state === "pulled" && c.mergeSha)
          .map((c) => ({ merge: c.mergeSha, branch: t.branch })),
      ),
    ...taskRuns(db, task.id)
      .filter((r) => r.shipSha && r.undoneAt)
      .map((r) => ({ merge: r.shipSha as string, branch: r.shipBranch ?? "the ship branch" })),
  ];
  const out: TakenOff[] = [];
  for (const m of merges) {
    const tip = await landedTip(repo.path, m.merge);
    if (tip) out.push({ tip, ...m });
  }
  return out;
}

/**
 * This task's earlier landings, read fresh from NightCrew's records (the
 * landing code calls this inside the repo lock): tips still on this lane
 * (train cars on, ships not undone) and every tip taken off since.
 */
async function earlierLandings(
  db: Db,
  repo: Repo,
  task: Task,
  lane: { trainId: string } | { ship: string },
  restart: string,
): Promise<Earlier> {
  const merges =
    "trainId" in lane
      ? (getTrain(db, lane.trainId)?.cars ?? [])
          .filter((c) => c.taskId === task.id && c.state === "on" && c.mergeSha)
          .map((c) => c.mergeSha)
      : taskRuns(db, task.id)
          .filter((r) => r.shipBranch === lane.ship && r.shipSha && !r.undoneAt)
          .map((r) => r.shipSha as string);
  const landed: string[] = [];
  for (const m of merges) {
    const tip = await landedTip(repo.path, m);
    if (tip) landed.push(tip);
  }
  return { landed, takenOff: await takenOffLandings(db, repo, task), restart };
}

/** The repo's ship branch and its train branches: tasks may never move them. */
function integrationBranches(db: Db, repo: Repo, startedAt: string): string[] {
  const trains = listTrains(db)
    .filter((t) => t.repoId === repo.id && (t.status === "open" || t.status === "published"))
    .map((t) => t.branch);
  return [...(repo.shipBranch ? [repo.shipBranch] : []), trainBranch(nightIdFor(startedAt)), ...trains];
}

const VERDICTS = new Set(["ready", "needs_eyes", "not_done"]);

/**
 * The reviewer's answer, shape-checked. Managed mode hands over whatever JSON
 * object it last saw, so anything malformed is dropped rather than trusted.
 */
export function normalizeReview(raw: unknown): ReviewOutput | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.verdict !== "string" || !VERDICTS.has(r.verdict)) return null;
  const list = (v: unknown) =>
    (Array.isArray(v) ? v : []).filter((x) => x && typeof x === "object") as Record<string, unknown>[];
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    verdict: r.verdict as ReviewOutput["verdict"],
    summary: str(r.summary),
    criteria: list(r.criteria)
      .filter((c) => typeof c.criterion === "string" && typeof c.met === "boolean")
      .map((c) => ({ criterion: c.criterion as string, met: c.met as boolean, evidence: str(c.evidence) })),
    concerns: (Array.isArray(r.concerns) ? r.concerns : []).filter((c): c is string => typeof c === "string"),
    challenges: list(r.challenges)
      .filter((c) => typeof c.challenge === "string" && typeof c.held === "boolean")
      .map((c) => ({ challenge: c.challenge as string, held: c.held as boolean, detail: str(c.detail) })),
    report: str(r.report),
  };
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
  evidence: string | null;
  checks: string;
  tokens: number;
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

${input.evidence ? `### Evidence\n${input.evidence}\n` : ""}
${
  verdict?.challenges?.length
    ? `### Skeptic\n${verdict.challenges.filter((c) => !c.held).length} of ${verdict.challenges.length} challenges failed to find a problem.${
        verdict.challenges.some((c) => c.held)
          ? `\n${verdict.challenges
              .filter((c) => c.held)
              .map((c) => `- Held: ${c.challenge}: ${c.detail}`)
              .join("\n")}`
          : ""
      }\n`
    : ""
}
${verdict?.concerns.length ? `### Reviewer concerns\n${verdict.concerns.map((c) => `- ${c}`).join("\n")}\n` : ""}
${details("Plan", input.plan)}${details("Review", verdict?.report ?? null)}${details("Checks", `\`\`\`\n${input.checks.slice(-4000)}\n\`\`\``)}
${task.sourceRef?.match(/\/issues\/(\d+)$/) ? `Closes #${task.sourceRef.match(/\/issues\/(\d+)$/)?.[1]}\n\n` : ""}---
Made by [NightCrew](https://github.com/oluoyefeso/nightcrew) · run \`${input.runId}\` · ${formatTokens(input.tokens)} tokens`;
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
