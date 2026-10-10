import { humanizeTaskId } from "@nightcrew/core";
import { type Db, type RunRow, upsertRuns } from "@nightcrew/db";
import { findClassicRoot, importClassic } from "./classic";
import { type PrInfo, prInfoMany } from "./github";

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

  const prs = opts.github
    ? await prInfoMany(imported.flatMap((i) => (i.run.prUrl ? [i.run.prUrl] : [])))
    : new Map<string, PrInfo>();
  const rows = imported.map((i) => {
    const { run } = i;
    const info = run.prUrl ? prs.get(run.prUrl) : undefined;
    if (!info) {
      // Nothing fresh from GitHub (offline, or the lookup failed): keep what an
      // earlier sync recorded instead of regressing a merged PR to a draft.
      const keep: (keyof RunRow)[] = ["prState"];
      if (run.title === humanizeTaskId(run.taskId)) keep.push("title");
      if (!run.branch) keep.push("branch");
      return { ...i, keep };
    }
    run.prState = info.state;
    run.branch = info.branch ?? run.branch;
    run.additions = info.additions;
    run.deletions = info.deletions;
    run.changedFiles = info.changedFiles;
    // A task id makes a poor title; the PR title is what the user wrote or approved.
    if (run.title === humanizeTaskId(run.taskId)) run.title = info.title;
    return i;
  });

  upsertRuns(db, rows);
  return { root, runs: imported.length, prsChecked: prs.size };
}
