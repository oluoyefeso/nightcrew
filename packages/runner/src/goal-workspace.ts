import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Repo, Task } from "@nightcrew/core";
import {
  addNote,
  type Db,
  getConductor,
  getMission,
  getRepo,
  getRun,
  getTask,
  getTaskHandoff,
  listNotes,
  listTasks,
  saveTaskHandoff,
} from "@nightcrew/db";
import { FETCH_FSCK, git, gitRun, resolveSha, withRepoLock } from "./git";
import { taskRef } from "./workspace";

export const goalHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Read accepted work from host-owned refs. Never take a base supplied by an agent. */
export async function goalSnapshot(db: Db, missionId: string, taskIds: string[]) {
  const mission = getMission(db, missionId);
  if (!mission) throw new Error("The goal no longer exists.");
  const members = [];
  for (const id of taskIds) {
    const task = getTask(db, id);
    const detail = task?.lastRunId ? getRun(db, task.lastRunId) : null;
    if (
      !task ||
      task.missionId !== missionId ||
      !detail ||
      !["done", "archived"].includes(task.status) ||
      detail.run.status !== "complete" ||
      detail.run.verdict !== "ready" ||
      detail.run.triage === "close" ||
      detail.run.prState === "closed" ||
      detail.run.undoneAt
    )
      throw new Error("Some work still needs a successful result or your decision.");
    const repo = getRepo(db, task.repoId);
    const sha = task.type === "research" ? null : repo && (await resolveSha(repo.path, taskRef(task.id)));
    if (task.type !== "research" && !sha) throw new Error("A checked task commit is unavailable.");
    members.push({ task, ...detail, sha });
  }
  const repos = [...new Set(members.map((m) => m.task.repoId))].map((id) => getRepo(db, id));
  const bases = await Promise.all(
    repos.map(async (repo) => (repo ? await resolveSha(repo.path, `refs/heads/${repo.defaultBranch}`) : null)),
  );
  return {
    members,
    fingerprint: goalHash({
      objective: mission.objective,
      criteria: mission.criteria,
      repos,
      bases,
      members,
      membership: listTasks(db)
        .filter((task) => task.missionId === missionId)
        .map((task) => task.id)
        .sort(),
    }),
  };
}

/** Combine already checked commits privately. This changes no working branch and publishes nothing. */
export async function combineGoalCommits(repo: Repo, tips: string[], dataDir: string, signal: AbortSignal) {
  return withRepoLock(
    repo.path,
    async () => {
      const base = await resolveSha(repo.path, `refs/heads/${repo.defaultBranch}`);
      if (!base) throw new Error("The project's default branch is unavailable.");
      mkdirSync(join(dataDir, "goal-integration"), { recursive: true });
      const dir = mkdtempSync(join(dataDir, "goal-integration", "combine-"));
      const step = async (cwd: string, args: string[]) => {
        const result = await gitRun(cwd, args, { signal, timeoutMs: 60_000 });
        if (!result.ok)
          throw new Error("The goal's checked changes could not be combined. Review the conflicting work.");
        return result.stdout;
      };
      try {
        await step(repo.path, ["clone", "--quiet", "--shared", "--no-checkout", "--no-tags", repo.path, dir]);
        await step(dir, ["checkout", "--quiet", "--detach", base]);
        await step(dir, ["remote", "remove", "origin"]);
        for (const tip of [...new Set(tips)])
          await step(dir, [
            "-c",
            "user.name=NightCrew",
            "-c",
            "user.email=crew@nightcrew.dev",
            "merge",
            "--no-edit",
            "--no-gpg-sign",
            tip,
          ]);
        const sha = await resolveSha(dir, "HEAD");
        if (!sha) throw new Error("The combined commit is unavailable.");
        // Import checked objects to an internal ref so independent checks can use a pinned checkout.
        const ref = `refs/nightcrew/goals/${sha}`;
        await step(repo.path, [
          ...FETCH_FSCK,
          "-c",
          "protocol.file.allow=always",
          "fetch",
          "--quiet",
          "--no-tags",
          "--no-recurse-submodules",
          "--no-write-fetch-head",
          dir,
          `HEAD:${ref}`,
        ]);
        return { base, sha, ref };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    signal,
  );
}

/** Pin prerequisite code as this task's gate base. Recovery refuses changed prerequisites. */
export async function goalTaskBase(
  db: Db,
  repo: Repo,
  task: Task,
  dataDir: string,
  signal: AbortSignal,
): Promise<string | null> {
  const conductor = task.missionId ? getConductor(db, task.missionId) : null;
  if (!conductor?.taskIds.includes(task.id) || !task.dependsOn.length || task.type === "research") return null;
  const snapshot = await goalSnapshot(db, task.missionId!, task.dependsOn);
  for (const member of snapshot.members.filter((member) => member.task.type === "research")) {
    if (!listNotes(db, task.id).some((note) => note.runId === member.run.id && note.author === "crew"))
      addNote(
        db,
        task.id,
        "crew",
        `Prerequisite research: ${member.task.title}\n${member.artifacts.find((artifact) => artifact.kind === "report")?.content.slice(0, 8000) ?? member.run.summary ?? "Inspect the saved research evidence."}`,
        member.run.id,
      );
  }
  const deps = snapshot.members.filter((m) => m.task.repoId === repo.id && m.sha);
  if (!deps.length) return null;
  const fingerprint = goalHash(
    deps.map((m) => ({ id: m.task.id, run: m.run.id, sha: m.sha, triage: m.run.triage, undone: m.run.undoneAt })),
  );
  const previous = getTaskHandoff(db, task.id);
  if (previous) {
    if (previous.fingerprint !== fingerprint)
      throw new Error("A prerequisite changed after this task began. Review its saved work before rebuilding.");
    return previous.base;
  }
  const combined = await combineGoalCommits(
    repo,
    deps.map((m) => m.sha!),
    dataDir,
    signal,
  );
  saveTaskHandoff(db, task.id, fingerprint, combined.sha);
  return combined.sha;
}

export async function assertGoalBase(
  db: Db,
  repo: Repo,
  task: Task,
  dataDir: string,
  signal: AbortSignal,
  expected: string | null,
) {
  if (expected && goalHash(getTask(db, task.id)?.dependsOn) !== goalHash(task.dependsOn))
    throw new Error("The prerequisite list changed during execution.");
  if (expected && (await goalTaskBase(db, repo, task, dataDir, signal)) !== expected)
    throw new Error("The prerequisite handoff changed during execution.");
  if (expected && !(await git(repo.path, "cat-file", "-e", `${expected}^{commit}`)).ok)
    throw new Error("The prerequisite commit is unavailable.");
}
