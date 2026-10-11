import { createHash } from "node:crypto";
import type { RepositoryCheck, RepositoryReadiness } from "@nightcrew/core";
import { type Db, getRepo, latestOperationJob, latestRepositoryCheck, saveRepositoryCheck } from "@nightcrew/db";
import { resolveSha } from "./git";
import { type OnOperationStarted, OperationInputError, operation, startInBackground } from "./operation-progress";
import { checkedCommand, redactOperationLog } from "./verification";

export async function repositoryReadiness(db: Db, id: string): Promise<RepositoryReadiness> {
  const repo = getRepo(db, id);
  if (!repo) throw new OperationInputError("Repository not found.");
  const branch = repo.defaultBranch;
  const sha = await resolveSha(repo.path, `refs/heads/${branch}`);
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        path: repo.path,
        branch,
        sha,
        setup: repo.setupCommand,
        tests: repo.testCommand,
      }),
    )
    .digest("hex");
  const blockers: string[] = [];
  if (!sha) blockers.push(`The local ${branch} branch is missing. Create or update it before verifying setup.`);
  if (!repo.testCommand?.trim()) blockers.push("Save a test command in repository settings before verifying setup.");
  const latest = latestRepositoryCheck(db, id);
  const job = latestOperationJob(db, "repository", id);
  return {
    fingerprint,
    branch,
    sha,
    blockers,
    latest,
    operation: job,
    verified:
      !blockers.length &&
      latest?.status === "passed" &&
      latest.fingerprint === fingerprint &&
      job?.status === "passed" &&
      job.resultId === latest.id,
  };
}

const checking = new WeakMap<Db, Set<string>>();
export async function verifyRepository(
  db: Db,
  id: string,
  fingerprint: string,
  dataDir: string,
  onStarted?: OnOperationStarted,
): Promise<RepositoryCheck> {
  let busy = checking.get(db);
  if (!busy) {
    busy = new Set();
    checking.set(db, busy);
  }
  if (busy.has(id)) throw new OperationInputError("Repository setup is already being verified.");
  busy.add(id);
  const op = operation(db, "repository", id, null, onStarted);
  let before: RepositoryReadiness | null = null;
  try {
    before = await repositoryReadiness(db, id);
    if (before.fingerprint !== fingerprint)
      throw new OperationInputError("Repository setup changed. Refresh before verifying.");
    if (before.blockers.length) throw new OperationInputError(before.blockers.join(" "));
    const repo = getRepo(db, id)!;
    const result = await checkedCommand(
      repo,
      before.sha!,
      repo.testCommand!,
      dataDir,
      {},
      async () => (await repositoryReadiness(db, id)).fingerprint === fingerprint,
      op,
    );
    const after = await repositoryReadiness(db, id);
    const changed = after.fingerprint !== fingerprint || after.blockers.length > 0;
    const row: RepositoryCheck = {
      id: `repository_check_${crypto.randomUUID()}`,
      repoId: id,
      fingerprint,
      branch: before.branch,
      sha: before.sha!,
      status: op.signal.aborted ? "interrupted" : result.ok && !changed ? "passed" : "failed",
      detail: changed
        ? "Repository settings or branch changed during verification. Check the current setup again."
        : result.detail,
      at: new Date().toISOString(),
    };
    saveRepositoryCheck(db, row);
    op.finish(
      row.status,
      row.id,
      row.status === "passed"
        ? "Repository setup and tests passed on the pinned commit."
        : "Repository verification did not pass. Review the saved result.",
    );
    return row;
  } catch (error) {
    // An aborted lock wait has no command result, but still needs a durable interrupted outcome.
    if (op.signal.aborted && before?.sha) {
      const row: RepositoryCheck = {
        id: `repository_check_${crypto.randomUUID()}`,
        repoId: id,
        fingerprint,
        branch: before.branch,
        sha: before.sha,
        status: "interrupted",
        detail: "Stopped before verification completed.",
        at: new Date().toISOString(),
      };
      saveRepositoryCheck(db, row);
      op.finish("interrupted", row.id, row.detail);
      return row;
    }
    op.finish(
      "failed",
      null,
      error instanceof OperationInputError
        ? redactOperationLog(error.message)
        : "Repository verification could not complete. Review the local repository and its setup commands.",
    );
    throw error;
  } finally {
    busy.delete(id);
  }
}

export function startRepositoryVerification(db: Db, id: string, fingerprint: string, dataDir: string) {
  return startInBackground((started) => verifyRepository(db, id, fingerprint, dataDir, started));
}
