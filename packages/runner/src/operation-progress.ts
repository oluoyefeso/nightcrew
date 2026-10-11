import type { OperationJob } from "@nightcrew/core";
import { auditEvent, type Db, saveOperationJob } from "@nightcrew/db";

const active = new WeakMap<Db, Map<string, { ctrl: AbortController; row: OperationJob; done: Promise<void> }>>();
export type OnOperationStarted = (job: OperationJob) => void;

export class OperationInputError extends Error {}

export function operation(
  db: Db,
  kind: OperationJob["kind"],
  subjectId: string,
  stage: OperationJob["stage"] = null,
  onStarted?: OnOperationStarted,
) {
  const ctrl = new AbortController();
  let jobs = active.get(db);
  if (!jobs) {
    jobs = new Map();
    active.set(db, jobs);
  }
  const at = new Date().toISOString();
  const row: OperationJob = {
    id: `operation_${crypto.randomUUID()}`,
    kind,
    subjectId,
    stage,
    status: "running",
    phase: "validating",
    repoId: kind === "delivery" ? subjectId : null,
    resultId: null,
    detail: "Checking the requested action.",
    createdAt: at,
    updatedAt: at,
  };
  saveOperationJob(db, row);
  let complete!: () => void;
  const done = new Promise<void>((resolve) => {
    complete = resolve;
  });
  jobs.set(row.id, { ctrl, row, done });
  onStarted?.({ ...row });
  const save = () => {
    row.updatedAt = new Date().toISOString();
    saveOperationJob(db, row);
  };
  return {
    signal: ctrl.signal,
    progress(phase: OperationJob["phase"], repoId?: string) {
      row.phase = phase;
      if (repoId) row.repoId = repoId;
      row.detail = "";
      save();
    },
    finish(status: "passed" | "failed" | "interrupted", resultId: string | null, detail: string) {
      row.status = ctrl.signal.aborted ? "interrupted" : status;
      row.phase = "finished";
      row.resultId = resultId;
      row.detail = ctrl.signal.aborted ? "Stopped. Inspect the recorded outcome before starting again." : detail;
      save();
      jobs.delete(row.id);
      complete();
    },
  };
}
export type OperationContext = ReturnType<typeof operation>;

/** A targeted stop leaves unrelated work running. The record remains stopping until cleanup completes. */
export function stopOperation(db: Db, id: string): boolean {
  const job = active.get(db)?.get(id);
  if (!job) return false;
  if (!job.ctrl.signal.aborted) {
    job.row.status = "stopping";
    job.row.detail = "Stopping the command and cleaning up its checkout.";
    job.row.updatedAt = new Date().toISOString();
    saveOperationJob(db, job.row);
    job.ctrl.abort();
    auditEvent(db, "you", "operation.stop", id);
  }
  return true;
}
export function stopOperations(db: Db) {
  for (const id of active.get(db)?.keys() ?? []) stopOperation(db, id);
}

export async function waitForOperations(db: Db) {
  await Promise.all([...(active.get(db)?.values() ?? [])].map((job) => job.done));
}

/** The runner owns completion; HTTP clients only wait until a durable record exists. */
export async function startInBackground(
  work: (onStarted: OnOperationStarted) => Promise<unknown>,
): Promise<OperationJob> {
  let started: OperationJob | undefined;
  const pending = work((job) => {
    started = job;
  });
  // Always observe rejections, including when the client disconnects or never polls.
  if (started) {
    void pending.catch(() => {});
    return started;
  }
  await pending; // Surface conflicts raised before an operation could be created.
  throw new Error("The operation did not start.");
}
