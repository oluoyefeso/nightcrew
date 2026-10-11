import { createHash } from "node:crypto";
import type { Mission, Repo, Task, TaskNote } from "@nightcrew/core";

/** Commands and authority are always rerun/rechecked. Only unchanged intent may reuse agent work. */
export function recoveryFingerprint(task: Task, repo: Repo, mission: Mission | null, notes: TaskNote[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        repo: repo.id,
        path: repo.path,
        branch: task.branch,
        defaultBranch: repo.defaultBranch,
        title: task.title,
        brief: task.brief,
        type: task.type,
        scope: task.scope,
        criteria: task.criteria,
        objective: mission?.objective,
        missionCriteria: mission?.criteria,
        notes: notes.map((n) => [n.author, n.body]),
      }),
    )
    .digest("hex");
}
