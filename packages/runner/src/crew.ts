// The crew: a dispatcher that keeps agents working around the clock. Queued
// tasks start as soon as a slot is free (within the per-repo and total
// limits and the daily budget); scheduled tasks wait for their time. Each
// agent reports back when it finishes.

import {
  closeSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  type DepartureReport,
  type DepartureTask,
  departureChecks,
  formatTokens,
  MISSION_STOP_REASON,
  missionStopTime,
  nightIdFor,
  planQueue,
  type QueueEntry,
  type Repo,
  scopesMayOverlap,
  type Task,
} from "@nightcrew/core";
import {
  auditEvent,
  type Db,
  getDispatchBackoff,
  getMission,
  getRepo,
  getRun,
  getSettings,
  getTask,
  getTrain,
  interruptRun,
  listRepos,
  listTasks,
  listTrains,
  missionTokens,
  type RunEvent,
  recoverDeliveries,
  recoverOperationJobs,
  saveDispatchBackoff,
  tokensOnDay,
  updateTask,
  updateTrain,
} from "@nightcrew/db";
import { type AgentEngine, taskEngineError } from "./engine";
import { publishTrain } from "./landing";
import { waitForOperations } from "./operation-progress";
import { automaticDelivery, stopOperations } from "./operations";
import { runTask, type TaskOutcome } from "./pipeline";
import { classifyFailure, NoReflexes, type Reflexes } from "./reflexes";
import { materializeRoutines } from "./routines";

export interface ActiveAgent {
  taskId: string;
  runId: string | null;
  title: string;
  repoId: string;
  repoName: string;
  phase: string | null;
  startedAt: string;
  lastEvent: string | null;
}

export interface CrewStatus {
  /** working: agents running. idle: nothing to do. paused: you paused dispatch. waiting: backing off. */
  state: "working" | "idle" | "paused" | "waiting";
  active: ActiveAgent[];
  queued: number;
  scheduled: number;
  /** Next scheduled start, if any. */
  nextAt: string | null;
  tokensToday: number;
  dailyTokenBudget: number;
  maxAgents: number;
  message: string | null;
  engine: string;
}

export type CrewEvent =
  | { type: "status"; status: CrewStatus }
  | { type: "run_event"; event: RunEvent }
  | { type: "report"; outcome: TaskOutcome & { title: string; taskId: string } };

const RATE_LIMIT_WAITS_MS = [5, 10, 20].map((m) => m * 60_000);
const TICK_MS = 15_000;
const CRASH_RETRY_MS = 10 * 60_000;

interface Running {
  agent: ActiveAgent;
  abort: AbortController;
  done: Promise<void>;
  missionId: string | null;
  stopAt: number | null;
  stopTimer: ReturnType<typeof setTimeout> | null;
}

export class Crew {
  private running = new Map<string, Running>();
  private listeners = new Set<(e: CrewEvent) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private pausedUntil = 0;
  private rateLimitStrikes = 0;
  private message: string | null = null;
  private pumping = false;
  private halted = false;

  constructor(
    private readonly deps: {
      db: Db;
      engine: AgentEngine;
      dataDir: string;
      publish: boolean;
      reflexes?: Reflexes;
    },
  ) {
    const backoff = getDispatchBackoff(deps.db);
    this.pausedUntil = backoff.until;
    this.rateLimitStrikes = backoff.strikes;
    if (this.pausedUntil > Date.now())
      this.message = "Rate limited. Waiting for the saved cooldown before dispatch resumes.";
  }

  /**
   * Put tasks left "running" by a crash back in the queue. Only the process
   * that dispatches (holding the crew lock) may call this; any other process
   * would steal tasks a live dispatcher is running.
   */
  recover(): number {
    recoverDeliveries(this.deps.db);
    recoverOperationJobs(this.deps.db);
    const orphans = listTasks(this.deps.db, ["running"]);
    for (const t of orphans) {
      const retries = t.autoRetries ?? 0;
      if (t.lastRunId)
        interruptRun(
          this.deps.db,
          t.lastRunId,
          retries < 2
            ? "Runner interrupted. Recovery queued from the last compatible checkpoint."
            : "Recovery limit reached after repeated interruptions. Review the saved work and resume explicitly.",
        );
      updateTask(this.deps.db, t.id, { status: retries < 2 ? "queued" : "done", autoRetries: retries + 1 });
      auditEvent(this.deps.db, "crew", retries < 2 ? "recovery.queued" : "recovery.exhausted", t.id);
    }
    return orphans.length;
  }

  subscribe(fn: (e: CrewEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getStatus(): CrewStatus {
    const { db } = this.deps;
    const s = getSettings(db);
    const queuedTasks = listTasks(db, ["queued"]);
    const now = Date.now();
    const scheduled = queuedTasks.filter((t) => t.runAt && new Date(t.runAt).getTime() > now);
    const nextAt = scheduled.map((t) => t.runAt as string).sort()[0] ?? null;
    const active = [...this.running.values()].map((r) => r.agent);
    const state: CrewStatus["state"] = !s.dispatch
      ? "paused"
      : this.pausedUntil > now
        ? "waiting"
        : active.length
          ? "working"
          : "idle";
    return {
      state,
      active,
      queued: queuedTasks.length - scheduled.length,
      scheduled: scheduled.length,
      nextAt,
      tokensToday: tokensOnDay(db, nightIdFor(new Date().toISOString())),
      dailyTokenBudget: s.dailyTokenBudget,
      maxAgents: s.maxAgents,
      message: this.message,
      engine: this.deps.engine.name,
    };
  }

  /** Explain queued work using the same dependency checks and budgets as dispatch. */
  getQueue(): QueueEntry[] {
    const { db } = this.deps;
    const settings = getSettings(db);
    const all = listTasks(db);
    const byId = new Map(all.map((t) => [t.id, t]));
    const now = Date.now();
    const used = tokensOnDay(db, nightIdFor(new Date(now).toISOString())) + this.inFlightBudget();
    return this.prioritized(all)
      .filter((t) => t.status === "queued")
      .map((task): QueueEntry => {
        const entry = { taskId: task.id, title: task.title, repoName: task.repoName, runAt: task.runAt };
        const holds = this.departure(task, getRepo(db, task.repoId)).signals.filter((s) => s.kind === "hold");
        if (holds.length) return { ...entry, kind: "setup", reason: holds.map((s) => s.message).join(" ") };
        const mission = task.missionId ? getMission(db, task.missionId) : null;
        if (mission?.paused)
          return { ...entry, kind: "paused", reason: `Mission paused: ${mission.title}. Resume it from Missions.` };
        const missionHold = this.missionHold(task);
        if (missionHold) return { ...entry, ...missionHold };
        const waiting = task.dependsOn.filter((id) => !byId.has(id) || !this.satisfied(byId.get(id) as Task));
        if (waiting.length)
          return {
            ...entry,
            kind: "dependency",
            reason: `Waiting for ${waiting.map((id) => byId.get(id)?.title ?? "a missing dependency").join(", ")}.`,
          };
        if (task.runAt && Date.parse(task.runAt) > now)
          return { ...entry, kind: "scheduled", reason: "Waiting for its scheduled departure." };
        if (!settings.dispatch)
          return { ...entry, kind: "paused", reason: "Dispatch is paused. Resume it to start queued work." };
        if (this.pausedUntil > now)
          return {
            ...entry,
            kind: "backoff",
            reason: this.message ?? "Waiting for the provider's rate limit to clear.",
          };
        if (used + task.tokenBudget > settings.dailyTokenBudget)
          return {
            ...entry,
            kind: "budget",
            reason: `Needs room for ${formatTokens(task.tokenBudget)} tokens within the daily budget, including running agents' reservations.`,
          };
        const inRepo = [...this.running.values()].filter((r) => r.agent.repoId === task.repoId).length;
        if (inRepo >= settings.maxPerRepo)
          return { ...entry, kind: "capacity", reason: "Waiting for an agent slot in this repo." };
        if (this.running.size >= settings.maxAgents)
          return { ...entry, kind: "capacity", reason: "Waiting for an agent slot across the crew." };
        return {
          ...entry,
          kind: "ready",
          reason: `Ready by mission priority, start deadline, then queue order${mission ? ` (priority ${mission.priority})` : ""}.`,
        };
      });
  }

  /** Read-only preview of unsaved drafts or saved tasks, against current reservations and dependencies. */
  preflight(candidates: DepartureTask[]): DepartureReport {
    const { db } = this.deps;
    const settings = getSettings(db);
    const existing = listTasks(db);
    const repos = new Map(listRepos(db).map((repo) => [repo.id, repo]));
    const byId = new Map(existing.map((t) => [t.id, t]));
    const proposed = new Map(candidates.map((t) => [t.id, t]));
    const all = new Map<string, DepartureTask>([...byId, ...proposed]);
    const used = tokensOnDay(db, nightIdFor(new Date().toISOString()));
    const reserved = this.inFlightBudget();
    const available = Math.max(0, settings.dailyTokenBudget - used - reserved);
    const peers = [...all.values()].filter(
      (t) => proposed.has(t.id) || ["queued", "running"].includes(byId.get(t.id)?.status ?? ""),
    );
    const reaches = (from: string, target: string, seen = new Set<string>()): boolean => {
      if (from === target) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return (all.get(from)?.dependsOn ?? []).some((id) => reaches(id, target, seen));
    };
    return {
      budget: {
        daily: settings.dailyTokenBudget,
        used,
        reserved,
        available,
        requested: candidates.reduce((sum, t) => sum + t.tokenBudget, 0),
      },
      tasks: candidates.map((task) => {
        const check = this.departure(task, repos.get(task.repoId) ?? null);
        const mission = task.missionId ? getMission(db, task.missionId) : null;
        if (task.missionId && !mission)
          check.signals.push({
            code: "mission-missing",
            kind: "hold",
            message: "This mission no longer exists. Choose another mission or leave the task unassigned.",
            target: "task",
          });
        if (mission?.paused)
          check.signals.push({
            code: "mission-paused",
            kind: "wait",
            message: `Mission paused: ${mission.title}. Resume it to allow new starts.`,
            target: "mission",
            missionId: mission.id,
          });
        if (mission) {
          const held = this.missionHold(task);
          if (held)
            check.signals.push({
              code: "mission-limit",
              kind: "wait",
              message: held.reason,
              target: "mission",
              missionId: mission.id,
            });
          const requested = candidates.filter((t) => t.missionId === mission.id).reduce((n, t) => n + t.tokenBudget, 0);
          if (mission.tokenBudget !== null && requested > this.missionAvailable(mission.id, mission.tokenBudget))
            check.signals.push({
              code: "mission-batch-budget",
              kind: "notice",
              message:
                "This batch's combined caps exceed the mission's available tokens. Later tasks may wait for budget.",
              target: "mission",
              missionId: mission.id,
            });
        }
        const add = (
          code: string,
          kind: "hold" | "wait" | "notice",
          message: string,
          target: "settings" | "task",
          taskId?: string,
        ) => check.signals.push({ code, kind, message, target, taskId });
        for (const id of task.dependsOn) {
          const dep = all.get(id);
          if (!dep) add("dependency-missing", "hold", "A prerequisite no longer exists. Remove or replace it.", "task");
          else if (reaches(id, task.id))
            add(
              "dependency-cycle",
              "hold",
              `A dependency cycle includes ${dep.title}. Remove the circular dependency.`,
              "task",
            );
          else if (proposed.has(id) || !byId.has(id) || !this.satisfied(byId.get(id)!))
            add(
              "dependency",
              "wait",
              `Waiting for ${dep.title} to finish successfully.`,
              "task",
              byId.has(id) ? id : undefined,
            );
        }
        if (!settings.dispatch)
          add("paused", "wait", "Dispatch is paused. Resume it from the crew controls.", "settings");
        if (task.runAt && Date.parse(task.runAt) > Date.now())
          add("scheduled", "wait", "Waiting for its scheduled departure.", "task");
        if (this.pausedUntil > Date.now())
          add("backoff", "wait", this.message ?? "Waiting for the provider's rate limit to clear.", "task");
        if (task.tokenBudget > settings.dailyTokenBudget)
          add(
            "budget-limit",
            "hold",
            "This task's token cap exceeds the daily budget. Lower the cap or raise the daily budget.",
            "settings",
          );
        else if (task.tokenBudget > available)
          add(
            "budget",
            "wait",
            "The daily budget has insufficient room after usage and running reservations.",
            "settings",
          );
        const inRepo = [...this.running.values()].filter((r) => r.agent.repoId === task.repoId).length;
        if (this.running.size >= settings.maxAgents || inRepo >= settings.maxPerRepo)
          add("capacity", "wait", "Waiting for an agent slot within the crew and repository limits.", "settings");
        if (check.route?.authority !== "propose") {
          const overlaps = peers.filter(
            (other) =>
              other.id !== task.id &&
              other.repoId === task.repoId &&
              !reaches(task.id, other.id) &&
              !reaches(other.id, task.id) &&
              departureChecks(other, repos.get(other.repoId) ?? null).route?.authority !== "propose" &&
              scopesMayOverlap(task.scope, other.scope),
          );
          if (overlaps.length)
            add(
              "overlap",
              "notice",
              `Scope may overlap with ${overlaps.map((t) => t.title).join(", ")}. Consider a dependency or narrower scope; separate clones do not prevent merge conflicts.`,
              "task",
              byId.has(overlaps[0]!.id) ? overlaps[0]!.id : undefined,
            );
        }
        check.signals = check.signals.filter(
          (signal, index, signals) =>
            signals.findIndex(
              (other) =>
                other.code === signal.code && other.taskId === signal.taskId && other.message === signal.message,
            ) === index,
        );
        return check;
      }),
    };
  }

  /** Start the dispatcher: check for work now and every few seconds. */
  startSchedule() {
    this.timer ??= setInterval(() => {
      void this.pump();
      if (this.deps.publish && getSettings(this.deps.db).dispatch && !this.halted)
        for (const repo of listRepos(this.deps.db))
          if (![...this.running.values()].some((r) => r.agent.repoId === repo.id))
            void automaticDelivery(this.deps.db, repo.id, this.deps.dataDir).catch(() => {});
    }, TICK_MS);
    void this.pump();
  }

  stopSchedule() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Fill free agent slots with the next runnable tasks. Safe to call any
   * time: when a task is added, when an agent finishes, on the timer.
   */
  async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      const { db } = this.deps;
      for (const running of this.running.values()) this.refreshMissionStop(running);
      materializeRoutines(db);
      const s = getSettings(db);
      if (this.halted || !s.dispatch || this.pausedUntil > Date.now()) return this.emitStatus();

      // A task whose budget is above the whole daily budget can never start:
      // step past it so it doesn't hold up everything behind it.
      const tooBig = new Set<string>();
      let tooBigNote: string | null = null;
      let holdNote: string | null = null;
      for (;;) {
        if (this.running.size >= s.maxAgents) break;
        const next = this.nextRunnable(s.maxPerRepo, tooBig);
        if (!next) break;
        if (next.tokenBudget > s.dailyTokenBudget) {
          tooBig.add(next.id);
          tooBigNote ??= `"${next.title}" needs a bigger daily budget than ${formatTokens(s.dailyTokenBudget)} tokens; raise one of them.`;
          continue;
        }
        const used = tokensOnDay(db, nightIdFor(new Date().toISOString())) + this.inFlightBudget();
        if (used + next.tokenBudget > s.dailyTokenBudget) {
          holdNote = `Holding "${next.title}": it could take today past the ${formatTokens(s.dailyTokenBudget)}-token budget.`;
          tooBig.add(next.id);
          continue;
        }
        this.launch(next.id);
      }
      if (tooBigNote || holdNote) this.message = [tooBigNote, holdNote].filter(Boolean).join(" ");
      this.emitStatus();
    } finally {
      this.pumping = false;
    }
  }

  /** The highest-priority queued task that can start now. */
  private nextRunnable(maxPerRepo: number, skip: ReadonlySet<string> = new Set()) {
    const { db } = this.deps;
    const all = listTasks(db);
    const byId = new Map(all.map((t) => [t.id, t]));
    const now = Date.now();
    const perRepo = new Map<string, number>();
    for (const r of this.running.values()) perRepo.set(r.agent.repoId, (perRepo.get(r.agent.repoId) ?? 0) + 1);
    for (const id of planQueue(this.prioritized(all).map((task, position) => ({ ...task, position }))).order) {
      const t = byId.get(id);
      if (!t || this.running.has(id) || skip.has(id)) continue;
      if (t.missionId && getMission(db, t.missionId)?.paused) continue;
      if (this.missionHold(t)) continue;
      if (this.departure(t, getRepo(db, t.repoId)).signals.some((s) => s.kind === "hold")) continue;
      if (t.runAt && new Date(t.runAt).getTime() > now) continue;
      // Dependencies must have finished and succeeded, not just started or stopped.
      if (t.dependsOn.some((d) => byId.has(d) && !this.satisfied(byId.get(d) as Task))) continue;
      if ((perRepo.get(t.repoId) ?? 0) >= maxPerRepo) continue;
      return t;
    }
    return null;
  }

  private departure(task: DepartureTask, repo: Repo | null) {
    const check = departureChecks(task, repo);
    const error = check.route ? taskEngineError(this.deps.engine, task, check.route.authority) : null;
    if (error) check.signals.push({ code: "engine-capability", kind: "hold", target: "settings", message: error });
    return check;
  }

  /**
   * A dependency counts as met when its latest run completed and wasn't dismissed.
   * In a repo that lands work itself (train or ship), its work
   * is still landed (car on, ship not undone) or went to a PR. A failed or
   * timed-out run, or a pulled or undone landing, keeps dependents waiting.
   */
  private satisfied(dep: Task): boolean {
    const { db } = this.deps;
    if ((dep.status !== "done" && dep.status !== "archived") || !dep.lastRunId) return false;
    const run = getRun(db, dep.lastRunId)?.run;
    if (run?.status !== "complete") return false;
    if (run.triage === "close" || run.prState === "closed") return false;
    if (dep.type === "research") return true;
    // Finished runs clear their live phase. A proposal has a plan, but never reaches code checks.
    if (run.artifactKinds.includes("plan") && !run.artifactKinds.includes("tests")) return false;
    const level = getRepo(db, dep.repoId)?.level;
    if (level !== "train" && level !== "ship") return true;
    if (run.prUrl || (run.shipSha && !run.undoneAt)) return true;
    if (!run.trainId) return false;
    return getTrain(db, run.trainId)?.cars.some((c) => c.runId === run.id && c.state === "on") ?? false;
  }

  private prioritized(tasks: Task[]): Task[] {
    return [...tasks].sort((a, b) => {
      const am = a.missionId ? getMission(this.deps.db, a.missionId) : null;
      const bm = b.missionId ? getMission(this.deps.db, b.missionId) : null;
      return (
        (bm?.priority ?? 0) - (am?.priority ?? 0) ||
        (am?.deadline ? Date.parse(am.deadline) : Infinity) - (bm?.deadline ? Date.parse(bm.deadline) : Infinity) ||
        a.position - b.position
      );
    });
  }

  private missionAvailable(id: string, budget: number): number {
    let reserved = 0;
    for (const task of listTasks(this.deps.db, ["running"])) {
      if (task.missionId !== id) continue;
      const run = task.lastRunId ? getRun(this.deps.db, task.lastRunId)?.run : null;
      const used = run?.status === "running" ? run.tokensIn + run.tokensOut : 0;
      reserved += Math.max(0, task.tokenBudget - used);
    }
    return Math.max(0, budget - missionTokens(this.deps.db, id) - reserved);
  }

  private missionHold(task: DepartureTask): { kind: "deadline" | "budget"; reason: string } | null {
    const mission = task.missionId ? getMission(this.deps.db, task.missionId) : null;
    if (!mission) return null;
    const stopAt = missionStopTime(mission.stopAt);
    if (stopAt !== null && stopAt <= Date.now())
      return {
        kind: "deadline",
        reason: "The mission stop deadline has passed. Extend or clear it to dispatch more work.",
      };
    if (mission.deadline && Date.parse(mission.deadline) <= Date.now())
      return { kind: "deadline", reason: "The mission's start deadline has passed. Extend it to dispatch more work." };
    if (mission.tokenBudget !== null && task.tokenBudget > this.missionAvailable(mission.id, mission.tokenBudget))
      return {
        kind: "budget",
        reason:
          "Mission budget has insufficient room after recorded usage and running reservations. Raise its limit or lower this task's cap.",
      };
    return null;
  }

  private inFlightBudget(): number {
    let n = 0;
    for (const r of this.running.values()) n += getTask(this.deps.db, r.agent.taskId)?.tokenBudget ?? 0;
    return n;
  }

  /** Tightening applies immediately, including while dispatch is paused or cooling down. */
  private refreshMissionStop(running: Running) {
    if (running.abort.signal.aborted) return;
    const mission = running.missionId ? getMission(this.deps.db, running.missionId) : null;
    const latest = missionStopTime(mission?.stopAt);
    const earliest = latest === null ? running.stopAt : Math.min(running.stopAt ?? Infinity, latest);
    if (earliest === null) return;
    if (earliest === running.stopAt && running.stopTimer && earliest > Date.now()) return;
    if (running.stopTimer) clearTimeout(running.stopTimer);
    running.stopAt = earliest;
    running.stopTimer = null;
    if (earliest <= Date.now()) {
      auditEvent(this.deps.db, "crew", "mission.stop", running.agent.taskId, MISSION_STOP_REASON);
      running.abort.abort(new DOMException(MISSION_STOP_REASON, "TimeoutError"));
      return;
    }
    running.stopTimer = setTimeout(
      () => {
        running.stopTimer = null;
        this.refreshMissionStop(running);
      },
      Math.min(earliest - Date.now(), 2_147_483_647),
    );
  }

  private launch(taskId: string) {
    const { db } = this.deps;
    const task = getTask(db, taskId);
    if (!task) return;
    const s = getSettings(db);
    const abort = new AbortController();
    const agent: ActiveAgent = {
      taskId,
      runId: null,
      title: task.title,
      repoId: task.repoId,
      repoName: task.repoName,
      phase: "setup",
      startedAt: new Date().toISOString(),
      lastEvent: null,
    };
    // Mark it running before the first await so the next pump skips it.
    updateTask(db, taskId, { status: "running" });
    const done = runTask(
      {
        db,
        engine: this.deps.engine,
        dataDir: this.deps.dataDir,
        models: { plan: s.planModel, build: s.buildModel, review: s.reviewModel },
        publish: this.deps.publish,
        reflexes: this.deps.reflexes ?? new NoReflexes(),
        onEvent: (event) => {
          agent.runId = event.runId;
          if (event.kind === "phase") agent.phase = event.phase;
          if (event.kind !== "text") agent.lastEvent = event.text;
          this.emit({ type: "run_event", event });
          if (event.kind === "phase") this.emitStatus();
        },
      },
      taskId,
      abort.signal,
    )
      .then((outcome) => this.finished(task.id, task.title, task.repoId, outcome))
      .catch((e) => {
        // A crash must not strand the task in "running". It waits a while
        // before the next try so a task that always crashes can't spin.
        const current = getTask(db, taskId);
        const requeued = current?.status === "running" && (current.autoRetries ?? 0) < 2;
        if (requeued) {
          const runAt = new Date(Date.now() + CRASH_RETRY_MS).toISOString();
          updateTask(db, taskId, { status: "queued", runAt, autoRetries: (current?.autoRetries ?? 0) + 1 });
        }
        if (!requeued && current?.status === "running") updateTask(db, taskId, { status: "done" });
        auditEvent(db, "crew", requeued ? "recovery.queued" : "recovery.exhausted", taskId);
        // Only the dashboard keeps a schedule running; `nightcrew run` exits once drained.
        const next = !requeued
          ? ""
          : this.timer && !this.halted
            ? ` It goes back in the queue and tries again in ${CRASH_RETRY_MS / 60_000} minutes.`
            : " It goes back in the queue and tries again on the next `nightcrew run` or dashboard start.";
        this.message = `"${task.title}" crashed: ${e instanceof Error ? e.message : String(e)}${next}`;
      })
      .finally(() => {
        const running = this.running.get(taskId);
        if (running?.stopTimer) clearTimeout(running.stopTimer);
        this.running.delete(taskId);
        this.emitStatus();
        void this.pump();
      });
    const running: Running = { agent, abort, done, missionId: task.missionId ?? null, stopAt: null, stopTimer: null };
    this.running.set(taskId, running);
    this.refreshMissionStop(running);
    this.message = null;
  }

  private async finished(taskId: string, title: string, repoId: string, outcome: TaskOutcome) {
    const { db } = this.deps;

    // Quitting: work cut short goes back in the queue for the next start, and
    // nothing else happens (no retries, no pushes) on the way out.
    if (this.halted) {
      if (outcome.status === "timeout" || outcome.rateLimited) {
        updateTask(db, taskId, { status: "queued" });
        this.message = `"${title}" was stopped for quitting and goes back in the queue.`;
      } else {
        this.emit({ type: "report", outcome: { ...outcome, title, taskId } });
      }
      return;
    }

    this.emit({ type: "report", outcome: { ...outcome, title, taskId } });

    const retries = getTask(db, taskId)?.autoRetries ?? 0;
    if (outcome.rateLimited && retries < 2) {
      // Rate limited: put it back and pause dispatch for a while.
      const wait = RATE_LIMIT_WAITS_MS[Math.min(this.rateLimitStrikes++, RATE_LIMIT_WAITS_MS.length - 1)] as number;
      updateTask(db, taskId, { status: "queued", autoRetries: retries + 1 });
      auditEvent(db, "crew", "recovery.rate_limit", taskId);
      this.pausedUntil = Date.now() + wait;
      saveDispatchBackoff(db, { until: this.pausedUntil, strikes: this.rateLimitStrikes });
      this.message = `Rate limited. Agents resume in ${wait / 60_000} minutes.`;
      setTimeout(() => void this.pump(), wait + 500);
      return;
    }
    this.rateLimitStrikes = 0;
    // Another already-running task may finish during a cooldown. Keep that
    // deadline while resetting the strike history, just as this process does.
    if (this.pausedUntil <= Date.now()) this.pausedUntil = 0;
    saveDispatchBackoff(db, { until: this.pausedUntil, strikes: 0 });

    if (outcome.status === "failed" && outcome.reason) {
      if (retries < 1) {
        const kind = await classifyFailure(
          this.deps.reflexes ?? new NoReflexes(),
          outcome.reason,
          outcome.log ?? outcome.reason,
        );
        if (kind === "flaky") {
          updateTask(db, taskId, { status: "queued", autoRetries: retries + 1 });
          auditEvent(db, "crew", "recovery.flaky", taskId);
          this.message = `"${title}" looked like a flaky failure, so it gets one more try.`;
        }
      }
    }

    // A repo's train is published whenever no agent is working in that repo.
    const stillBusy = [...this.running.values()].some((r) => r.agent.repoId === repoId && r.agent.taskId !== taskId);
    if (!stillBusy) await this.publishTrains(repoId);
  }

  /** Push the repo's open train and open (or refresh) its one PR. */
  private async publishTrains(repoId: string) {
    if (!this.deps.publish || this.halted) return;
    const repo = getRepo(this.deps.db, repoId);
    if (!repo) return;
    for (const train of listTrains(this.deps.db).filter(
      (t) =>
        t.repoId === repoId &&
        (t.status === "open" || t.status === "published") &&
        t.cars.some((c) => c.state === "on"),
    )) {
      try {
        const pr = await publishTrain(repo, train);
        if (pr) updateTrain(this.deps.db, train.id, { status: "published", prUrl: pr.prUrl, prNumber: pr.prNumber });
        if (pr?.warning) this.message = `${repo.name} train: ${pr.warning}`;
      } catch (e) {
        this.message = `Couldn't publish the ${repo.name} train: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
  }

  /** Stop one agent. Its unfinished work stays on its branch. */
  stopAgent(taskId: string): boolean {
    const r = this.running.get(taskId);
    if (!r) return false;
    r.abort.abort();
    return true;
  }

  /** Stop every agent. */
  stopAll() {
    for (const r of this.running.values()) r.abort.abort();
  }

  /** Stop every agent and start nothing new, for quitting. */
  shutdown() {
    this.halted = true;
    this.stopSchedule();
    this.stopAll();
    stopOperations(this.deps.db);
  }

  /** Resolves when no agent is working and nothing runnable is left (for `nightcrew run` and tests). */
  async drain(): Promise<void> {
    await this.pump();
    while (this.running.size) {
      await Promise.race([...this.running.values()].map((r) => r.done));
      await this.pump();
    }
    if (this.deps.publish && getSettings(this.deps.db).dispatch && !this.halted)
      for (const repo of listRepos(this.deps.db))
        for (let stage = 0; stage < 3 && !this.halted; stage++)
          await automaticDelivery(this.deps.db, repo.id, this.deps.dataDir).catch(() => {});
    await waitForOperations(this.deps.db);
  }

  private emitStatus() {
    this.emit({ type: "status", status: this.getStatus() });
  }

  private emit(e: CrewEvent) {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {}
    }
  }
}

// ── One dispatcher at a time ────────────────────────────────────────────────

export type CrewLock = { ok: true; release: () => void } | { ok: false; pid: number; file: string };

interface LockInfo {
  pid: number;
  startedAt: string;
  nonce: string;
  /** The owner's command line as `ps` showed it when it took the lock. */
  command: string;
}

/**
 * Only one process may dispatch the queue (the dashboard or `nightcrew run`).
 * The lock is <dataDir>/crew.lock naming its owner (pid, start time, a nonce
 * and its command line). A lock is stale when its process is gone, or when
 * that pid now belongs to some other program (pids get reused after a
 * reboot); a stale lock is taken over.
 */
export function takeCrewLock(dataDir: string, probe: ProcessProbe = processInfo): CrewLock {
  const file = join(dataDir, "crew.lock");
  const self = probe(process.pid);
  const mine: LockInfo = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    nonce: crypto.randomUUID(),
    command: self?.command ?? "",
  };
  const body = JSON.stringify(mine);
  const held = (): CrewLock => {
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        try {
          if (readLock(file)?.nonce === mine.nonce) unlinkSync(file);
        } catch {}
      },
    };
  };

  try {
    const fd = openSync(file, "wx");
    writeSync(fd, body);
    closeSync(fd);
    return held();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }

  const raw = readRaw(file);
  const owner = readLock(file);
  if (owner && owner.pid !== process.pid && ownsLock(owner, self ? probe : null))
    return { ok: false, pid: owner.pid, file };

  // Stale. Only one process takes it over: crew.lock.takeover, created
  // exclusively, guards the re-check and the swap, so two dispatchers that
  // both saw the stale lock can't both end up holding it.
  const busy = (): CrewLock => ({ ok: false, pid: readLock(file)?.pid ?? owner?.pid ?? 0, file });
  const mutex = `${file}.takeover`;
  if (!takeMutex(mutex, mine.nonce)) return busy();
  const tmp = `${file}.${mine.nonce}.tmp`;
  try {
    // Changed since we looked (someone took it over or released it): their lock decides.
    if (readRaw(file) !== raw) return busy();
    const now = readLock(file);
    if (now && now.pid !== process.pid && ownsLock(now, self ? probe : null)) return busy();
    writeFileSync(tmp, body);
    if (raw === null) {
      // No lock to replace: link fails if a fresh start created one meanwhile.
      try {
        linkSync(tmp, file);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") return busy();
        throw e;
      }
    } else renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
    try {
      if (readRaw(mutex) === mine.nonce) unlinkSync(mutex);
    } catch {}
  }
  return readLock(file)?.nonce === mine.nonce ? held() : busy();
}

/** A takeover file older than this was left by a takeover that died part way. */
const TAKEOVER_STALE_MS = 30_000;

/** Create the takeover file exclusively, clearing one a dead takeover left behind. */
function takeMutex(path: string, nonce: string): boolean {
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, nonce);
      closeSync(fd);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    try {
      if (Date.now() - statSync(path).mtimeMs < TAKEOVER_STALE_MS) return false;
      unlinkSync(path);
    } catch {
      // Gone already: try again.
    }
  }
  return false;
}

/**
 * Is the lock's owner still alive and still a NightCrew process? With no way
 * to look at processes (probe is null: no `ps` and no /proc), a live pid is
 * trusted, so two dispatchers never run at once.
 */
function ownsLock(owner: LockInfo, probe: ProcessProbe | null): boolean {
  const alive = () => {
    try {
      process.kill(owner.pid, 0);
      return true;
    } catch {
      // ESRCH: gone. EPERM: another user's process, so not a NightCrew of ours.
      return false;
    }
  };
  if (!alive()) return false;
  if (!probe) return true;
  // The probe came up empty: either the process just exited, or it can't be read. Trust it if it's still there.
  const info = probe(owner.pid);
  if (!info) return alive();
  // A process that started after the lock was written can't have written it.
  const lockedAt = Date.parse(owner.startedAt);
  if (info.startedAt !== null && Number.isFinite(lockedAt) && info.startedAt > lockedAt + 5_000) return false;
  if (owner.command && info.command === owner.command) return true;
  return /nightcrew/i.test(info.command) || (Boolean(Bun.main) && info.command.includes(Bun.main));
}

/** Looks up a live process: its command line and start time (ms), or null when it can't tell. */
export type ProcessProbe = (pid: number) => { command: string; startedAt: number | null } | null;

/** The command line and start time of a live process, from `ps`, else Linux's /proc (command only). */
function processInfo(pid: number): ReturnType<ProcessProbe> {
  try {
    const ps = Bun.spawnSync(["ps", "-o", "etime=", "-o", "command=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const line = ps.stdout.toString().trim();
    if (ps.success && line) {
      const [etime = "", ...rest] = line.split(/\s+/);
      const secs = elapsedSeconds(etime);
      return { command: rest.join(" "), startedAt: secs === null ? null : Date.now() - secs * 1000 };
    }
  } catch {}
  try {
    const command = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
    return command ? { command, startedAt: null } : null;
  } catch {
    return null;
  }
}

/** `ps` elapsed time, [[dd-]hh:]mm:ss, in seconds. */
function elapsedSeconds(etime: string): number | null {
  const m = etime.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const [, d = "0", h = "0", min = "0", sec = "0"] = m;
  return ((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(sec);
}

function readRaw(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readLock(file: string): LockInfo | null {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as Partial<LockInfo>;
    const pid = Number(j.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return {
      pid,
      startedAt: String(j.startedAt ?? ""),
      nonce: String(j.nonce ?? ""),
      command: String(j.command ?? ""),
    };
  } catch {
    return null;
  }
}
