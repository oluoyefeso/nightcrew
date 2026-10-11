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
import { formatTokens, nightIdFor, planQueue, type Task } from "@nightcrew/core";
import {
  type Db,
  getRepo,
  getRun,
  getSettings,
  getTask,
  getTrain,
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
const CRASH_RETRY_MS = 10 * 60_000;

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
  private halted = false;

  constructor(
    private readonly deps: {
      db: Db;
      engine: AgentEngine;
      dataDir: string;
      publish: boolean;
      reflexes?: Reflexes;
    },
  ) {}

  /**
   * Put tasks left "running" by a crash back in the queue. Only the process
   * that dispatches (holding the crew lock) may call this; any other process
   * would steal tasks a live dispatcher is running.
   */
  recover(): number {
    const orphans = listTasks(this.deps.db, ["running"]);
    for (const t of orphans) updateTask(this.deps.db, t.id, { status: "queued" });
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
          break;
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
    for (const id of planQueue(all).order) {
      const t = byId.get(id);
      if (!t || this.running.has(id) || skip.has(id)) continue;
      if (t.runAt && new Date(t.runAt).getTime() > now) continue;
      // Dependencies must have finished and succeeded, not just started or stopped.
      if (t.dependsOn.some((d) => byId.has(d) && !this.satisfied(byId.get(d) as Task))) continue;
      if ((perRepo.get(t.repoId) ?? 0) >= maxPerRepo) continue;
      return t;
    }
    return null;
  }

  /**
   * A dependency counts as met when you archived it, or its latest run
   * completed and, in a repo that lands work itself (train or ship), its work
   * is still landed (car on, ship not undone) or went to a PR. A failed or
   * timed-out run, or a pulled or undone landing, keeps dependents waiting.
   */
  private satisfied(dep: Task): boolean {
    const { db } = this.deps;
    if (dep.status === "archived") return true;
    if (dep.status !== "done" || !dep.lastRunId) return false;
    const run = getRun(db, dep.lastRunId)?.run;
    if (run?.status !== "complete") return false;
    if (dep.type === "research") return true;
    const level = getRepo(db, dep.repoId)?.level;
    if (level !== "train" && level !== "ship") return true;
    if (run.prUrl || (run.shipSha && !run.undoneAt)) return true;
    if (!run.trainId) return false;
    return getTrain(db, run.trainId)?.cars.some((c) => c.runId === run.id && c.state === "on") ?? false;
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
        // A crash must not strand the task in "running". It waits a while
        // before the next try so a task that always crashes can't spin.
        const requeued = getTask(db, taskId)?.status === "running";
        if (requeued) {
          const runAt = new Date(Date.now() + CRASH_RETRY_MS).toISOString();
          updateTask(db, taskId, { status: "queued", runAt });
        }
        // Only the dashboard keeps a schedule running; `nightcrew run` exits once drained.
        const next = !requeued
          ? ""
          : this.timer && !this.halted
            ? ` It goes back in the queue and tries again in ${CRASH_RETRY_MS / 60_000} minutes.`
            : " It goes back in the queue and tries again on the next `nightcrew run` or dashboard start.";
        this.message = `"${task.title}" crashed: ${e instanceof Error ? e.message : String(e)}${next}`;
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

    if (outcome.rateLimited) {
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
        const kind = await classifyFailure(
          this.deps.reflexes ?? new NoReflexes(),
          outcome.reason,
          outcome.log ?? outcome.reason,
        );
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
