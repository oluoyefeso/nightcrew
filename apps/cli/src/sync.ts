import { humanizeTaskId } from "@nightcrew/core";
import { type Db, upsertRuns } from "@nightcrew/db";
import { findClassicRoot, importClassic } from "./classic";
import { prInfoMany } from "./github";

export interface SyncResult {
  root: string | null;
  runs: number;
  prsChecked: number;
}

/** Pull classic history into the database and refresh PR state from GitHub. */
export async function syncClassic(db: Db, opts: { root?: string; cwd: string; github: boolean }): Promise<SyncResult> {
  const root = opts.root ?? findClassicRoot(opts.cwd);
  if (!root) return { root: null, runs: 0, prsChecked: 0 };
  const imported = importClassic(root);

  let prsChecked = 0;
  if (opts.github) {
    const prs = await prInfoMany(imported.flatMap((i) => (i.run.prUrl ? [i.run.prUrl] : [])));
    prsChecked = prs.size;
    for (const { run } of imported) {
      const info = run.prUrl ? prs.get(run.prUrl) : undefined;
      if (!info) continue;
      run.prState = info.state;
      run.branch = info.branch ?? run.branch;
      run.additions = info.additions;
      run.deletions = info.deletions;
      run.changedFiles = info.changedFiles;
      // A task id makes a poor title; the PR title is what the user wrote or approved.
      if (run.title === humanizeTaskId(run.taskId)) run.title = info.title;
    }
  }

  upsertRuns(db, imported);
  return { root, runs: imported.length, prsChecked };
}
