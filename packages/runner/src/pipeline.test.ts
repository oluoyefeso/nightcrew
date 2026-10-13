import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TASK_POLICY, phaseMeasurements, type Repo } from "@nightcrew/core";
import { guardToolCall } from "@nightcrew/core/guard";
import {
  addNote,
  addRepo,
  createTask,
  type Db,
  getRun,
  getTask,
  listRunEvents,
  listTrains,
  openDb,
  updateRepo,
  updateTask,
} from "@nightcrew/db";
import { ScriptedEngine } from "./engine";
import { git } from "./git";
import { normalizeReview, runTask, scopeCheck } from "./pipeline";
import type { ReviewOutput } from "./prompts";
import { TAMPERED } from "./sdk-engine";
import { workspaceDir } from "./workspace";

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
  test("phase starts survive engine failure and reported usage is saved before the run ends", async () => {
    const task = setupTask({ type: "research" });
    const engine = new ScriptedEngine({
      research: () => {
        const runId = getTask(db, task.id)!.lastRunId!;
        expect(phaseMeasurements(listRunEvents(db, runId), true)).toHaveLength(1);
        expect(phaseMeasurements(listRunEvents(db, runId), true)[0]?.status).toBe("running");
        return { ok: false, error: "Connection closed.", tokensIn: 40, tokensOut: 10, usageStatus: "partial" };
      },
    });
    const outcome = await runTask(deps(engine), task.id, new AbortController().signal);
    expect(outcome.status).toBe("failed");
    expect(phaseMeasurements(listRunEvents(db, outcome.runId), false)).toMatchObject([
      { phase: "research", status: "failed", tokensIn: 40, tokensOut: 10, costUsd: null, usageStatus: "partial" },
    ]);
    expect(getRun(db, outcome.runId)?.run).toMatchObject({ tokensIn: 40, tokensOut: 10 });
  });

  test("a task-type plan cap forces planning even for a quick task", async () => {
    const task = setupTask({ workflow: "quick" });
    updateRepo(db, task.repoId, {
      level: "train",
      policies: { implementation: { ...DEFAULT_TASK_POLICY, autonomy: "propose" } },
    });
    const engine = new ScriptedEngine({ plan: () => ({ text: "A plan for your review." }) });
    const out = await runTask(deps(engine), task.id, new AbortController().signal);
    expect(out.status).toBe("complete");
    expect(engine.calls.map((call) => call.phase)).toEqual(["plan"]);
    expect(getRun(db, out.runId)?.run.verdict).toBe("needs_eyes");
    expect(listTrains(db)).toHaveLength(0);
  });

  const routeCases: {
    name: string;
    initial: Partial<Repo>;
    duringReview?: Partial<Repo>;
    reason?: string;
    authority: string;
  }[] = [
    {
      name: "a type cap stops a train repo at a draft",
      initial: { level: "train", policies: { implementation: { ...DEFAULT_TASK_POLICY, autonomy: "draft_pr" } } },
      authority: "Draft PR",
    },
    {
      name: "a required command cannot be skipped",
      initial: {
        level: "train",
        testCommand: null,
        policies: { implementation: { ...DEFAULT_TASK_POLICY, requireTests: true } },
      },
      reason: "configured test command",
      authority: "Daily train",
    },
    {
      name: "new visual requirements hold work after evidence collection",
      initial: { level: "train" },
      duringReview: { policies: { implementation: { ...DEFAULT_TASK_POLICY, visual: true } } },
      reason: "visual evidence",
      authority: "Daily train",
    },
    {
      name: "a whitespace-only command cannot satisfy required tests",
      initial: {
        level: "train",
        testCommand: "   ",
        policies: { implementation: { ...DEFAULT_TASK_POLICY, requireTests: true } },
      },
      reason: "configured test command",
      authority: "Daily train",
    },
    {
      name: "a promotion cannot expand an in-flight run",
      initial: { level: "draft_pr" },
      duringReview: { level: "train" },
      authority: "Draft PR",
    },
    {
      name: "a demotion to plan holds the implementation locally",
      initial: { level: "train" },
      duringReview: { level: "propose" },
      reason: "held locally",
      authority: "Plan → your review",
    },
    {
      name: "always-ask paths hold train tasks too",
      initial: { level: "train", alwaysAsk: ["src/feature.ts"] },
      reason: "always wait for you",
      authority: "Daily train",
    },
  ];
  test.each(routeCases)("$name", async ({ initial, duringReview, reason, authority }) => {
    const task = setupTask();
    updateRepo(db, task.repoId, initial);
    const engine = new ScriptedEngine({
      implement: (req) => {
        writeFileSync(join(req.cwd, "src/feature.ts"), "export const feature = true;\n");
        return { text: "Done." };
      },
      review: () => {
        if (duringReview) updateRepo(db, task.repoId, duringReview);
        return { structured: READY };
      },
    });
    const out = await runTask(deps(engine), task.id, new AbortController().signal);
    expect(out.status).toBe("complete");
    const detail = getRun(db, out.runId);
    expect(detail?.run.trainId).toBeNull();
    expect(detail?.run.shipSha).toBeNull();
    expect(listTrains(db)).toHaveLength(0);
    expect(detail?.artifacts.find((a) => a.kind === "policy")?.content).toContain(authority);
    if (reason) {
      expect(out.reason).toContain(reason);
      expect(detail?.run.verdict).toBe("needs_eyes");
    } else {
      expect(out.reason).toBeNull();
      expect(detail?.run.verdict).toBe("ready");
    }
  });

  test("a ship policy hold survives as the reason the Station presents for review", async () => {
    const task = setupTask();
    updateRepo(db, task.repoId, {
      level: "ship",
      shipBranch: "dev",
      allowShip: ["src/**"],
      alwaysAsk: ["src/feature.ts"],
    });
    const engine = new ScriptedEngine({
      implement: (req) => {
        writeFileSync(join(req.cwd, "src/feature.ts"), "export const feature = true;\n");
        return { text: "Done." };
      },
      review: () => ({ structured: READY }),
    });
    const outcome = await runTask(deps(engine), task.id, new AbortController().signal);
    expect(outcome.status).toBe("complete");
    expect(outcome.reason).toContain("always wait for you: src/feature.ts");
    expect(getRun(db, outcome.runId)?.run.reason).toBe(outcome.reason);
    expect(getRun(db, outcome.runId)?.run.shipSha).toBeNull();
  });

  test.each([false, true])(
    "regression evidence must still match the reviewed files (review edits: %s)",
    async (edits) => {
      const task = setupTask({ type: "bugfix" });
      updateRepo(db, task.repoId, { level: "train", testCommand: "sh src/feature.test.sh" });
      const engine = new ScriptedEngine({
        implement: (req) => {
          writeFileSync(join(req.cwd, "src/feature.ts"), "export const feature = true;\n");
          writeFileSync(join(req.cwd, "src/feature.test.sh"), "test -f src/feature.ts\n");
          return { text: "Done." };
        },
        review: (req) => {
          if (edits) writeFileSync(join(req.cwd, "src/feature.ts"), "export const feature = false;\n");
          return { structured: READY };
        },
      });
      const out = await runTask(deps(engine), task.id, new AbortController().signal);
      expect(out.status).toBe("complete");
      const run = getRun(db, out.runId)?.run;
      if (edits) {
        expect(out.reason).toContain("Files changed after evidence collection");
        expect(run?.trainId).toBeNull();
        expect(run?.verdict).toBe("needs_eyes");
      } else {
        expect(out.reason).toBeNull();
        expect(run?.trainId).not.toBeNull();
        expect(run?.verdict).toBe("ready");
      }
    },
  );

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
    expect(detail?.artifacts.map((a) => a.kind).sort()).toEqual(["decisions", "plan", "policy", "review", "tests"]);
    expect(getTask(db, task.id)?.status).toBe("done");

    // The work happened in the task's own clone, outside the repo, and landed in the repo by fetch.
    const wt = workspaceDir(join(dir, "data"), task.repoId, task.id);
    expect(wt).toBe(join(dir, "data", "work", task.repoId, task.id));
    expect(statSync(join(wt, ".git")).isDirectory()).toBe(true);
    expect((await git(wt, "log", "--oneline", "main..HEAD")).stdout).toContain("Add the feature");
    expect((await git(repoPath, "log", "--oneline", `main..refs/nightcrew/tasks/${task.id}`)).stdout).toContain(
      "Add the feature",
    );
    // Artifacts live in NightCrew's folder, not the repo.
    expect((await git(wt, "ls-files")).stdout).not.toContain("DECISIONS");
    // The plan phase was read-only and the implementer got the plan.
    expect(engine.calls.find((c) => c.phase === "plan")?.guard.readOnly).toBe(true);
    // Every phase is marked as running in the task's own clone.
    expect(engine.calls.every((c) => c.isolated === true)).toBe(true);
    expect(engine.calls.find((c) => c.phase === "implement")?.prompt).toContain("Add src/feature.ts.");
    expect(listRunEvents(db, out.runId).map((e) => e.text)).toContain("Wrote src/feature.ts");
  });

  test("a task sent back after boarding the train boards again with its new work", async () => {
    // Value: protects=re-running a task whose earlier result is still on the train boards again, landing only what's new while the gate checks the task's whole change; fails_when=the merge-base rule refuses the task's own car, or the gate goes back to checking only the new delta; why_new=D16 replaced the re-pinned base; seam=none
    const task = setupTask();
    updateRepo(db, task.repoId, { level: "train" });
    let attempt = 0;
    const engine = new ScriptedEngine({
      implement: (req) => {
        attempt++;
        writeFileSync(join(req.cwd, "src", "feature.ts"), "export const feature = true;\n");
        if (attempt > 1) writeFileSync(join(req.cwd, "src", "extra.ts"), "export const extra = 1;\n");
        return { text: "Done." };
      },
      review: () => ({ structured: READY }),
    });
    const first = await runTask(deps(engine), task.id, new AbortController().signal);
    expect(first.status).toBe("complete");
    expect(listRunEvents(db, first.runId).some((e) => e.text.includes("On today's train"))).toBe(true);

    updateTask(db, task.id, { status: "queued" });
    const second = await runTask(deps(engine), task.id, new AbortController().signal);
    const texts = listRunEvents(db, second.runId).map((e) => e.text);
    expect(second.status).toBe("complete");
    expect(texts.some((t) => t.includes("takes in commits"))).toBe(false);
    expect(texts.some((t) => t.includes("On today's train"))).toBe(true);
    // The gate checked the task's whole change; only the new file landed the second time.
    expect(getRun(db, second.runId)?.run.changedFiles).toBe(2);
    const car = listTrains(db)[0]?.cars.find((c) => c.runId === second.runId);
    const landed = await git(repoPath, "diff", "--name-only", `${car?.mergeSha}^1`, `${car?.mergeSha}`);
    expect(landed.stdout.trim()).toBe("src/extra.ts");
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
    expect(getRun(db, out.runId)?.artifacts.map((a) => a.kind)).toEqual(["policy", "report"]);
  });

  test("a plan that fails with nothing written builds from the brief, in a fresh session", async () => {
    // Value: protects=a failed plan doesn't sink the task, and the builder doesn't resume the dead planning session; a plan that did write resumes it; fails_when=an empty failed plan fails the run, or its sessionId is still handed to implement; why_new=pipeline tests cover a stopped plan only; seam=none; no_claim=real SDK session resume (scripted engine)
    const task = setupTask({ model: "p" }); // same model as the planner, so a good plan's session is reused
    const engine = (planText: string) =>
      new ScriptedEngine({
        plan: () => ({
          ok: !!planText,
          text: planText,
          error: planText ? null : "Hit the turn limit.",
          sessionId: "sess_plan",
        }),
        implement: (req) => {
          writeFileSync(join(req.cwd, "src", "feature.ts"), "export const feature = true;\n");
          return { text: "Done." };
        },
        review: () => ({ structured: READY }),
      });
    const failed = engine("");
    const out = await runTask(deps(failed), task.id, new AbortController().signal);
    expect(out.status).toBe("complete");
    const impl = failed.calls.find((c) => c.phase === "implement");
    expect(impl?.resumeSession).toBeUndefined();
    expect(
      listRunEvents(db, out.runId).some((e) => e.text.includes("Planning didn't finish (Hit the turn limit.)")),
    ).toBe(true);
    expect(getRun(db, out.runId)?.artifacts.map((a) => a.kind)).not.toContain("plan");

    updateTask(db, task.id, { status: "queued" });
    const planned = engine("Add src/feature.ts.");
    await runTask(deps(planned), task.id, new AbortController().signal);
    expect(planned.calls.find((c) => c.phase === "implement")?.resumeSession).toBe("sess_plan");
  });

  test("checks the reviewer broke fail the run, and nothing is accepted or boards the train", async () => {
    // Value: protects=work the reviewer changed must pass the checks again before it lands; fails_when=the post-review recheck is dropped or ignored and broken work is accepted, boards the train or opens a PR; why_new=no test lets the review phase change files; seam=none; no_claim=the real reviewer's edits (scripted engine; train level, publish off)
    const task = setupTask();
    updateRepo(db, task.repoId, { level: "train" });
    const engine = new ScriptedEngine({
      implement: (req) => {
        writeFileSync(join(req.cwd, "src", "feature.ts"), "export const feature = true;\n");
        return { text: "Done." };
      },
      review: (req) => {
        unlinkSync(join(req.cwd, "src", "feature.ts"));
        writeFileSync(join(req.cwd, "src", "renamed.ts"), "export const feature = true;\n");
        return { structured: READY };
      },
    });
    const out = await runTask(deps(engine), task.id, new AbortController().signal);
    expect(out.status).toBe("failed");
    expect(out.reason).toBe("Checks failed after review: `test -f src/feature.ts` failed (exit 1).");
    expect(out.log).toContain("src/renamed.ts");
    expect(listTrains(db)).toHaveLength(0);
    expect((await git(repoPath, "rev-parse", "--verify", "--quiet", `refs/nightcrew/tasks/${task.id}`)).ok).toBe(false);
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
  const shown = await git(repoPath, "show", "--stat", "--name-only", `refs/nightcrew/tasks/${task.id}`);
  expect(shown.stdout).toContain("src/feature.ts");
  expect(shown.stdout).not.toContain("package-lock.json");
});

test("a failed dependency install is logged with the end of its output", async () => {
  // Value: protects=the setup failure event carries a short tail of the install's output so you can see why; fails_when=the event only says the exit code; why_new=cycle-3 review: setup failure log had no stderr; seam=none
  const repo = addRepo(db, {
    name: "acme",
    path: repoPath,
    defaultBranch: "main",
    testCommand: "test -f src/feature.ts",
    setupCommand: "echo 'lockfile is out of date' >&2; exit 1",
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
  const failed = listRunEvents(db, out.runId).find((e) => e.text.startsWith("Dependency install failed"));
  expect(failed?.text).toContain("lockfile is out of date");
});

describe("token budget split", () => {
  // Value: protects=plan gets a capped slice, build leaves the reviewer its reserve, and caps used in full never pass the task's tokenBudget; fails_when=a cap formula or the review reserve changes; why_new=no test asserted per-phase maxTokens; seam=none
  test.each([
    // budget, plan cap, build cap, review cap (each phase burns its whole cap)
    [1_000_000, 200_000, 550_000, 250_000],
    [4_000_000, 800_000, 2_900_000, 300_000],
    [200_000, 60_000, 90_000, 50_000],
  ])("budget %d → plan %d, build %d, review %d", async (budget, plan, build, review) => {
    const task = setupTask({ tokenBudget: budget });
    const burn = (req: { maxTokens: number }) => ({ tokensIn: req.maxTokens, tokensOut: 0 });
    const engine = new ScriptedEngine({
      plan: (req) => ({ text: "Add src/feature.ts.", ...burn(req) }),
      implement: (req) => {
        writeFileSync(join(req.cwd, "src", "feature.ts"), "x\n");
        return { text: "Done.", ...burn(req) };
      },
      review: () => ({ structured: READY, tokensIn: 0, tokensOut: 0 }),
    });
    const out = await runTask(deps(engine), task.id, new AbortController().signal);
    expect(out.status).toBe("complete");
    const cap = (phase: string) => engine.calls.find((c) => c.phase === phase)?.maxTokens;
    expect(engine.calls.map((c) => c.phase)).toEqual(["plan", "implement", "review"]);
    expect(cap("plan")).toBe(plan);
    expect(cap("implement")).toBe(build);
    expect(cap("review")).toBe(review);
    expect(plan + build + review).toBe(budget);
  });
});

describe("stopping", () => {
  test("a plan cut short by a stop doesn't go on to build", async () => {
    // Value: protects=a stop during planning ends the run, even when the planner left partial text; fails_when=the pipeline builds from a half plan after you pressed Stop; why_new=R1 only checked abort when the plan was empty; seam=none
    const task = setupTask();
    const stop = new AbortController();
    const engine = new ScriptedEngine({
      plan: () => {
        stop.abort();
        return { ok: false, text: "1. Add src/feature.ts\n2. Wire it", error: "Stopped." };
      },
    });
    const out = await runTask(deps(engine), task.id, stop.signal);
    expect(out.status).toBe("timeout");
    expect(out.reason).toBe("Stopped while planning.");
    expect(engine.calls.map((c) => c.phase)).toEqual(["plan"]);
  });

  test("at the propose level a stopped plan is not a finished proposal", async () => {
    // Value: protects=propose-level runs stopped mid-plan end stopped, not complete; fails_when=a partial plan from a stopped planner is reported as done; why_new=R1 propose path finished "complete" on any plan text; seam=none
    const task = setupTask();
    updateRepo(db, task.repoId, { level: "propose" });
    const stop = new AbortController();
    const engine = new ScriptedEngine({
      plan: () => {
        stop.abort();
        return { ok: true, text: "A partial plan." };
      },
    });
    const out = await runTask(deps(engine), task.id, stop.signal);
    expect(out.status).toBe("timeout");
  });

  test("a stop during checks kills the test command and skips review and commit", async () => {
    // Value: protects=a stop kills the running test command and nothing after it runs; fails_when=run() ignores the signal (the stop waits out the tests) or review/publish still run after a stop; why_new=R1 validate got no signal and nothing checked abort before review; seam=none
    const task = setupTask({ testCommand: "sleep 30" });
    const stop = new AbortController();
    const engine = new ScriptedEngine({
      implement: (req) => {
        writeFileSync(join(req.cwd, "src", "feature.ts"), "x\n");
        setTimeout(() => stop.abort(), 300);
        return { text: "Done." };
      },
      review: () => ({ structured: READY }),
    });
    const started = Date.now();
    const out = await runTask(deps(engine), task.id, stop.signal);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(out.status).toBe("timeout");
    expect(out.reason).toBe("Stopped while checking the work.");
    expect(engine.calls.map((c) => c.phase)).toEqual(["plan", "implement"]);
    // The work is kept as WIP on the branch, not committed as finished.
    const wt = workspaceDir(join(dir, "data"), task.repoId, task.id);
    expect((await git(wt, "log", "-1", "--format=%s")).stdout).toContain("Checkpoint: Add the feature");
  });

  test("a task past its time limit ends as out of time, with its work saved", async () => {
    // Value: protects=a task that runs past maxMinutes is cut off as timeout with "Ran out of time", and its work is saved as WIP for the next attempt;
    // fails_when=the time limit isn't joined into the stop signal (the agent runs on), or the reason says Stopped as if you pressed Stop; why_new=only manual stops were tested;
    // seam=none; no_claim=minute-scale limits (a 3-second maxMinutes stands in; the agent waits on its stop signal like a real engine)
    const task = setupTask({ maxMinutes: 0.05 });
    let cutOff = false;
    const engine = new ScriptedEngine({
      implement: async (req) => {
        writeFileSync(join(req.cwd, "src", "feature.ts"), "half\n");
        await new Promise<void>((done) => {
          const giveUp = setTimeout(done, 12_000);
          req.signal.addEventListener("abort", () => {
            cutOff = true;
            clearTimeout(giveUp);
            done();
          });
        });
        return cutOff ? { ok: false, text: "", error: "Stopped." } : { text: "Done." };
      },
      review: () => ({ structured: READY }),
    });
    const started = Date.now();
    const out = await runTask(deps(engine), task.id, new AbortController().signal);
    expect(cutOff).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(out.status).toBe("timeout");
    expect(out.reason).toBe("Ran out of time while building.");
    expect(engine.calls.map((c) => c.phase)).not.toContain("review");
    const wip = (await git(repoPath, "log", "-1", "--format=%s", `refs/nightcrew/wip/${task.id}`)).stdout;
    expect(wip).toContain("WIP: Add the feature");
    expect((await git(repoPath, "show", `refs/nightcrew/wip/${task.id}:src/feature.ts`)).stdout).toBe("half\n");
  }, 20_000);
});

describe("review output", () => {
  test("a partial review doesn't crash and doesn't count as ready", async () => {
    // Value: protects=a reviewer answer missing fields is shape-checked, and "ready" without any criteria checked needs a person; fails_when=renderReview crashes on missing arrays or a bare {verdict:"ready"} ships as ready; why_new=O1 trusted review.structured as ReviewOutput; seam=none
    const task = setupTask();
    const engine = new ScriptedEngine({
      implement: (req) => {
        writeFileSync(join(req.cwd, "src", "feature.ts"), "x\n");
        return { text: "Done." };
      },
      review: () => ({ structured: { verdict: "ready" } }),
    });
    const out = await runTask(deps(engine), task.id, new AbortController().signal);
    expect(out.status).toBe("complete");
    const run = getRun(db, out.runId);
    expect(run?.run.verdict).toBe("needs_eyes");
    expect(run?.artifacts.find((a) => a.kind === "review")?.content).toContain("Review: Ready");
  });

  test("garbage from the reviewer lands in Needs your eyes", async () => {
    // Value: protects=a review that isn't a known verdict is treated as no review; fails_when=any JSON object (managed mode's lastJsonObject) is cast to ReviewOutput; why_new=O1 had no shape check; seam=none
    const task = setupTask();
    const engine = new ScriptedEngine({
      implement: (req) => {
        writeFileSync(join(req.cwd, "src", "feature.ts"), "x\n");
        return { text: "Done." };
      },
      review: () => ({ structured: { verdict: "lgtm", criteria: "all", concerns: 3 }, text: "lgtm" }),
    });
    const out = await runTask(deps(engine), task.id, new AbortController().signal);
    expect(out.status).toBe("complete");
    const run = getRun(db, out.runId);
    expect(run?.run.verdict).toBe("needs_eyes");
    expect(run?.artifacts.find((a) => a.kind === "review")?.content).toBe("lgtm");
  });

  test("a ready verdict with an unmet or unreported criterion needs your eyes", async () => {
    // Value: protects=ready only counts when every criterion was reported and met; fails_when=a "ready" with met=false, or with fewer criteria than the task has, is shipped as ready; why_new=G8 only zero reported criteria was caught; seam=none
    const reviews: ReviewOutput[] = [
      { ...READY, criteria: [{ criterion: "Feature file exists", met: false, evidence: "missing" }] },
      READY,
    ];
    const tasks = [setupTask(), setupTask({ title: "Two criteria", criteria: ["Feature file exists", "Docs"] })];
    for (const [i, task] of tasks.entries()) {
      const engine = new ScriptedEngine({
        implement: (req) => {
          writeFileSync(join(req.cwd, "src", "feature.ts"), "x\n");
          return { text: "Done." };
        },
        review: () => ({ structured: reviews[i] }),
      });
      const out = await runTask(deps(engine), task.id, new AbortController().signal);
      expect(out.status).toBe("complete");
      expect(getRun(db, out.runId)?.run.verdict).toBe("needs_eyes");
    }
  });

  test("normalizeReview keeps well-formed entries and drops the rest", () => {
    // Value: protects=malformed criteria, concerns and challenges are dropped, strings default to empty; fails_when=a bad entry reaches renderReview or prBody; why_new=O1 normalizer is new; seam=none
    expect(normalizeReview(null)).toBeNull();
    expect(normalizeReview({ verdict: "maybe" })).toBeNull();
    expect(
      normalizeReview({
        verdict: "not_done",
        summary: 4,
        criteria: [{ criterion: "a", met: true, evidence: "e" }, { criterion: "b" }, "c"],
        concerns: ["x", 2],
        challenges: [{ challenge: "edge", held: true }, { held: false }],
      }),
    ).toEqual({
      verdict: "not_done",
      summary: "",
      criteria: [{ criterion: "a", met: true, evidence: "e" }],
      concerns: ["x"],
      challenges: [{ challenge: "edge", held: true, detail: "" }],
      report: "",
    });
  });
});

describe("pinned base", () => {
  test("moving main onto the agent's commit doesn't hide an out-of-scope file", async () => {
    // Value: protects=scope checks diff against the fork point pinned before any agent ran, not the movable local main; fails_when=changedFiles/validate go back to diffing against the default branch's name and an agent hides a workflow change by moving main; why_new=G1 the base was a ref the agent can move; seam=none
    const task = setupTask();
    const engine = new ScriptedEngine({
      implement: async (req) => {
        writeFileSync(join(req.cwd, "src", "feature.ts"), "x\n");
        mkdirSync(join(req.cwd, ".github", "workflows"), { recursive: true });
        writeFileSync(join(req.cwd, ".github", "workflows", "ci.yml"), "on: push\n");
        await git(req.cwd, "add", "-A");
        await git(req.cwd, "-c", "user.name=a", "-c", "user.email=a@a", "commit", "-qm", "work");
        await git(req.cwd, "update-ref", "refs/heads/main", "HEAD");
        return { text: "Done." };
      },
      review: () => ({ structured: READY }),
    });
    const out = await runTask(deps(engine), task.id, new AbortController().signal);
    expect(out.status).toBe("failed");
    expect(out.reason).toBe(
      ".github/workflows/ci.yml is always protected (workflows, secrets and git settings NightCrew won't land); take it out of the change.",
    );
    // A failed gate leaves the work in progress, not a result.
    expect((await git(repoPath, "rev-parse", "--verify", "--quiet", `refs/nightcrew/wip/${task.id}`)).ok).toBe(true);
    expect((await git(repoPath, "rev-parse", "--verify", "--quiet", `refs/nightcrew/tasks/${task.id}`)).ok).toBe(false);
  });
});

describe("integration branches", () => {
  test("task runs can't move the ship branch or today's train", async () => {
    // Value: protects=the guard treats the ship branch and train branches as protected during task runs; fails_when=protectedBranches is only the repo's list and an agent can `git branch -f dev HEAD`; why_new=G2 integration branches were unprotected; seam=none
    const task = setupTask();
    updateRepo(db, task.repoId, { shipBranch: "dev" });
    const engine = new ScriptedEngine({
      implement: (req) => {
        writeFileSync(join(req.cwd, "src", "feature.ts"), "x\n");
        return { text: "Done." };
      },
      review: () => ({ structured: READY }),
    });
    await runTask(deps(engine), task.id, new AbortController().signal);
    const guard = engine.calls.find((c) => c.phase === "implement")?.guard;
    if (!guard) throw new Error("no implement call");
    const train = guard.protectedBranches.find((b) => b.startsWith("crew/train-"));
    expect(guard.protectedBranches).toContain("dev");
    expect(train).toBeTruthy();
    for (const command of ["git branch -f dev HEAD", `git update-ref refs/heads/${train} HEAD`, "git checkout dev"])
      expect(guardToolCall("Bash", { command }, guard).allow).toBe(false);
  });
});

describe("trust changed while a task runs", () => {
  /** Writes the feature, and runs `during` while the crew is still building. */
  const building = (during: () => void = () => {}) =>
    new ScriptedEngine({
      implement: (req) => {
        writeFileSync(join(req.cwd, "src", "feature.ts"), "export const feature = true;\n");
        during();
        return { text: "Done." };
      },
      review: () => ({ structured: READY }),
    });

  test("a repo demoted from ship to train mid-run boards the train instead of shipping", async () => {
    // Value: protects=you can take Ship to dev away while agents are running and no run already in flight ships on the old setting; fails_when=runTask lands with the repo it read at the start; why_new=Z3; seam=none
    await git(repoPath, "branch", "dev");
    const first = setupTask();
    updateRepo(db, first.repoId, { level: "ship", shipBranch: "dev", allowShip: ["src/**"] });
    const shipped = await runTask(deps(building()), first.id, new AbortController().signal);
    expect(getRun(db, shipped.runId)?.run.shipSha).toBeTruthy();

    const second = createTask(db, {
      repoId: first.repoId,
      title: "Second",
      scope: ["src/**"],
      criteria: ["Feature file exists"],
      status: "queued",
    });
    const engine = building(() => updateRepo(db, first.repoId, { level: "train" }));
    const out = await runTask(deps(engine), second.id, new AbortController().signal);
    expect(getRun(db, out.runId)?.run.shipSha).toBeNull();
    const texts = listRunEvents(db, out.runId).map((e) => e.text);
    expect(texts.some((t) => t.startsWith("Shipped to"))).toBe(false);
    expect(texts.some((t) => t.startsWith("On today's train"))).toBe(true);
  });

  test("a scope narrowed mid-run is what the final gate checks", async () => {
    // Value: protects=narrowing a task's scope while it runs stops files outside the new scope from landing; fails_when=the final gate checks the scope read at the start of the run; why_new=Z3; seam=none
    const task = setupTask();
    const engine = building(() => updateTask(db, task.id, { scope: ["docs/**"] }));
    const out = await runTask(deps(engine), task.id, new AbortController().signal);
    expect(out.status).toBe("failed");
    expect(out.reason).toContain("Changed files outside scope: src/feature.ts");
  });

  test("a task archived mid-run lands nothing and stays archived", async () => {
    // Value: protects=archiving a task while its agent works keeps the run off the train and leaves the task archived; fails_when=runTask drops its live() re-read and lands with the task it read at the start, or finish() overwrites archived with done; why_new=Z3 tests cover a demoted repo and narrowed scope, not an archived task; seam=none; no_claim=ship and PR levels (same live() check, train level only here)
    const task = setupTask();
    updateRepo(db, task.repoId, { level: "train" });
    const engine = building(() => updateTask(db, task.id, { status: "archived" }));
    const out = await runTask(deps(engine), task.id, new AbortController().signal);
    expect(out.status).toBe("failed");
    expect(out.reason).toContain("archived or deleted while it ran");
    expect(listTrains(db)).toHaveLength(0);
    expect(getTask(db, task.id)?.status).toBe("archived");
  });
});

describe("rate limits", () => {
  test("only a failed run whose last phase was rate limited reports a rate limit", async () => {
    // Value: protects=rateLimited means the run failed because of a rate limit, so the crew backs off only then; fails_when=an early rate limit the run got past is sticky, or a stop or timeout after one reports rateLimited; why_new=G7 rateLimited was set once and never cleared; seam=none
    const limitedPlan = { text: "Add src/feature.ts.", rateLimited: true };
    // Planning hit a limit but went on; the real failure is the checks.
    const realFailure = setupTask();
    const failing = await runTask(
      deps(
        new ScriptedEngine({
          plan: () => limitedPlan,
          implement: (req) => {
            writeFileSync(join(req.cwd, "src", "other.ts"), "x\n");
            return { text: "Done." };
          },
        }),
      ),
      realFailure.id,
      new AbortController().signal,
    );
    expect(failing.status).toBe("failed");
    expect(failing.rateLimited).toBe(false);

    // You pressed Stop after a rate-limited phase.
    const stopped = setupTask({ title: "Stopped one" });
    const stop = new AbortController();
    const halted = await runTask(
      deps(
        new ScriptedEngine({
          plan: () => {
            stop.abort();
            return limitedPlan;
          },
        }),
      ),
      stopped.id,
      stop.signal,
    );
    expect(halted.status).toBe("timeout");
    expect(halted.rateLimited).toBe(false);

    // The build itself was cut off by a limit.
    const limited = setupTask({ title: "Limited one" });
    const cut = await runTask(
      deps(
        new ScriptedEngine({
          implement: () => ({ ok: false, error: "Rate limited.", rateLimited: true }),
        }),
      ),
      limited.id,
      new AbortController().signal,
    );
    expect(cut.status).toBe("failed");
    expect(cut.rateLimited).toBe(true);
  });
});

describe("task clones", () => {
  test("a task with a worktree from an earlier version continues from its branch in a fresh clone", async () => {
    // Value: protects=tasks that already have <repo>/.worktrees/<slug> from earlier alphas resume their branch's commits in a new clone, and the old worktree is left alone; fails_when=the clone starts from main (losing the branch's work) or the legacy worktree is reused or removed; why_new=D12 legacy carry-over; seam=none
    const task = setupTask();
    const legacy = join(repoPath, ".worktrees", "crew-add-the-feature");
    await git(repoPath, "worktree", "add", "-q", "-b", task.branch, legacy, "main");
    writeFileSync(join(legacy, "src", "feature.ts"), "v0\n");
    await git(legacy, "add", "-A");
    await git(legacy, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "earlier work");
    const engine = new ScriptedEngine({
      implement: (req) => {
        expect(req.cwd).toBe(workspaceDir(join(dir, "data"), task.repoId, task.id));
        expect(req.prompt).toContain("already has 1 commit");
        expect(readFileSync(join(req.cwd, "src", "feature.ts"), "utf8")).toBe("v0\n");
        writeFileSync(join(req.cwd, "src", "feature.ts"), "v1\n");
        return { text: "Finished it." };
      },
      review: () => ({ structured: READY }),
    });
    const out = await runTask(deps(engine), task.id, new AbortController().signal);
    expect(out.status).toBe("complete");
    expect(engine.calls.map((c) => c.phase)).toContain("implement");
    expect(existsSync(join(legacy, ".git"))).toBe(true);
    const log = (await git(repoPath, "log", "--format=%s", `main..refs/nightcrew/tasks/${task.id}`)).stdout;
    expect(log).toContain("earlier work");
    expect(log).toContain("Add the feature");
  });

  test("a stopped task keeps its unfinished work in its clone and resumes it", async () => {
    // Value: protects=a stop commits the work in progress inside the clone (and copies it to your repo), and the next attempt starts from it; fails_when=the WIP commit is dropped, or a rerun makes a new clone from main; why_new=D12 resume after stop; seam=none
    const task = setupTask({ testCommand: "sleep 30" });
    const stop = new AbortController();
    const first = new ScriptedEngine({
      implement: (req) => {
        writeFileSync(join(req.cwd, "src", "feature.ts"), "half\n");
        setTimeout(() => stop.abort(), 300);
        return { text: "Halfway." };
      },
    });
    const halted = await runTask(deps(first), task.id, stop.signal);
    expect(halted.status).toBe("timeout");
    const wip = (await git(repoPath, "log", "-1", "--format=%s", `refs/nightcrew/wip/${task.id}`)).stdout;
    expect(wip).toContain("Checkpoint: Add the feature");
    // Unchecked work never becomes the task's result.
    expect((await git(repoPath, "rev-parse", "--verify", "--quiet", `refs/nightcrew/tasks/${task.id}`)).ok).toBe(false);

    updateTask(db, task.id, { status: "queued", testCommand: "test -f src/feature.ts", recoveryMode: "rebuild" });
    const again = new ScriptedEngine({
      implement: (req) => {
        expect(readFileSync(join(req.cwd, "src", "feature.ts"), "utf8")).toBe("half\n");
        expect(req.prompt).toContain("already has 1 commit");
        writeFileSync(join(req.cwd, "src", "feature.ts"), "whole\n");
        return { text: "Done." };
      },
      review: () => ({ structured: READY }),
    });
    const out = await runTask(deps(again), task.id, new AbortController().signal);
    expect(out.status).toBe("complete");
    const shown = await git(repoPath, "show", `refs/nightcrew/tasks/${task.id}:src/feature.ts`);
    expect(shown.stdout).toBe("whole\n");
  });

  test("an agent that moves refs in its clone doesn't move your repo's", async () => {
    // Value: protects=git work in the clone (moving main, creating branches) never reaches your repo's refs; fails_when=the clone shares your repo's refs again (linked worktrees); why_new=D12 isolation; seam=none
    const task = setupTask();
    const mainBefore = (await git(repoPath, "rev-parse", "main")).stdout.trim();
    const engine = new ScriptedEngine({
      implement: async (req) => {
        writeFileSync(join(req.cwd, "src", "feature.ts"), "x\n");
        await git(req.cwd, "add", "-A");
        await git(req.cwd, "-c", "user.name=a", "-c", "user.email=a@a", "commit", "-qm", "work");
        await git(req.cwd, "update-ref", "refs/heads/main", "HEAD");
        await git(req.cwd, "update-ref", "refs/heads/dev", "HEAD");
        return { text: "Done." };
      },
      review: () => ({ structured: READY }),
    });
    const out = await runTask(deps(engine), task.id, new AbortController().signal);
    expect(out.status).toBe("complete");
    expect((await git(repoPath, "rev-parse", "main")).stdout.trim()).toBe(mainBefore);
    expect((await git(repoPath, "rev-parse", "--verify", "--quiet", "refs/heads/dev")).ok).toBe(false);
  });
});

describe("the final gate and what the task leaves behind", () => {
  // Value: protects=committed .worktrees/ paths (where NightCrew keeps its integration checkouts) fail the gate, even for a task with no scope limit; fails_when=scopeCheck goes back to dropping .worktrees/ paths, which now hides them from the final host-side gate; why_new=G2 the filter moved onto the final gate; seam=none
  test("a task that commits files under .worktrees fails", async () => {
    const task = setupTask({ scope: [] });
    const engine = new ScriptedEngine({
      implement: (req) => {
        writeFileSync(join(req.cwd, "src", "feature.ts"), "x\n");
        mkdirSync(join(req.cwd, ".worktrees", "_dev"), { recursive: true });
        writeFileSync(join(req.cwd, ".worktrees", "_dev", "planted.ts"), "x\n");
        return { text: "Done." };
      },
      review: () => ({ structured: READY }),
    });
    const out = await runTask(deps(engine), task.id, new AbortController().signal);
    expect(out.status).toBe("failed");
    expect(out.reason).toContain("Changed files in .worktrees, where NightCrew keeps its own checkouts");
    expect(scopeCheck([".worktrees/_dev/planted.ts", "src/a.ts"], { scope: [] } as never).ok).toBe(false);
  });

  // Value: protects=protected paths are reported apart from out-of-scope ones, and matched case-insensitively (macOS reads .GITATTRIBUTES as .gitattributes), as are NightCrew's own paths; fails_when=scopeCheck folds protected files into "outside scope" or matches them case-sensitively; why_new=D16 item 8; seam=none
  test("protected files are named apart from out-of-scope ones, whatever their case", () => {
    const task = { scope: ["src/**"] } as never;
    expect(scopeCheck([".GITATTRIBUTES", "src/a.ts"], task).reason).toBe(
      ".GITATTRIBUTES is always protected (workflows, secrets and git settings NightCrew won't land); take it out of the change.",
    );
    expect(scopeCheck(["src/.Gitmodules", ".gitmodules"], { scope: [] } as never).reason).toContain(
      ".gitmodules is always protected",
    );
    expect(scopeCheck([".WorkTrees/_dev/x.ts"], { scope: [] } as never).reason).toContain(
      "Changed files in .worktrees",
    );
    expect(scopeCheck(["README.md"], task).reason).toBe("Changed files outside scope: README.md");
  });

  // Value: protects=a clone whose .git is swapped mid-run (here for a symlink to your repo's git dir) fails the task as tampered before NightCrew runs any git there, and the unfinished work isn't committed through it into your repo; fails_when=validate, commitInClone or the WIP save run git in a clone without checking .git is still a folder; why_new=D16 item 7; seam=none
  test("a clone whose .git is swapped mid-run fails as tampered", async () => {
    const task = setupTask();
    const mainBefore = (await git(repoPath, "rev-parse", "main")).stdout.trim();
    const engine = new ScriptedEngine({
      implement: (req) => {
        writeFileSync(join(req.cwd, "src", "feature.ts"), "x\n");
        rmSync(join(req.cwd, ".git"), { recursive: true, force: true });
        symlinkSync(join(repoPath, ".git"), join(req.cwd, ".git"));
        return { text: "Done." };
      },
      review: () => ({ structured: READY }),
    });
    const out = await runTask(deps(engine), task.id, new AbortController().signal);
    expect(out.status).toBe("failed");
    expect(out.reason).toBe(TAMPERED);
    expect(engine.calls.map((c) => c.phase)).toEqual(["plan", "implement"]);
    expect((await git(repoPath, "rev-parse", "main")).stdout.trim()).toBe(mainBefore);
    expect((await git(repoPath, "status", "--porcelain")).stdout).toBe("");
  });

  // Value: protects=a repo that relies on git-lfs fails the task up front with the plain-words reason, before any clone or agent phase; fails_when=runTask stops calling repoSupport, so the agent works in a clone with LFS pointer files; why_new=G6 (D15); seam=none
  test("a repo that uses git-lfs fails the task before anything runs", async () => {
    const task = setupTask();
    writeFileSync(join(repoPath, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
    const engine = new ScriptedEngine({});
    const out = await runTask(deps(engine), task.id, new AbortController().signal);
    expect(out.status).toBe("failed");
    expect(out.reason).toBe(
      "NightCrew can't work in this repo yet: it uses git-lfs (.gitattributes: *.bin filter=lfs). Support is coming; see docs/security.md.",
    );
    expect(engine.calls).toHaveLength(0);
    expect(existsSync(workspaceDir(join(dir, "data"), task.repoId, task.id))).toBe(false);
  });

  // Value: protects=when the local task branch can't take the work (it's checked out), the run says where the work really is and how to get it, and the no-remote message doesn't claim the branch holds it; fails_when=the pipeline ignores updateLocalBranch's result or goes back to "the branch stays local"; why_new=G7; seam=none
  test("a checked-out task branch points you at the task ref instead", async () => {
    const task = setupTask();
    await git(repoPath, "checkout", "-q", "-b", task.branch);
    const engine = new ScriptedEngine({
      implement: (req) => {
        writeFileSync(join(req.cwd, "src", "feature.ts"), "x\n");
        return { text: "Done." };
      },
      review: () => ({ structured: READY }),
    });
    const out = await runTask({ ...deps(engine), publish: true }, task.id, new AbortController().signal);
    expect(out.status).toBe("complete");
    const ref = `refs/nightcrew/tasks/${task.id}`;
    const texts = listRunEvents(db, out.runId).map((e) => e.text);
    expect(texts).toContain(
      `Couldn't update your ${task.branch} branch (${task.branch} is checked out). The work is at ${ref}; to get it, run: git checkout -b <name> ${ref}`,
    );
    expect(texts).toContain(`No GitHub remote, so the work stays local, at ${ref}.`);
    expect((await git(repoPath, "rev-parse", task.branch)).stdout.trim()).toBe(
      (await git(repoPath, "rev-parse", "main")).stdout.trim(),
    );
  });
});

describe("the task branch outside NightCrew", () => {
  const ID = ["-c", "user.name=t", "-c", "user.email=t@t"];
  const head = async (ref: string) => (await git(repoPath, "rev-parse", ref)).stdout.trim();
  const writes = (...files: string[]) =>
    new ScriptedEngine({
      implement: (req) => {
        for (const f of files) writeFileSync(join(req.cwd, f), `export const v = "${f}";\n`);
        return { text: "Done." };
      },
      review: () => ({ structured: READY }),
    });

  // Value: protects=GitHub's "Update branch" (main merged into the task branch on origin) is taken in with an info event instead of a refusal, and the gate still sees only the task's own files because the base moves to main's tip; fails_when=ensureWorkspace refuses origin commits that build on NightCrew's work, or the gate base stays at the old fork point and main's files fail scope; why_new=D16 item 6; seam=none
  test("origin's Update branch merge is picked up and the scope check still passes", async () => {
    const task = setupTask();
    expect((await runTask(deps(writes("src/feature.ts")), task.id, new AbortController().signal)).status).toBe(
      "complete",
    );
    const first = await head(`refs/nightcrew/tasks/${task.id}`);
    writeFileSync(join(repoPath, "README.md"), "main moved\n");
    await git(repoPath, "add", "-A");
    await git(repoPath, ...ID, "commit", "-qm", "main moves");
    const mainTip = await head("main");
    const tree = (await git(repoPath, "merge-tree", "--write-tree", first, mainTip)).stdout.trim();
    const update = (
      await git(repoPath, ...ID, "commit-tree", tree, "-p", first, "-p", mainTip, "-m", "Merge branch 'main'")
    ).stdout.trim();
    await git(repoPath, "update-ref", `refs/remotes/origin/${task.branch}`, update);
    await git(repoPath, "update-ref", "refs/remotes/origin/main", mainTip);

    updateTask(db, task.id, { status: "queued" });
    const out = await runTask(deps(writes("src/feature.ts", "src/extra.ts")), task.id, new AbortController().signal);
    const texts = listRunEvents(db, out.runId).map((e) => e.text);
    expect(out.reason).toBeNull();
    expect(out.status).toBe("complete");
    expect(texts).toContain(`Picked up 1 commit from origin/${task.branch}.`);
    expect(getRun(db, out.runId)?.run.changedFiles).toBe(2);
    expect((await git(repoPath, "merge-base", "--is-ancestor", update, `refs/nightcrew/tasks/${task.id}`)).ok).toBe(
      true,
    );
  });

  // Value: protects=when the crew amends its earlier commit the run says so and carries on (the gate checks the whole change), the local branch moves off NightCrew's own old result, and the next run doesn't blame you for the old commit; fails_when=a rewrite leaves the local branch behind and the next run refuses with "commits NightCrew didn't make"; why_new=D16 item 6 rewrite; seam=none
  test("a crew that amends its commit is noted, and the next run isn't blocked", async () => {
    const task = setupTask();
    await runTask(deps(writes("src/feature.ts")), task.id, new AbortController().signal);
    expect(await head(task.branch)).toBe(await head(`refs/nightcrew/tasks/${task.id}`));
    updateTask(db, task.id, { status: "queued" });
    const amend = new ScriptedEngine({
      implement: async (req) => {
        writeFileSync(join(req.cwd, "src", "extra.ts"), "x\n");
        await git(req.cwd, "add", "-A");
        await git(req.cwd, ...ID, "commit", "-q", "--amend", "-m", "one commit");
        return { text: "Done." };
      },
      review: () => ({ structured: READY }),
    });
    const second = await runTask(deps(amend), task.id, new AbortController().signal);
    expect(second.status).toBe("complete");
    expect(listRunEvents(db, second.runId).map((e) => e.text)).toContain(
      "The crew rewrote the branch history this run. NightCrew checks the whole change either way.",
    );
    expect(await head(task.branch)).toBe(await head(`refs/nightcrew/tasks/${task.id}`));

    updateTask(db, task.id, { status: "queued" });
    const third = await runTask(deps(writes("src/third.ts")), task.id, new AbortController().signal);
    expect(third.reason).toBeNull();
    expect(third.status).toBe("complete");
  });
});

describe("the draft PR", () => {
  test("pushes the task branch and opens a draft PR with the evidence and Closes #N; a failed push fails the run", async () => {
    // Value: protects=at the draft-PR level the task branch is pushed, then one draft PR opens with criteria, checks and Closes #N for issue tasks; a failed push fails the run with no PR;
    // fails_when=the push result is ignored (a PR for a branch origin lacks), or the Closes line is dropped from issue tasks' PRs; why_new=every runTask test ran with publish off;
    // seam=none; no_claim=GitHub acceptance or issue closing (fake gh first on PATH records the create call; bare local origin stands in for GitHub)
    const origin = join(dir, "origin.git");
    await git(dir, "init", "-q", "--bare", "-b", "main", origin);
    await git(repoPath, "remote", "add", "origin", origin);
    await git(repoPath, "push", "-q", "origin", "main");
    const out = join(dir, "gh-out");
    const bin = join(dir, "bin");
    mkdirSync(out);
    mkdirSync(bin);
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh
echo "$*" >> '${out}/calls'
case "$2" in
  list) echo '[]' ;;
  create)
    while [ $# -gt 0 ]; do
      case "$1" in
        --body-file) cp "$2" '${out}/body.md' ;;
        --head) printf '%s' "$2" > '${out}/head' ;;
      esac
      shift
    done
    echo https://github.com/o/acme/pull/42 ;;
  *) exit 2 ;;
esac
`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    const engine = () =>
      new ScriptedEngine({
        implement: (req) => {
          writeFileSync(join(req.cwd, "src", "feature.ts"), "export const feature = true;\n");
          return { text: "Added the feature." };
        },
        review: () => ({ structured: READY }),
      });
    try {
      const task = setupTask({ source: "github", sourceRef: "https://github.com/o/acme/issues/12" });
      const done = await runTask({ ...deps(engine()), publish: true }, task.id, new AbortController().signal);
      expect(done.reason).toBeNull();
      expect(done.status).toBe("complete");
      expect(done.prUrl).toBe("https://github.com/o/acme/pull/42");
      expect(getRun(db, done.runId)?.run.prUrl).toBe("https://github.com/o/acme/pull/42");
      // The branch is on origin before the PR names it.
      expect(readFileSync(join(out, "head"), "utf8")).toBe(task.branch);
      expect((await git(origin, "show", `${task.branch}:src/feature.ts`)).stdout).toBe(
        "export const feature = true;\n",
      );
      const body = readFileSync(join(out, "body.md"), "utf8");
      expect(body).toContain("- [x] Feature file exists: src/feature.ts");
      expect(body).toContain("<summary>Checks</summary>");
      expect(body).toContain("Closes #12");

      // A push that fails: the run fails with why, and no PR is opened.
      await git(repoPath, "config", "remote.origin.pushurl", join(dir, "closed.git"));
      const calls = readFileSync(join(out, "calls"), "utf8");
      const second = createTask(db, {
        repoId: task.repoId,
        workflow: "planned",
        title: "Add another feature",
        scope: ["src/**"],
        criteria: ["Feature file exists"],
        status: "queued",
      });
      const failed = await runTask({ ...deps(engine()), publish: true }, second.id, new AbortController().signal);
      expect(failed.status).toBe("failed");
      expect(failed.reason).toStartWith("Push failed:");
      expect(failed.prUrl).toBeNull();
      expect(readFileSync(join(out, "calls"), "utf8")).toBe(calls);
    } finally {
      process.env.PATH = path;
    }
  }, 30_000);
});

describe("phase recovery", () => {
  test("a failed build resumes a completed plan without another planner call", async () => {
    const task = setupTask();
    const first = new ScriptedEngine({
      plan: () => ({ text: "Build the feature." }),
      implement: () => ({ ok: false, error: "Temporary build failure." }),
    });
    expect((await runTask(deps(first), task.id, new AbortController().signal)).status).toBe("failed");
    const second = new ScriptedEngine({
      implement: (req) => {
        expect(req.prompt).toContain("Build the feature.");
        writeFileSync(join(req.cwd, "src/feature.ts"), "ready\n");
        return { text: "Ready." };
      },
      review: () => ({ structured: READY }),
    });
    expect((await runTask(deps(second), task.id, new AbortController().signal)).status).toBe("complete");
    expect(second.calls.map((c) => c.phase)).toEqual(["implement", "review"]);
  });

  test("verify mode reruns evidence and read-only review, without rebuilding or repairing", async () => {
    const task = setupTask({ testCommand: "false" });
    const first = new ScriptedEngine({
      implement: (req) => {
        writeFileSync(join(req.cwd, "src/feature.ts"), "ready\n");
        return { text: "Ready." };
      },
    });
    expect((await runTask(deps(first), task.id, new AbortController().signal)).status).toBe("failed");
    updateTask(db, task.id, { recoveryMode: "verify", testCommand: "test -f src/feature.ts" });
    const second = new ScriptedEngine({
      review: (req) => {
        expect(req.guard.readOnly).toBe(true);
        return { structured: READY };
      },
    });
    expect((await runTask(deps(second), task.id, new AbortController().signal)).status).toBe("complete");
    expect(second.calls.map((c) => c.phase)).toEqual(["review"]);
    updateTask(db, task.id, { testCommand: "false" });
    const third = new ScriptedEngine({});
    expect((await runTask(deps(third), task.id, new AbortController().signal)).status).toBe("failed");
    expect(third.calls).toHaveLength(0);
  });

  test("changed intent cannot reuse a saved build for verification", async () => {
    const task = setupTask({ testCommand: "false" });
    await runTask(
      deps(
        new ScriptedEngine({
          implement: (req) => {
            writeFileSync(join(req.cwd, "src/feature.ts"), "ready\n");
            return { text: "Ready." };
          },
        }),
      ),
      task.id,
      new AbortController().signal,
    );
    updateTask(db, task.id, { recoveryMode: "verify", brief: "A different requested behavior." });
    const second = new ScriptedEngine({});
    const out = await runTask(deps(second), task.id, new AbortController().signal);
    expect(out.reason).toContain("no longer matches");
    expect(second.calls).toHaveLength(0);
  });
});

test("every configured independent reviewer must approve before a train can board", async () => {
  const task = setupTask();
  updateRepo(db, task.repoId, {
    level: "train",
    policies: { implementation: { ...DEFAULT_TASK_POLICY, reviewers: 2 } },
  });
  let reviews = 0;
  const engine = new ScriptedEngine({
    implement: (req) => {
      writeFileSync(join(req.cwd, "src/feature.ts"), "ready\n");
      return { text: "Ready." };
    },
    review: (req) => {
      reviews++;
      if (reviews === 2) expect(req.guard.readOnly).toBe(true);
      return { structured: { ...READY, verdict: reviews === 1 ? "ready" : "needs_eyes" } };
    },
  });
  const out = await runTask(deps(engine), task.id, new AbortController().signal);
  expect(out.status).toBe("complete");
  expect(reviews).toBe(2);
  expect(getRun(db, out.runId)?.run.verdict).toBe("needs_eyes");
  expect(getRun(db, out.runId)?.run.trainId).toBeNull();
  const measurements = phaseMeasurements(listRunEvents(db, out.runId), false);
  expect(measurements.map((m) => m.phase)).toEqual(["plan", "implement", "review", "review"]);
  expect(new Set(measurements.map((m) => m.id)).size).toBe(4);
  const run = getRun(db, out.runId)!.run;
  expect(measurements.reduce((n, m) => n + (m.tokensIn ?? 0) + (m.tokensOut ?? 0), 0)).toBe(
    run.tokensIn + run.tokensOut,
  );
  expect(Math.round(measurements.reduce((n, m) => n + (m.costUsd ?? 0), 0) * 100)).toBe(run.costCents);
});
