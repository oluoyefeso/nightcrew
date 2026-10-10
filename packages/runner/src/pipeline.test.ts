import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addNote,
  addRepo,
  createTask,
  type Db,
  getRun,
  getTask,
  listRunEvents,
  openDb,
  updateTask,
} from "@nightcrew/db";
import { ScriptedEngine } from "./engine";
import { git } from "./git";
import { runTask } from "./pipeline";
import type { ReviewOutput } from "./prompts";

let dir: string;
let repoPath: string;
let db: Db;

const READY: ReviewOutput = {
  verdict: "ready",
  summary: "Looks right.",
  criteria: [{ criterion: "Feature file exists", met: true, evidence: "src/feature.ts" }],
  concerns: [],
  report: "All good.",
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "nc-run-"));
  repoPath = join(dir, "acme");
  mkdirSync(join(repoPath, "src"), { recursive: true });
  writeFileSync(join(repoPath, "src", "index.ts"), "export const x = 1;\n");
  await git(repoPath, "init", "-q", "-b", "main");
  await git(repoPath, "add", "-A");
  await git(repoPath, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  db = openDb(":memory:");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function deps(engine: ScriptedEngine) {
  return { db, engine, dataDir: join(dir, "data"), models: { plan: "p", build: "b", review: "r" }, publish: false };
}

function setupTask(over: Parameters<typeof createTask>[1] extends infer T ? Partial<T> : never = {}) {
  const repo = addRepo(db, {
    name: "acme",
    path: repoPath,
    defaultBranch: "main",
    testCommand: "test -f src/feature.ts",
  });
  return createTask(db, {
    repoId: repo.id,
    workflow: "planned",
    title: "Add the feature",
    scope: ["src/**"],
    criteria: ["Feature file exists"],
    status: "queued",
    ...over,
  });
}

describe("runTask", () => {
  test("plans, implements, checks, reviews and commits on the task branch", async () => {
    const task = setupTask();
    const engine = new ScriptedEngine({
      plan: () => ({ text: "Add src/feature.ts.\n\n1. Create the file." }),
      implement: (req, emit) => {
        emit({ kind: "tool", tool: "Write", input: {}, text: "Wrote src/feature.ts" });
        writeFileSync(join(req.cwd, "src", "feature.ts"), "export const feature = true;\n");
        writeFileSync(join(req.guard.writableDirs[0] as string, "DECISIONS.md"), "- What: a const\n");
        return { text: "Added src/feature.ts; checks pass." };
      },
      review: () => ({ structured: READY, text: "" }),
    });
    const out = await runTask(deps(engine), task.id, new AbortController().signal);
    expect(out.status).toBe("complete");

    const detail = getRun(db, out.runId);
    expect(detail?.run.status).toBe("complete");
    expect(detail?.run.summary).toBe("Added src/feature.ts; checks pass.");
    expect(detail?.run.verdict).toBe("ready");
    expect(detail?.run.additions).toBe(1);
    expect(detail?.artifacts.map((a) => a.kind).sort()).toEqual(["decisions", "plan", "review", "tests"]);
    expect(getTask(db, task.id)?.status).toBe("done");

    const wt = detail?.run.branch ? join(repoPath, ".worktrees", "crew-add-the-feature") : "";
    expect((await git(wt, "log", "--oneline", "main..HEAD")).stdout).toContain("Add the feature");
    // Artifacts live in NightCrew's folder, not the repo.
    expect((await git(wt, "ls-files")).stdout).not.toContain("DECISIONS");
    // The plan phase was read-only and the implementer got the plan.
    expect(engine.calls.find((c) => c.phase === "plan")?.guard.readOnly).toBe(true);
    expect(engine.calls.find((c) => c.phase === "implement")?.prompt).toContain("Add src/feature.ts.");
    expect(listRunEvents(db, out.runId).map((e) => e.text)).toContain("Wrote src/feature.ts");
  });

  test("failed checks get one repair attempt with the failure output", async () => {
    const task = setupTask();
    const engine = new ScriptedEngine({
      implement: (req) => {
        writeFileSync(join(req.cwd, "README.md"), "out of scope\n");
        writeFileSync(join(req.cwd, "src", "feature.ts"), "x\n");
        return { text: "Done." };
      },
      repair: (req) => {
        expect(req.prompt).toContain("Outside the task's scope: README.md");
        unlinkSync(join(req.cwd, "README.md"));
        return { text: "Removed the stray README change." };
      },
      review: () => ({ structured: READY }),
    });
    const out = await runTask(deps(engine), task.id, new AbortController().signal);
    expect(out.status).toBe("complete");
    expect(engine.calls.map((c) => c.phase)).toEqual(["plan", "implement", "repair", "review"]);
  });

  test("still failing after the repair fails the run with the reason", async () => {
    const task = setupTask();
    const engine = new ScriptedEngine({
      implement: (req) => {
        writeFileSync(join(req.cwd, "src", "other.ts"), "x\n"); // tests want feature.ts
        return { text: "Done." };
      },
    });
    const out = await runTask(deps(engine), task.id, new AbortController().signal);
    expect(out.status).toBe("failed");
    expect(out.reason).toContain("`test -f src/feature.ts` failed");
    expect(getRun(db, out.runId)?.run.bucket).toBe("failed");
  });

  test("finishing without changes is a failure", async () => {
    const task = setupTask();
    const out = await runTask(deps(new ScriptedEngine({})), task.id, new AbortController().signal);
    expect(out.status).toBe("failed");
    expect(out.reason).toBe("The crew finished without changing anything.");
  });

  test("a reviewer asking for a closer look lands in Needs your eyes", async () => {
    const task = setupTask();
    const engine = new ScriptedEngine({
      implement: (req) => {
        writeFileSync(join(req.cwd, "src", "feature.ts"), "x\n");
        return { text: "Done." };
      },
      review: () => ({ structured: { ...READY, verdict: "needs_eyes", concerns: ["No error handling"] } }),
    });
    const out = await runTask(deps(engine), task.id, new AbortController().signal);
    const run = getRun(db, out.runId)?.run;
    expect(run?.verdict).toBe("needs_eyes");
    expect(run?.bucket).toBe("eyes");
  });

  test("a sent-back task resumes its branch with your note in the prompt", async () => {
    const task = setupTask();
    const write = new ScriptedEngine({
      implement: (req) => {
        writeFileSync(join(req.cwd, "src", "feature.ts"), "v1\n");
        return { text: "v1" };
      },
      review: () => ({ structured: READY }),
    });
    await runTask(deps(write), task.id, new AbortController().signal);
    addNote(db, task.id, "you", "Name it featureFlag instead.");
    updateTask(db, task.id, { status: "queued" });

    const again = new ScriptedEngine({
      implement: (req) => {
        expect(req.prompt).toContain("Name it featureFlag instead.");
        expect(req.prompt).toContain("already has 1 commit");
        writeFileSync(join(req.cwd, "src", "feature.ts"), "v2\n");
        return { text: "v2" };
      },
      review: () => ({ structured: READY }),
    });
    const out = await runTask(deps(again), task.id, new AbortController().signal);
    expect(out.status).toBe("complete");
    expect(getRun(db, out.runId)?.attempts).toHaveLength(2);
  });

  test("research writes a report and touches no code", async () => {
    const task = setupTask({ type: "research", title: "How does auth work?" });
    const engine = new ScriptedEngine({
      research: (req) => {
        expect(req.guard.readOnly).toBe(true);
        writeFileSync(join(req.guard.writableDirs[0] as string, "REPORT.md"), "# Auth\nTokens live in src/index.ts.");
        return { text: "Auth uses tokens stored in src/index.ts." };
      },
    });
    const out = await runTask(deps(engine), task.id, new AbortController().signal);
    expect(out.status).toBe("complete");
    expect(getRun(db, out.runId)?.artifacts.map((a) => a.kind)).toEqual(["report"]);
  });
});

test("files written by NightCrew's dependency install don't count against scope or get committed", async () => {
  const repo = addRepo(db, {
    name: "acme",
    path: repoPath,
    defaultBranch: "main",
    testCommand: "test -f src/feature.ts",
    setupCommand: "echo lock > package-lock.json",
  });
  const task = createTask(db, {
    repoId: repo.id,
    title: "Add the feature",
    workflow: "quick",
    scope: ["src/**"],
    status: "queued",
  });
  const engine = new ScriptedEngine({
    implement: (req) => {
      writeFileSync(join(req.cwd, "src", "feature.ts"), "x\n");
      return { text: "Done." };
    },
    review: () => ({ structured: READY }),
  });
  const out = await runTask(deps(engine), task.id, new AbortController().signal);
  expect(out.status).toBe("complete");
  const wt = join(repoPath, ".worktrees", "crew-add-the-feature");
  expect((await git(wt, "show", "--stat", "--name-only", "HEAD")).stdout).not.toContain("package-lock.json");
});
