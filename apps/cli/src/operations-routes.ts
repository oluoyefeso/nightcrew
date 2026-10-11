import { portableTemplate, validateDelivery, validatePolicies, validateTemplateName } from "@nightcrew/core";
import {
  auditEvent,
  type Db,
  deleteTemplate,
  getAcceptance,
  getCheckpoint,
  getDelivery,
  getOperationJob,
  getRepo,
  getRepositoryCheck,
  getRun,
  getTask,
  getTemplate,
  listAudit,
  listDeliveries,
  listOperationJobs,
  listRepos,
  listTemplates,
  saveDelivery,
  saveTemplate,
  schema,
  updateRepo,
  updateTask,
  updateTemplate,
} from "@nightcrew/db";
import {
  acceptMission,
  advanceDelivery,
  type Crew,
  deliveryReadiness,
  missionReadiness,
  repositoryReadiness,
  startDelivery,
  startMissionAcceptance,
  startRepositoryVerification,
  stopOperation,
  stopOperations,
} from "@nightcrew/runner";
import { desc, eq } from "drizzle-orm";
import type { Hono } from "hono";

export function mountOperationsRoutes(app: Hono, deps: { db: Db; crew: Crew; dataDir: string; publish: boolean }) {
  const { db, crew, dataDir } = deps;
  app.get("/api/operations", (c) => {
    const recent = db
      .select({
        id: schema.runs.id,
        status: schema.runs.status,
        verdict: schema.runs.verdict,
        repo: schema.runs.repo,
        tokensIn: schema.runs.tokensIn,
        tokensOut: schema.runs.tokensOut,
        startedAt: schema.runs.startedAt,
        endedAt: schema.runs.endedAt,
        attempt: schema.runs.attempt,
      })
      .from(schema.runs)
      .where(eq(schema.runs.source, "local"))
      .orderBy(desc(schema.runs.startedAt))
      .limit(100)
      .all();
    const completed = recent.filter((r) => ["complete", "failed", "timeout", "blocked"].includes(r.status));
    c.header("cache-control", "no-store");
    return c.json({
      audit: listAudit(db),
      deliveries: listDeliveries(db),
      jobs: listOperationJobs(db),
      reliability: {
        sample: completed.length,
        ready: completed.filter((r) => r.status === "complete" && r.verdict === "ready").length,
        failed: completed.filter((r) => r.status === "failed" || r.status === "timeout").length,
        retries: completed.filter((r) => r.attempt > 1).length,
        tokens: completed.reduce((sum, r) => sum + r.tokensIn + r.tokensOut, 0),
        recent,
      },
      setup: listRepos(db).map((repo) => ({
        repoId: repo.id,
        name: repo.name,
        checks: [
          { label: "Verification command", ok: Boolean(repo.testCommand?.trim()) },
          { label: "Preview command for UI work", ok: Boolean(repo.previewCommand?.trim()) },
          { label: "Task routes customised", ok: Object.keys(repo.policies ?? {}).length > 0 },
          { label: "Delivery branch and checks", ok: Boolean(repo.delivery?.branch && repo.delivery.check.trim()) },
        ],
      })),
    });
  });
  app.get("/api/results/:kind/:id", (c) => {
    const { kind, id } = c.req.param();
    const result =
      kind === "delivery"
        ? getDelivery(db, id)
        : kind === "mission"
          ? getAcceptance(db, id)
          : kind === "repository"
            ? getRepositoryCheck(db, id)
            : null;
    c.header("cache-control", "no-store");
    return result ? c.json({ kind, result }) : c.json({ error: "Saved result not found." }, 404);
  });
  app.get("/api/repos/:id/delivery-readiness", async (c) => {
    const id = c.req.param("id");
    if (!getRepo(db, id)) return c.json({ error: "Repository not found." }, 404);
    c.header("cache-control", "no-store");
    return c.json(await deliveryReadiness(db, id, deps.publish));
  });
  app.post("/api/operations/stop", (c) => {
    stopOperations(db);
    auditEvent(db, "you", "operations.stop", "operations");
    return c.json({ ok: true });
  });
  app.get("/api/operations/:id", (c) => {
    const job = getOperationJob(db, c.req.param("id"));
    c.header("cache-control", "no-store");
    return job ? c.json(job) : c.json({ error: "Operation not found." }, 404);
  });
  app.post("/api/operations/:id/stop", (c) => {
    const id = c.req.param("id");
    if (!getOperationJob(db, id)) return c.json({ error: "Operation not found." }, 404);
    if (!stopOperation(db, id)) return c.json({ error: "This operation is no longer running." }, 409);
    return c.json(getOperationJob(db, id));
  });
  app.post("/api/deliveries/:id/allow-retry", async (c) => {
    const row = getDelivery(db, c.req.param("id"));
    if (row?.status !== "interrupted")
      return c.json({ error: "Only an interrupted action needs this acknowledgement." }, 409);
    const body = await c.req.json().catch(() => null);
    if (body?.inspected !== true)
      return c.json({ error: "Inspect the external outcome before allowing a retry." }, 400);
    saveDelivery(db, {
      ...row,
      status: "failed",
      updatedAt: new Date().toISOString(),
      log: `${row.log}\nYou inspected the external outcome and allowed a manual retry.`,
    });
    auditEvent(db, "you", "delivery.retry_allowed", row.repoId, row.id);
    return c.json({ ok: true });
  });
  app.get("/api/audit", (c) => c.json(listAudit(db, Number(c.req.query("before")) || undefined)));
  app.get("/api/repos/:id/readiness", async (c) => {
    const id = c.req.param("id");
    if (!getRepo(db, id)) return c.json({ error: "Repository not found." }, 404);
    c.header("cache-control", "no-store");
    return c.json(await repositoryReadiness(db, id));
  });
  app.post("/api/repos/:id/verify-setup", async (c) => {
    const id = c.req.param("id");
    if (!getRepo(db, id)) return c.json({ error: "Repository not found." }, 404);
    const value = await c.req.json().catch(() => null);
    if (!value || typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.fingerprint))
      return c.json({ error: "Provide the current repository setup snapshot." }, 400);
    try {
      return c.json(await startRepositoryVerification(db, id, value.fingerprint, dataDir), 202);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : "Repository verification could not start." },
        409,
      );
    }
  });
  app.get("/api/policy-templates", (c) => c.json(listTemplates(db)));
  app.post("/api/policy-templates", async (c) => {
    const value = await c.req.json().catch(() => null);
    const error = validateTemplateName(value?.name) ?? validatePolicies(value?.policies);
    if (error) return c.json({ error }, 400);
    return c.json(saveTemplate(db, { name: value.name.trim(), policies: value.policies }), 201);
  });
  app.get("/api/policy-templates/:id/export", (c) => {
    const row = getTemplate(db, c.req.param("id"));
    if (!row) return c.json({ error: "Template not found." }, 404);
    c.header("cache-control", "no-store");
    c.header("content-disposition", 'attachment; filename="nightcrew-verification.json"');
    return c.json(portableTemplate(row.name, row.policies));
  });
  app.patch("/api/policy-templates/:id", async (c) => {
    const id = c.req.param("id");
    if (!getTemplate(db, id)) return c.json({ error: "Template not found." }, 404);
    const value = await c.req.json().catch(() => null);
    const error = validateTemplateName(value?.name) ?? validatePolicies(value?.policies);
    if (error) return c.json({ error }, 400);
    if (typeof value.expectedUpdatedAt !== "string" || !Number.isFinite(Date.parse(value.expectedUpdatedAt)))
      return c.json({ error: "Provide the template version you previewed." }, 400);
    const row = updateTemplate(db, id, value.expectedUpdatedAt, { name: value.name.trim(), policies: value.policies });
    return row
      ? c.json(row)
      : c.json({ error: "The template changed in another window. Preview its current version before saving." }, 409);
  });
  app.delete("/api/policy-templates/:id", async (c) => {
    const id = c.req.param("id");
    if (!getTemplate(db, id)) return c.json({ error: "Template not found." }, 404);
    const value = await c.req.json().catch(() => null);
    if (typeof value?.expectedUpdatedAt !== "string")
      return c.json({ error: "Provide the template version you previewed." }, 400);
    return deleteTemplate(db, id, value.expectedUpdatedAt)
      ? c.json({ ok: true })
      : c.json({ error: "The template changed in another window. Preview it again before deleting." }, 409);
  });
  app.post("/api/repos/:id/policy-template", async (c) => {
    const repo = getRepo(db, c.req.param("id"));
    if (!repo) return c.json({ error: "Repository not found." }, 404);
    const value = await c.req.json().catch(() => null);
    const template = listTemplates(db).find((t) => t.id === value?.templateId);
    if (!template) return c.json({ error: "Template not found." }, 404);
    const next = updateRepo(db, repo.id, { policies: template.policies });
    auditEvent(db, "you", "policy.template.applied", repo.id, template.id);
    void crew.pump();
    return c.json(next);
  });
  app.patch("/api/repos/:id/delivery", async (c) => {
    const id = c.req.param("id");
    if (!getRepo(db, id)) return c.json({ error: "Repository not found." }, 404);
    const value = await c.req.json().catch(() => null);
    const error = validateDelivery(value);
    if (error) return c.json({ error }, 400);
    const next = updateRepo(db, id, { delivery: value });
    void crew.pump();
    return c.json(next);
  });
  app.post("/api/repos/:id/deliver", async (c) => {
    const value = await c.req.json().catch(() => null);
    if (
      !value ||
      !["check", "deploy", "release"].includes(value.stage) ||
      (value.previousId !== undefined && typeof value.previousId !== "string") ||
      (value.fingerprint !== undefined &&
        (typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.fingerprint)))
    )
      return c.json({ error: "Choose check, deploy or release." }, 400);
    if (!deps.publish && value.stage !== "check")
      return c.json({ error: "Publishing is disabled for this runner." }, 409);
    try {
      if (c.req.query("background") === "1")
        return c.json(
          await startDelivery(db, c.req.param("id"), value.stage, dataDir, value.previousId, value.fingerprint),
          202,
        );
      return c.json(
        await advanceDelivery(
          db,
          c.req.param("id"),
          value.stage,
          dataDir,
          value.previousId,
          false,
          undefined,
          value.fingerprint,
        ),
      );
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Delivery failed." }, 409);
    }
  });
  app.get("/api/missions/:id/acceptance", async (c) => {
    try {
      c.header("cache-control", "no-store");
      return c.json(await missionReadiness(db, c.req.param("id")));
    } catch {
      return c.json({ error: "Mission not found." }, 404);
    }
  });
  app.post("/api/missions/:id/acceptance", async (c) => {
    const value = await c.req.json().catch(() => null);
    if (
      !value ||
      typeof value.fingerprint !== "string" ||
      !Array.isArray(value.evidence) ||
      value.evidence.length > 30 ||
      value.evidence.some(
        (e: unknown) =>
          !e ||
          typeof e !== "object" ||
          !("criterion" in e) ||
          typeof e.criterion !== "string" ||
          !("evidence" in e) ||
          typeof e.evidence !== "string" ||
          !e.evidence.trim() ||
          e.evidence.length > 4000,
      )
    )
      return c.json({ error: "Provide the current snapshot and evidence notes for each criterion." }, 400);
    try {
      if (c.req.query("background") === "1")
        return c.json(
          await startMissionAcceptance(db, c.req.param("id"), value.fingerprint, value.evidence, dataDir),
          202,
        );
      return c.json(await acceptMission(db, c.req.param("id"), value.fingerprint, value.evidence, dataDir));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Verification failed." }, 409);
    }
  });
  app.get("/api/tasks/:id/recovery", (c) => {
    const task = getTask(db, c.req.param("id"));
    if (!task) return c.json({ error: "Task not found." }, 404);
    const checkpoint = getCheckpoint(db, task.id);
    const run = task.lastRunId ? getRun(db, task.lastRunId)?.run : null;
    return c.json({
      checkpoint: checkpoint ? { stage: checkpoint.stage, runId: checkpoint.runId, at: checkpoint.at } : null,
      retries: task.autoRetries ?? 0,
      reason: run?.reason ?? null,
    });
  });
  app.post("/api/tasks/:id/recover", async (c) => {
    const task = getTask(db, c.req.param("id"));
    if (!task) return c.json({ error: "Task not found." }, 404);
    if (task.status === "running" || task.status === "queued")
      return c.json({ error: "Stop or park this task before choosing a recovery action." }, 409);
    const value = await c.req.json().catch(() => null);
    if (!value || !["auto", "verify", "rebuild"].includes(value.mode))
      return c.json({ error: "Choose resume, verify or rebuild." }, 400);
    if (value.mode === "verify" && getCheckpoint(db, task.id)?.stage !== "build")
      return c.json({ error: "No saved build is available for verification." }, 409);
    const next = updateTask(db, task.id, { recoveryMode: value.mode, status: "queued", runAt: null, autoRetries: 0 });
    auditEvent(db, "you", `recovery.${value.mode}`, task.id);
    void crew.pump();
    return c.json(next);
  });
}
