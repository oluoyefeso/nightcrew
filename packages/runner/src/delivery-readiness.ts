import { createHash } from "node:crypto";
import { DEFAULT_DELIVERY, type Delivery, type DeliveryReadiness, type Repo } from "@nightcrew/core";
import { type Db, deliveriesForCommit, getRepo, getSettings, latestOperationJob } from "@nightcrew/db";
import { resolveSha } from "./git";
import { OperationInputError } from "./operation-progress";

export const deliveryStages: Delivery["stage"][] = ["check", "deploy", "release"];
export const deliveryHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const deliverySnapshot = (repo: Repo | null) =>
  repo ? { ...(repo.delivery ?? DEFAULT_DELIVERY), setupCommand: repo.setupCommand } : null;

export async function deliveryContext(db: Db, repoId: string) {
  const repo = getRepo(db, repoId);
  if (!repo) throw new OperationInputError("Repository not found.");
  const policy = deliverySnapshot(repo)!;
  const sha = policy.branch ? await resolveSha(repo.path, `refs/heads/${policy.branch}`) : null;
  return {
    repo,
    policy,
    sha,
    history: sha ? deliveriesForCommit(db, repoId, sha) : [],
    fingerprint: deliveryHash({ repoId, path: repo.path, policy, sha }),
  };
}

/** Shared by the preview and executor. Authority and active-job checks are applied by their caller. */
export function deliveryStageBlockers(
  context: Awaited<ReturnType<typeof deliveryContext>>,
  stage: Delivery["stage"],
  previousId?: string | null,
  publish = true,
): string[] {
  const { policy, sha, history } = context;
  const blockers: string[] = [];
  if (!policy.branch || !policy[stage]?.trim() || !policy.check.trim())
    blockers.push("Configure the delivery branch and stage commands first.");
  if (policy.branch && !sha) blockers.push("The configured local delivery branch does not exist.");
  if (stage !== "check") {
    if (!publish) blockers.push("Publishing is disabled for this runner.");
    const previous = history.find((row) => row.id === previousId);
    if (
      previous?.status !== "passed" ||
      previous.stage !== deliveryStages[deliveryStages.indexOf(stage) - 1] ||
      deliveryHash(previous.policy) !== deliveryHash(policy)
    )
      blockers.push("Pass the preceding delivery stage on this commit with these settings first.");
    if (history.some((row) => row.stage === stage && row.status !== "failed"))
      blockers.push(
        "This stage was already attempted for this commit. Inspect its outcome before starting a new release.",
      );
    for (const name of policy.environment)
      if (!process.env[name]) blockers.push(`Required environment variable ${name} is not set in the runner.`);
  }
  return blockers;
}

export async function deliveryReadiness(db: Db, repoId: string, publish = true): Promise<DeliveryReadiness> {
  const context = await deliveryContext(db, repoId);
  const { policy, history } = context;
  const operation = latestOperationJob(db, "delivery", repoId);
  const busy = operation?.status === "running" || operation?.status === "stopping";
  const stages = deliveryStages.map((stage, index) => {
    const previous = history.find(
      (row) =>
        row.stage === deliveryStages[index - 1] &&
        row.status === "passed" &&
        deliveryHash(row.policy) === deliveryHash(policy),
    );
    const latest = history.find((row) => row.stage === stage);
    return {
      stage,
      previousId: previous?.id ?? null,
      latest: latest ? { id: latest.id, status: latest.status, createdAt: latest.createdAt } : null,
      blockers: [
        ...(busy ? ["A delivery action is already running for this repository."] : []),
        ...deliveryStageBlockers(context, stage, previous?.id, publish),
      ],
    };
  });
  const next = deliveryStages.find((stage) => !history.some((row) => row.stage === stage)) ?? null;
  const automaticBlockers: string[] = [];
  if (!publish) automaticBlockers.push("Automatic delivery is disabled when publishing is disabled.");
  if (!getSettings(db).dispatch)
    automaticBlockers.push("Dispatch is paused. Automatic delivery waits until you resume it.");
  if (policy.automatic === "off") automaticBlockers.push("You start each delivery stage manually.");
  if (history.some((row) => row.status !== "passed"))
    automaticBlockers.push(
      "A failed, interrupted or unfinished attempt holds automatic delivery for this commit. Inspect the outcome and continue manually.",
    );
  if (history.some((row) => deliveryHash(row.policy) !== deliveryHash(policy)))
    automaticBlockers.push("Delivery settings changed since an attempt on this commit. Verify and continue manually.");
  if (!next) automaticBlockers.push("Every delivery stage has an attempt on this commit.");
  else if (policy.automatic !== "off" && deliveryStages.indexOf(next) > deliveryStages.indexOf(policy.automatic))
    automaticBlockers.push(`Automatic authority stops after ${policy.automatic}. You decide whether to continue.`);
  if (next) automaticBlockers.push(...stages.find((row) => row.stage === next)!.blockers);
  return {
    fingerprint: context.fingerprint,
    branch: policy.branch,
    sha: context.sha,
    stages,
    automatic: { through: policy.automatic, next: automaticBlockers.length ? null : next, blockers: automaticBlockers },
    operation,
  };
}
