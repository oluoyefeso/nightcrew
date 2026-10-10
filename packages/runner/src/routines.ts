import { nightIdFor } from "@nightcrew/core";
import { createTask, type Db, listRoutines, updateRoutine } from "@nightcrew/db";

/** Queue tonight's copy of every routine due today. Returns how many were queued. */
export function materializeRoutines(db: Db, now = new Date()): number {
  const night = nightIdFor(now.toISOString());
  const weekday = new Date(`${night}T12:00:00`).getDay();
  let n = 0;
  for (const r of listRoutines(db)) {
    if (!r.enabled || r.lastNight === night || !r.days.includes(weekday)) continue;
    createTask(db, {
      repoId: r.repoId,
      title: r.title,
      brief: r.brief,
      type: r.type,
      scope: r.scope,
      criteria: r.criteria,
      status: "queued",
      source: "routine",
      sourceRef: r.id,
    });
    updateRoutine(db, r.id, { lastNight: night });
    n++;
  }
  return n;
}
