import { validateDelivery, validatePolicies } from "@nightcrew/core";
import {
  auditEvent,
  type Db,
  getCheckpoint,
  getDelivery,
  getRepo,
  getRun,
  getTask,
  listAudit,
  listDeliveries,
  listRepos,
  listTemplates,
  saveDelivery,
  saveTemplate,
  schema,
  updateRepo,
  updateTask,
} from "@nightcrew/db";
import { acceptMission, advanceDelivery, type Crew, missionReadiness, stopOperations } from "@nightcrew/runner";
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
  app.post("/api/operations/stop", (c) => {
    stopOperations(db);
    auditEvent(db, "you", "operations.stop", "operations");
    return c.json({ ok: true });
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
  app.get("/api/policy-templates", (c) => c.json(listTemplates(db)));
  app.post("/api/policy-templates", async (c) => {
    const value = await c.req.json().catch(() => null);
    if (!value || typeof value.name !== "string" || !value.name.trim() || value.name.length > 100)
      return c.json({ error: "Name the template (up to 100 characters)." }, 400);
    const error = validatePolicies(value.policies);
    if (error) return c.json({ error }, 400);
    return c.json(saveTemplate(db, { name: value.name.trim(), policies: value.policies }), 201);
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
      (value.previousId !== undefined && typeof value.previousId !== "string")
    )
      return c.json({ error: "Choose check, deploy or release." }, 400);
    if (!deps.publish && value.stage !== "check")
      return c.json({ error: "Publishing is disabled for this runner." }, 409);
    try {
      return c.json(await advanceDelivery(db, c.req.param("id"), value.stage, dataDir, value.previousId));
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
