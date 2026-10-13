import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { phaseMeasurements } from "@nightcrew/core";
import {
  addRepo,
  createMission,
  createTask,
  getRun,
  getTask,
  listRunEvents,
  missionTokens,
  openDb,
  updateTask,
} from "@nightcrew/db";
import { Crew } from "./crew";
import { ScriptedEngine } from "./engine";
import { git } from "./git";
import { runTask } from "./pipeline";

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "nc-usage-recovery-"));
  const path = join(dir, "repo");
  mkdirSync(path);
  writeFileSync(join(path, "README.md"), "# Synthetic usage fixture\n");
  await git(path, "init", "-q", "-b", "main");
  await git(path, "add", "-A");
  await git(path, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "init");
  const dbPath = join(dir, "crew.db");
  const db = openDb(dbPath);
  const repo = addRepo(db, { name: "Synthetic", path, defaultBranch: "main" });
  const mission = createMission(db, { title: "Usage recovery", objective: "Preserve observed usage" });
  const task = createTask(db, { repoId: repo.id, title: "Observe usage", type: "research", missionId: mission.id });
  return { dir, dbPath, db, repo, mission, task };
}

test("a killed worker retains an atomic usage checkpoint and charges it after recovery", async () => {
  const { dir, dbPath, db, task, mission } = await fixture();
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const worker = join(dir, "worker.ts");
    writeFileSync(
      worker,
      `
      import { openDb } from ${JSON.stringify(new URL("../../db/src/index.ts", import.meta.url).href)};
      import { runTask } from ${JSON.stringify(new URL("./pipeline.ts", import.meta.url).href)};
      import { ScriptedEngine } from ${JSON.stringify(new URL("./engine.ts", import.meta.url).href)};
      const engine = new ScriptedEngine({ research: async (_request, emit) => {
        emit({ kind: "usage", text: "Observed usage", tokensIn: 10000, tokensOut: 20 });
        console.log("checkpoint-saved");
        await new Promise(() => setInterval(() => {}, 1000));
        return {};
      } });
      await runTask({ db: openDb(Bun.argv[2]), engine, dataDir: Bun.argv[4], models: { plan: "p", build: "b", review: "r" }, publish: false }, Bun.argv[3], new AbortController().signal);
    `,
    );
    child = Bun.spawn([process.execPath, worker, dbPath, task.id, join(dir, "data")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    killTimer = setTimeout(() => child?.kill("SIGKILL"), 5000);
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    const output = await reader.read();
    expect(new TextDecoder().decode(output.value)).toContain("checkpoint-saved");
    reader.releaseLock();
    child.kill("SIGKILL");
    await child.exited;
    const runId = getTask(db, task.id)!.lastRunId!;
    expect(getRun(db, runId)?.run).toMatchObject({ status: "running", tokensIn: 10000, tokensOut: 20 });
    const crew = new Crew({ db, engine: new ScriptedEngine({}), dataDir: join(dir, "data"), publish: false });
    expect(crew.recover()).toBe(1);
    expect(getRun(db, runId)?.run).toMatchObject({ status: "failed", tokensIn: 10000, tokensOut: 20 });
    expect(missionTokens(db, mission.id)).toBe(10020);
    expect(phaseMeasurements(listRunEvents(db, runId), false)).toMatchObject([
      { status: "interrupted", tokensIn: 10000, tokensOut: 20, usageStatus: "partial", costUsd: null, turns: null },
    ]);
    await crew.shutdown();
  } finally {
    if (killTimer) clearTimeout(killTimer);
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 10000);

test("terminal totals replace streamed observations and retries retain earlier charges", async () => {
  const { dir, db, task, mission } = await fixture();
  try {
    const engine = new ScriptedEngine({
      research: (_request, emit) => {
        emit({ kind: "usage", text: "Observed usage", tokensIn: 400, tokensOut: 40 });
        const runId = getTask(db, task.id)!.lastRunId!;
        expect(getRun(db, runId)?.run).toMatchObject({ tokensIn: 400, tokensOut: 40 });
        emit({ kind: "usage", text: "Observed usage", tokensIn: 400, tokensOut: 40 });
        return { text: "Research complete", tokensIn: 500, tokensOut: 50, usageStatus: "reported", costUsd: 0.2 };
      },
    });
    const deps = {
      db,
      engine,
      dataDir: join(dir, "data"),
      models: { plan: "p", build: "b", review: "r" },
      publish: false,
    };
    const first = await runTask(deps, task.id, new AbortController().signal);
    expect(first.status).toBe("complete");
    expect(getRun(db, first.runId)?.run).toMatchObject({ tokensIn: 500, tokensOut: 50, costCents: 20 });
    expect(missionTokens(db, mission.id)).toBe(550);
    const second = await runTask(deps, task.id, new AbortController().signal);
    expect(second.status).toBe("complete");
    expect(missionTokens(db, mission.id)).toBe(1100);
  } finally {
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a thrown engine error preserves the latest partial usage in the run ledger", async () => {
  const { dir, db, task, mission } = await fixture();
  try {
    const engine = new ScriptedEngine({
      research: (_request, emit) => {
        emit({ kind: "usage", text: "Observed usage", tokensIn: 400, tokensOut: 40 });
        emit({ kind: "usage", text: "Observed usage", tokensIn: 500, tokensOut: 50 });
        throw Error("Connection lost");
      },
    });
    const result = await runTask(
      { db, engine, dataDir: join(dir, "data"), models: { plan: "p", build: "b", review: "r" }, publish: false },
      task.id,
      new AbortController().signal,
    );
    expect(result.status).toBe("failed");
    expect(getRun(db, result.runId)?.run).toMatchObject({ tokensIn: 500, tokensOut: 50 });
    expect(missionTokens(db, mission.id)).toBe(550);
  } finally {
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("phase snapshots preserve earlier phase totals instead of replacing or adding them twice", async () => {
  const { dir, db, task, mission } = await fixture();
  try {
    updateTask(db, task.id, { type: "implementation", workflow: "planned", scope: ["README.md"] });
    let checkpointCount = 0;
    const engine = new ScriptedEngine({
      plan: (_req, emit) => {
        emit({ kind: "usage", text: "Usage", tokensIn: 100, tokensOut: 10 });
        checkpointCount++;
        return { text: "Update README", tokensIn: 200, tokensOut: 20 };
      },
      implement: (req, emit) => {
        emit({ kind: "usage", text: "Usage", tokensIn: 300, tokensOut: 30 });
        expect(getRun(db, getTask(db, task.id)!.lastRunId!)?.run).toMatchObject({ tokensIn: 500, tokensOut: 50 });
        checkpointCount++;
        writeFileSync(join(req.cwd, "README.md"), "# Updated synthetic example\n");
        return { text: "Updated", tokensIn: 400, tokensOut: 40 };
      },
      review: (_req, emit) => {
        emit({ kind: "usage", text: "Usage", tokensIn: 500, tokensOut: 50 });
        expect(getRun(db, getTask(db, task.id)!.lastRunId!)?.run).toMatchObject({ tokensIn: 1100, tokensOut: 110 });
        checkpointCount++;
        return {
          tokensIn: 600,
          tokensOut: 60,
          structured: { verdict: "ready", summary: "Verified", criteria: [], concerns: [], report: "Verified" },
        };
      },
    });
    const result = await runTask(
      { db, engine, dataDir: join(dir, "data"), models: { plan: "p", build: "b", review: "r" }, publish: false },
      task.id,
      new AbortController().signal,
    );
    expect(result.status).toBe("complete");
    expect(checkpointCount).toBe(3);
    expect(getRun(db, result.runId)?.run).toMatchObject({ tokensIn: 1200, tokensOut: 120, costCents: 30 });
    expect(missionTokens(db, mission.id)).toBe(1320);
  } finally {
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
