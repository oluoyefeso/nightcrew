// The crew: a dispatcher that keeps agents working around the clock. Queued
// tasks start as soon as a slot is free (within the per-repo and total
// limits and the daily budget); scheduled tasks wait for their time. Each
// agent reports back when it finishes.

import { formatTokens, nightIdFor, planQueue } from "@nightcrew/core";
import {
  type Db,
  getRepo,
  getSettings,
  getTask,
  listTasks,
  listTrains,
  type RunEvent,
  tokensOnDay,
  updateTask,
  updateTrain,
} from "@nightcrew/db";
import type { AgentEngine } from "./engine";
import { publishTrain } from "./landing";
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

interface Running {
  agent: ActiveAgent;
  abort: AbortController;
  done: Promise<void>;
}

export class Crew {
  private running = new Map<string, Running>();
  private listeners = new Set<(e: CrewEvent) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private pausedUntil = 0;
  private rateLimitStrikes = 0;
  private retriedToday = new Map<string, string>();
  private message: string | null = null;
  private pumping = false;

  constructor(
    private readonly deps: {
      db: Db;
      engine: AgentEngine;
      dataDir: string;
      publish: boolean;
      reflexes?: Reflexes;
    },
  ) {
    // A task left "running" by a crash goes back to the queue.
    for (const t of listTasks(deps.db, ["running"])) updateTask(deps.db, t.id, { status: "queued" });
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

  /** Start the dispatcher: check for work now and every few seconds. */
  startSchedule() {
    this.timer ??= setInterval(() => void this.pump(), TICK_MS);
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
      materializeRoutines(db);
      const s = getSettings(db);
      if (!s.dispatch || this.pausedUntil > Date.now()) return this.emitStatus();

      for (;;) {
        if (this.running.size >= s.maxAgents) break;
        const next = this.nextRunnable(s.maxPerRepo);
        if (!next) break;
        const used = tokensOnDay(db, nightIdFor(new Date().toISOString())) + this.inFlightBudget();
        if (used + next.tokenBudget > s.dailyTokenBudget) {
          this.message = `Holding "${next.title}": it could take today past the ${formatTokens(s.dailyTokenBudget)}-token budget.`;
          break;
        }
        this.launch(next.id);
      }
      this.emitStatus();
    } finally {
      this.pumping = false;
    }
  }

  /** The highest-priority queued task that can start now. */
  private nextRunnable(maxPerRepo: number) {
    const { db } = this.deps;
    const all = listTasks(db);
    const byId = new Map(all.map((t) => [t.id, t]));
    const now = Date.now();
    const perRepo = new Map<string, number>();
    for (const r of this.running.values()) perRepo.set(r.agent.repoId, (perRepo.get(r.agent.repoId) ?? 0) + 1);
    for (const id of planQueue(all).order) {
      const t = byId.get(id);
      if (!t || this.running.has(id)) continue;
      if (t.runAt && new Date(t.runAt).getTime() > now) continue;
      // Dependencies must have finished, not just started.
      if (t.dependsOn.some((d) => byId.get(d) && !["done", "archived"].includes(byId.get(d)?.status ?? ""))) continue;
      if ((perRepo.get(t.repoId) ?? 0) >= maxPerRepo) continue;
      return t;
    }
    return null;
  }

  private inFlightBudget(): number {
    let n = 0;
    for (const r of this.running.values()) n += getTask(this.deps.db, r.agent.taskId)?.tokenBudget ?? 0;
    return n;
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
        this.message = `"${task.title}" crashed: ${e instanceof Error ? e.message : String(e)}`;
      })
      .finally(() => {
        this.running.delete(taskId);
        this.emitStatus();
        void this.pump();
      });
    this.running.set(taskId, { agent, abort, done });
    this.message = null;
  }

  private async finished(taskId: string, title: string, repoId: string, outcome: TaskOutcome) {
    const { db } = this.deps;
    this.emit({ type: "report", outcome: { ...outcome, title, taskId } });

    if (outcome.reason?.includes("429")) {
      // Rate limited: put it back and pause dispatch for a while.
      const wait = RATE_LIMIT_WAITS_MS[Math.min(this.rateLimitStrikes++, RATE_LIMIT_WAITS_MS.length - 1)] as number;
      updateTask(db, taskId, { status: "queued" });
      this.pausedUntil = Date.now() + wait;
      this.message = `Rate limited. Agents resume in ${wait / 60_000} minutes.`;
      setTimeout(() => void this.pump(), wait + 500);
      return;
    }
    this.rateLimitStrikes = 0;

    if (outcome.status === "failed" && outcome.reason) {
      const today = nightIdFor(new Date().toISOString());
      if (this.retriedToday.get(taskId) !== today) {
        const kind = await classifyFailure(this.deps.reflexes ?? new NoReflexes(), outcome.reason, outcome.reason);
        if (kind === "flaky") {
          this.retriedToday.set(taskId, today);
          updateTask(db, taskId, { status: "queued" });
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
    if (!this.deps.publish) return;
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

  /** Resolves when no agent is working and nothing runnable is left (for `nightcrew run` and tests). */
  async drain(): Promise<void> {
    await this.pump();
    while (this.running.size) {
      await Promise.race([...this.running.values()].map((r) => r.done));
      await this.pump();
    }
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
