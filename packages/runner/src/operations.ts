import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DELIVERY, type Delivery, type MissionAcceptance, type Repo } from "@nightcrew/core";
import {
  auditEvent,
  type Db,
  deliveriesForCommit,
  getDelivery,
  getMission,
  getRepo,
  getRun,
  getTrain,
  latestOperationJob,
  listAcceptances,
  listTasks,
  saveAcceptance,
  saveDelivery,
} from "@nightcrew/db";
import { git, resolveSha, withRepoLock } from "./git";
import {
  type OnOperationStarted,
  type OperationContext,
  OperationInputError,
  operation,
  startInBackground,
} from "./operation-progress";
import { runCheck } from "./sandbox";
import { taskRef } from "./workspace";

export { stopOperation, stopOperations } from "./operation-progress";

const deliverySnapshot = (repo: Repo | null) =>
  repo ? { ...(repo.delivery ?? DEFAULT_DELIVERY), setupCommand: repo.setupCommand } : null;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function redactOperationLog(text: string, secrets: string[] = []): string {
  let clean = text;
  for (const secret of [...secrets, homedir()].filter(Boolean).sort((a, b) => b.length - a.length))
    clean = clean.split(secret).join("[redacted]");
  return clean
    .replace(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,})/g, "[redacted]")
    .replace(/(bearer\s+)[^\s]+/gi, "$1[redacted]")
    .slice(-8000);
}

/** Commands run against an isolated, pinned checkout, never the user's working directory. */
async function checkedCommand(
  repo: Repo,
  sha: string,
  command: string,
  dataDir: string,
  env: Record<string, string> = {},
  guard?: () => Promise<boolean>,
  op?: OperationContext,
) {
  const signal = op?.signal;
  op?.progress("waiting", repo.id);
  return withRepoLock(
    repo.path,
    async () => {
      if (signal?.aborted) return { ok: false, detail: "Stopped before the action." };
      if (guard && !(await guard()))
        return { ok: false, detail: "Delivery settings or branch changed before the action. Run verification again." };
      op?.progress("preparing", repo.id);
      const dir = join(dataDir, "operations", crypto.randomUUID());
      mkdirSync(join(dataDir, "operations"), { recursive: true });
      const add = await git(repo.path, "worktree", "add", "--detach", dir, sha);
      if (!add.ok) return { ok: false, detail: "Could not prepare the verification checkout." };
      try {
        if (repo.setupCommand) {
          op?.progress("setup", repo.id);
          const setup = await runCheck(repo.setupCommand, dir, {
            timeoutMs: 10 * 60_000,
            signal,
            env: Object.fromEntries(Object.keys(env).map((name) => [name, ""])),
          });
          if (!setup.ok) return { ok: false, detail: "Repository setup failed. Check the configured setup command." };
        }
        if (!(await git(dir, "diff", "--quiet", "HEAD", "--")).ok)
          return { ok: false, detail: "Setup changed tracked files; configure setup to preserve the pinned commit." };
        if (guard && !(await guard()))
          return { ok: false, detail: "Delivery settings or branch changed during setup. Run verification again." };
        if (signal?.aborted) return { ok: false, detail: "Stopped before the command." };
        op?.progress("command", repo.id);
        const result = await runCheck(command, dir, {
          timeoutMs: 15 * 60_000,
          signal,
          env: { ...env, NC_COMMIT: sha },
        });
        const intact = (await resolveSha(dir, "HEAD")) === sha && (await git(dir, "diff", "--quiet", "HEAD", "--")).ok;
        return {
          ok: result.ok && intact,
          detail: redactOperationLog(
            `${result.stdout}\n${result.stderr}\nExit ${result.code}.${intact ? "" : " Tracked source changed during verification."}`,
            Object.values(env),
          ),
        };
      } finally {
        op?.progress("finalizing", repo.id);
        await git(repo.path, "worktree", "remove", "--force", dir);
      }
    },
    signal,
  );
}

export async function missionReadiness(db: Db, id: string) {
  const mission = getMission(db, id);
  if (!mission) throw new OperationInputError("Mission not found.");
  const tasks = listTasks(db).filter((t) => t.missionId === id);
  const blockers: string[] = [];
  if (!tasks.length) blockers.push("Attach work before accepting this mission.");
  if (!mission.criteria.length) blockers.push("Set mission acceptance criteria first.");
  const members = tasks.map((task) => ({ task, run: task.lastRunId ? getRun(db, task.lastRunId)?.run : null }));
  for (const { task, run } of members) {
    if (
      !["done", "archived"].includes(task.status) ||
      !run ||
      run.status !== "complete" ||
      run.verdict !== "ready" ||
      run.triage === "close" ||
      run.prState === "closed" ||
      run.undoneAt
    )
      blockers.push(`Resolve ${task.title} successfully before acceptance.`);
  }
  const targets: { repoId: string; name: string; branch: string; sha: string; command: string | null }[] = [];
  for (const repoId of [...new Set(tasks.filter((t) => t.type !== "research").map((t) => t.repoId))]) {
    const repo = getRepo(db, repoId);
    if (!repo) {
      blockers.push("A repository is missing.");
      continue;
    }
    const runs = members.filter((m) => m.task.repoId === repoId && m.task.type !== "research");
    const trainIds = [...new Set(runs.map((m) => m.run?.trainId))];
    const train = trainIds.length === 1 && trainIds[0] ? getTrain(db, trainIds[0]) : null;
    const branch =
      repo.delivery?.branch ||
      (train && train.status !== "merged" ? train.branch : repo.shipBranch || repo.defaultBranch);
    const sha = await resolveSha(repo.path, `refs/heads/${branch}`);
    if (!sha) {
      blockers.push(`The local ${branch} branch is missing in ${repo.name}.`);
      continue;
    }
    if (!repo.testCommand?.trim()) blockers.push(`Configure combined verification tests in ${repo.name}.`);
    targets.push({ repoId, name: repo.name, branch, sha, command: repo.testCommand });
    for (const { task, run } of runs) {
      const tip = await resolveSha(repo.path, taskRef(task.id));
      if (!tip || (!(await git(repo.path, "merge-base", "--is-ancestor", tip, sha)).ok && run?.prState !== "merged"))
        blockers.push(`Land ${task.title} on ${branch} before checking the combined result.`);
      if (run?.trainId && getTrain(db, run.trainId)?.cars.some((c) => c.runId === run.id && c.state !== "on"))
        blockers.push(`Restore or replace the removed train work for ${task.title}.`);
    }
  }
  const fingerprint = hash({
    setup: targets.map((t) => getRepo(db, t.repoId)?.setupCommand),
    objective: mission.objective,
    criteria: mission.criteria,
    targets,
    members: members.map(({ task, run }) => ({
      id: task.id,
      updatedAt: task.updatedAt,
      runId: run?.id,
      verdict: run?.verdict,
      triage: run?.triage,
      pr: run?.prState,
      undo: run?.undoneAt,
    })),
  });
  const latest = listAcceptances(db, id)[0] ?? null;
  return {
    fingerprint,
    blockers: [...new Set(blockers)],
    targets,
    latest,
    operation: latestOperationJob(db, "mission", id),
    accepted: blockers.length === 0 && latest?.status === "passed" && latest.fingerprint === fingerprint,
  };
}

const accepting = new WeakMap<Db, Set<string>>();
export async function acceptMission(
  db: Db,
  id: string,
  fingerprint: string,
  evidence: MissionAcceptance["evidence"],
  dataDir: string,
  onStarted?: OnOperationStarted,
) {
  let busy = accepting.get(db);
  if (!busy) {
    busy = new Set();
    accepting.set(db, busy);
  }
  if (busy.has(id)) throw new OperationInputError("This mission is already being verified.");
  busy.add(id);
  const op = operation(db, "mission", id, null, onStarted);
  try {
    const before = await missionReadiness(db, id);
    const mission = getMission(db, id)!;
    if (before.fingerprint !== fingerprint)
      throw new OperationInputError("Mission evidence changed. Refresh before accepting.");
    if (before.blockers.length) throw new OperationInputError(before.blockers.join(" "));
    if (
      evidence.length !== mission.criteria.length ||
      mission.criteria.some((c) => evidence.filter((e) => e.criterion === c && e.evidence.trim()).length !== 1)
    )
      throw new OperationInputError("Provide an evidence note for every mission criterion.");
    const checks: MissionAcceptance["checks"] = [];
    for (const target of before.targets) {
      const repo = getRepo(db, target.repoId)!;
      const result = await checkedCommand(repo, target.sha, target.command!, dataDir, {}, undefined, op);
      checks.push({ repoId: repo.id, sha: target.sha, ...result });
      if (op.signal.aborted) break;
    }
    const after = await missionReadiness(db, id);
    if (after.fingerprint !== fingerprint)
      checks.push({
        repoId: "mission",
        sha: "",
        ok: false,
        detail: "Mission or branches changed while verification ran. Review and verify again.",
      });
    const row: MissionAcceptance = {
      id: `acceptance_${crypto.randomUUID()}`,
      missionId: id,
      at: new Date().toISOString(),
      fingerprint,
      status: !op.signal.aborted && checks.every((c) => c.ok) && !after.blockers.length ? "passed" : "failed",
      checks,
      evidence,
    };
    saveAcceptance(db, row);
    op.finish(
      row.status,
      row.id,
      row.status === "passed"
        ? "Mission accepted. Combined checks passed."
        : "Mission was not accepted. Review the verification result.",
    );
    return row;
  } catch (error) {
    op.finish(
      "failed",
      null,
      error instanceof OperationInputError
        ? redactOperationLog(error.message)
        : "Verification could not complete. Inspect the mission and repository setup before trying again.",
    );
    throw error;
  } finally {
    busy.delete(id);
  }
}

const delivering = new WeakMap<Db, Set<string>>();
/** No stage is silently retried: external actions may have succeeded before a process stopped. */
export async function advanceDelivery(
  db: Db,
  repoId: string,
  stage: Delivery["stage"],
  dataDir: string,
  previousId?: string,
  automatic = false,
  onStarted?: OnOperationStarted,
): Promise<Delivery> {
  let busy = delivering.get(db);
  if (!busy) {
    busy = new Set();
    delivering.set(db, busy);
  }
  if (busy.has(repoId)) throw new OperationInputError("A delivery action is already running for this repository.");
  busy.add(repoId);
  const op = operation(db, "delivery", repoId, stage, onStarted);
  let record: Delivery | null = null;
  try {
    const repo = getRepo(db, repoId);
    if (!repo) throw new OperationInputError("Repository not found.");
    const policy = deliverySnapshot(repo)!;
    const stages = ["check", "deploy", "release"];
    if (automatic && stages.indexOf(stage) > stages.indexOf(policy.automatic))
      throw new OperationInputError("This delivery stage needs your approval.");
    if (!policy.branch || !policy[stage]?.trim() || !policy.check.trim())
      throw new OperationInputError("Configure the delivery branch and stage commands first.");
    const sha = await resolveSha(repo.path, `refs/heads/${policy.branch}`);
    if (!sha) throw new OperationInputError("The configured local delivery branch does not exist.");
    const previous = previousId ? getDelivery(db, previousId) : null;
    if (
      stage !== "check" &&
      (!previous ||
        previous.repoId !== repoId ||
        previous.status !== "passed" ||
        previous.stage !== stages[stages.indexOf(stage) - 1] ||
        previous.sha !== sha ||
        hash(previous.policy) !== hash(policy))
    )
      throw new OperationInputError("Pass the preceding delivery stage on this commit with these settings first.");
    if (
      stage !== "check" &&
      deliveriesForCommit(db, repoId, sha).some((d) => d.stage === stage && d.status !== "failed")
    )
      throw new OperationInputError(
        "This stage was already attempted for this commit. Inspect its outcome before starting a new release.",
      );
    const env: Record<string, string> = { NC_STAGE: stage, NC_BRANCH: policy.branch };
    for (const name of policy.environment) env[name] = "";
    if (stage !== "check")
      for (const name of policy.environment) {
        if (!process.env[name])
          throw new OperationInputError(`Required environment variable ${name} is not set in the runner.`);
        env[name] = process.env[name]!;
      }
    const at = new Date().toISOString();
    record = {
      id: `delivery_${crypto.randomUUID()}`,
      repoId,
      sha,
      branch: policy.branch,
      policy,
      stage,
      status: "running",
      log: "",
      createdAt: at,
      updatedAt: at,
    };
    saveDelivery(db, record);
    auditEvent(db, automatic ? "crew" : "you", `delivery.${stage}.started`, repoId, record.id);
    // Recheck after waiting for the repository lock, before a command with side effects.
    const result = await checkedDeliveryCommand(repo, sha, policy, stage, dataDir, env, db, op);
    record.status = op.signal.aborted ? "interrupted" : result.ok ? "passed" : "failed";
    record.log = result.detail;
  } catch (error) {
    if (!record) {
      op.finish(
        "failed",
        null,
        error instanceof OperationInputError
          ? redactOperationLog(error.message)
          : "Delivery could not start. Review the repository settings.",
      );
      throw error;
    }
    record.status = "interrupted";
    record.log = "Delivery could not complete. Inspect the configured command and external outcome before retrying.";
  } finally {
    busy.delete(repoId);
  }
  record.updatedAt = new Date().toISOString();
  saveDelivery(db, record);
  op.finish(record.status, record.id, `Delivery ${stage} ${record.status}. Review the recorded outcome.`);
  auditEvent(db, automatic ? "crew" : "you", `delivery.${stage}.${record.status}`, repoId, record.id);
  return record;
}

async function checkedDeliveryCommand(
  repo: Repo,
  sha: string,
  policy: Delivery["policy"],
  stage: Delivery["stage"],
  dataDir: string,
  env: Record<string, string>,
  db: Db,
  op: OperationContext,
) {
  // checkedCommand takes the same repo lock; validate inside its callback through the command guard.
  const current = getRepo(db, repo.id);
  if (
    hash(deliverySnapshot(current)) !== hash(policy) ||
    (await resolveSha(repo.path, `refs/heads/${policy.branch}`)) !== sha
  )
    return { ok: false, detail: "Delivery settings or branch changed. Run verification again." };
  const result = await checkedCommand(
    repo,
    sha,
    policy[stage],
    dataDir,
    env,
    async () =>
      hash(deliverySnapshot(getRepo(db, repo.id))) === hash(policy) &&
      (await resolveSha(repo.path, `refs/heads/${policy.branch}`)) === sha,
    op,
  );
  if (!result.ok) return result;
  if (
    hash(deliverySnapshot(getRepo(db, repo.id))) !== hash(policy) ||
    (await resolveSha(repo.path, `refs/heads/${policy.branch}`)) !== sha
  )
    return {
      ok: false,
      detail: "Settings or branch changed during delivery. Inspect the external outcome before continuing.",
    };
  return result;
}

export async function automaticDelivery(db: Db, repoId: string, dataDir: string) {
  const repo = getRepo(db, repoId);
  const policy = deliverySnapshot(repo);
  if (!repo || !policy || policy.automatic === "off" || !policy.branch || delivering.get(db)?.has(repoId)) return;
  const sha = await resolveSha(repo.path, `refs/heads/${policy.branch}`);
  if (!sha) return;
  const history = deliveriesForCommit(db, repoId, sha);
  if (history.some((d) => d.status !== "passed" || hash(d.policy) !== hash(policy))) return;
  const stages: Delivery["stage"][] = ["check", "deploy", "release"];
  const next = stages.find((stage) => !history.some((d) => d.stage === stage));
  if (!next || stages.indexOf(next) > stages.indexOf(policy.automatic as Delivery["stage"])) return;
  const previous = history.find((d) => d.stage === stages[stages.indexOf(next) - 1]);
  await advanceDelivery(db, repoId, next, dataDir, previous?.id, true);
}

export function startMissionAcceptance(
  db: Db,
  id: string,
  fingerprint: string,
  evidence: MissionAcceptance["evidence"],
  dataDir: string,
) {
  return startInBackground((started) => acceptMission(db, id, fingerprint, evidence, dataDir, started));
}
export function startDelivery(db: Db, repoId: string, stage: Delivery["stage"], dataDir: string, previousId?: string) {
  return startInBackground((started) => advanceDelivery(db, repoId, stage, dataDir, previousId, false, started));
}
