// The crew: works through tonight's queue one task at a time, within the
// nightly budget, starting on schedule or when you press Run now.

import { nextStart, nightIdFor, planQueue } from "@nightcrew/core";
import {
  type Db,
  getRepo,
  getSettings,
  getTask,
  listTasks,
  listTrains,
  type RunEvent,
  updateTask,
  updateTrain,
} from "@nightcrew/db";
import type { AgentEngine } from "./engine";
import { publishTrain } from "./landing";
import { runTask, type TaskOutcome } from "./pipeline";
import { classifyFailure, NoReflexes, type Reflexes } from "./reflexes";
import { materializeRoutines } from "./routines";

export interface CrewStatus {
  state: "idle" | "running" | "stopping" | "waiting";
  taskId: string | null;
  runId: string | null;
  startedAt: string | null;
  spentCents: number;
  done: number;
  remaining: number;
  nextStartAt: string;
  message: string | null;
  engine: string;
}

export type CrewEvent = { type: "status"; status: CrewStatus } | { type: "run_event"; event: RunEvent };

const RATE_LIMIT_WAITS_MS = [5, 10, 20].map((m) => m * 60_000);

export class Crew {
  private abort: AbortController | null = null;
  private status: CrewStatus;
  private lastAutoNight: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(e: CrewEvent) => void>();

  constructor(
    private readonly deps: {
      db: Db;
      engine: AgentEngine;
      dataDir: string;
      publish: boolean;
      reflexes?: Reflexes;
    },
  ) {
    this.status = this.idleStatus(null);
    // A task left "running" by a crash goes back to the queue.
    for (const t of listTasks(deps.db, ["running"])) updateTask(deps.db, t.id, { status: "queued" });
  }

  subscribe(fn: (e: CrewEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getStatus(): CrewStatus {
    return { ...this.status, nextStartAt: nextStart(getSettings(this.deps.db).startAt).toISOString() };
  }

  /** Check the clock every 30 seconds and start the queue on schedule. */
  startSchedule() {
    this.timer ??= setInterval(() => this.tick(), 30_000);
    this.tick();
  }

  stopSchedule() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(now = new Date()) {
    const s = getSettings(this.deps.db);
    if (!s.autoStart || this.status.state !== "idle") return;
    const [h, m] = s.startAt.split(":").map(Number);
    const start = new Date(now);
    start.setHours(h ?? 22, m ?? 0, 0, 0);
    if (start.getTime() > now.getTime()) start.setDate(start.getDate() - 1);
    // Inside the eight hours after the start time, run once per night.
    const inWindow = now.getTime() - start.getTime() < 8 * 3_600_000;
    const night = nightIdFor(start.toISOString());
    if (inWindow && this.lastAutoNight !== night) materializeRoutines(this.deps.db, now);
    if (inWindow && this.lastAutoNight !== night && listTasks(this.deps.db, ["queued"]).length > 0) {
      this.lastAutoNight = night;
      void this.start("schedule");
    }
  }

  /** Work through the queue. Resolves when it's empty, stopped or out of budget. */
  async start(trigger: "schedule" | "manual" = "manual"): Promise<void> {
    if (this.status.state !== "idle") return;
    const { db } = this.deps;
    this.abort = new AbortController();
    const settings = getSettings(db);
    this.set({
      state: "running",
      startedAt: new Date().toISOString(),
      spentCents: 0,
      done: 0,
      message: trigger === "schedule" ? "Started on schedule" : "Started by you",
    });

    let rateLimitStrikes = 0;
    let endMessage: string | null = null;
    const retried = new Set<string>();
    const reflexes = this.deps.reflexes ?? new NoReflexes();
    const routines = materializeRoutines(db);
    if (routines) this.set({ message: `Queued ${routines} routine ${routines === 1 ? "task" : "tasks"} for tonight.` });
    try {
      while (!this.abort.signal.aborted) {
        const all = listTasks(db);
        const { order } = planQueue(all);
        const nextId = order[0];
        if (!nextId) break;
        const task = getTask(db, nextId);
        if (!task) break;

        if (this.status.spentCents + task.budgetCents > settings.nightlyBudgetCents) {
          endMessage = `Stopped before "${task.title}": it could take the night past its $${(settings.nightlyBudgetCents / 100).toFixed(2)} budget.`;
          break;
        }

        this.set({ taskId: task.id, runId: null, remaining: order.length });
        const outcome: TaskOutcome = await runTask(
          {
            db,
            engine: this.deps.engine,
            dataDir: this.deps.dataDir,
            models: { plan: settings.planModel, build: settings.buildModel, review: settings.reviewModel },
            publish: this.deps.publish,
            reflexes,
            onEvent: (event) => {
              if (this.status.runId !== event.runId) this.set({ runId: event.runId });
              this.emit({ type: "run_event", event });
            },
          },
          task.id,
          this.abort.signal,
        );
        this.set({ spentCents: this.status.spentCents + outcome.costCents, done: this.status.done + 1 });

        // Rate limited: put the task back and wait, up to three times a night.
        if (outcome.reason?.includes("429") && !this.abort.signal.aborted) {
          const wait = RATE_LIMIT_WAITS_MS[rateLimitStrikes++];
          if (wait === undefined) {
            endMessage = "Rate limited three times. Stopping for the night.";
            break;
          }
          updateTask(db, task.id, { status: "queued" });
          this.set({ state: "waiting", message: `Rate limited. Trying again in ${wait / 60_000} minutes.` });
          await sleep(wait, this.abort.signal);
          this.set({ state: "running" });
        } else if (
          outcome.status === "failed" &&
          !retried.has(task.id) &&
          !this.abort.signal.aborted &&
          outcome.reason
        ) {
          // A flaky failure gets one more go tonight; a real one waits for morning.
          const kind = await classifyFailure(reflexes, outcome.reason, outcome.reason);
          if (kind === "flaky") {
            retried.add(task.id);
            updateTask(db, task.id, { status: "queued" });
            this.set({ message: `"${task.title}" looked like a flaky failure, so it gets one more try.` });
          }
        }
      }
      await this.publishTrains();
    } finally {
      const stopped = this.abort?.signal.aborted;
      const { done, spentCents } = this.status;
      this.abort = null;
      const summary = `Finished ${done} ${done === 1 ? "task" : "tasks"} for $${(spentCents / 100).toFixed(2)}.`;
      this.status = this.idleStatus(stopped ? `Stopped by you. ${summary}` : (endMessage ?? summary));
      this.emit({ type: "status", status: this.getStatus() });
    }
  }

  /** Push every train that picked up cars tonight and open its one PR. */
  private async publishTrains() {
    if (!this.deps.publish) return;
    for (const train of listTrains(this.deps.db).filter(
      (t) => (t.status === "open" || t.status === "published") && t.cars.some((c) => c.state === "on"),
    )) {
      const repo = getRepo(this.deps.db, train.repoId);
      if (!repo) continue;
      try {
        const pr = await publishTrain(repo, train);
        if (pr) updateTrain(this.deps.db, train.id, { status: "published", prUrl: pr.prUrl, prNumber: pr.prNumber });
      } catch (e) {
        this.set({ message: `Couldn't publish the ${repo.name} train: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
  }

  stop() {
    if (!this.abort) return;
    this.set({ state: "stopping", message: "Stopping after the current step…" });
    this.abort.abort();
  }

  private idleStatus(message: string | null): CrewStatus {
    return {
      state: "idle",
      taskId: null,
      runId: null,
      startedAt: null,
      spentCents: 0,
      done: 0,
      remaining: 0,
      nextStartAt: new Date().toISOString(),
      message,
      engine: this.deps.engine.name,
    };
  }

  private set(patch: Partial<CrewStatus>) {
    this.status = { ...this.status, ...patch };
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

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
}
