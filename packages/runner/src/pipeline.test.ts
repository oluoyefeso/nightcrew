import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardToolCall } from "@nightcrew/core/guard";
import {
  addNote,
  addRepo,
  createTask,
  type Db,
  getRun,
  getTask,
  listRunEvents,
  openDb,
  updateRepo,
  updateTask,
} from "@nightcrew/db";
import { ScriptedEngine } from "./engine";
import { git } from "./git";
import { normalizeReview, runTask } from "./pipeline";
import type { ReviewOutput } from "./prompts";
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
    expect((await git(wt, "log", "-1", "--format=%s")).stdout).toContain("WIP: Add the feature");
  });
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
    expect(out.reason).toContain("outside scope: .github/workflows/ci.yml");
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
    const wip = (await git(repoPath, "log", "-1", "--format=%s", `refs/nightcrew/tasks/${task.id}`)).stdout;
    expect(wip).toContain("WIP: Add the feature");

    updateTask(db, task.id, { status: "queued", testCommand: "test -f src/feature.ts" });
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
