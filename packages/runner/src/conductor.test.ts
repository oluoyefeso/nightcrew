import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nightIdFor, type Repo } from "@nightcrew/core";
import {
  addRepo,
  createMission,
  createTask,
  type Db,
  getConductor,
  getGoalResult,
  getRun,
  getSettings,
  listTasks,
  missionTokens,
  openDb,
  reserveGoalCall,
  saveConductor,
  tokensOnDay,
  updateMission,
  updateRepo,
  updateSettings,
  updateTask,
} from "@nightcrew/db";
import { ConnectionEngine } from "./connection-engine";
import { Crew } from "./crew";
import { type PhaseRequest, ScriptedEngine } from "./engine";
import { git } from "./git";

let db: Db;
let dir: string;
let repo: Repo;
let crew: Crew | undefined;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "nightcrew-goal-"));
  const path = join(dir, "project");
  mkdirSync(join(path, "src"), { recursive: true });
  writeFileSync(join(path, "src", "seed.ts"), "export {};\n");
  writeFileSync(
    join(path, "check.test.ts"),
    `import {test,expect} from 'bun:test';\nimport {existsSync} from 'node:fs';\ntest('existing project',()=>expect(true).toBe(true));\nif(existsSync('src/a.ts')) test('value is two',async()=>expect((await import('./src/a')).value).toBe(2));\nif(existsSync('src/b.ts')) test('combined outcome',async()=>expect((await import('./src/b')).doubled).toBe(4));\n`,
  );
  await git(path, "init", "-q", "-b", "main");
  await git(path, "add", ".");
  await git(path, "-c", "user.name=NightCrew", "-c", "user.email=crew@nightcrew.dev", "commit", "-qm", "Fixture");
  db = openDb(join(dir, "state.sqlite"));
  repo = addRepo(db, { name: "Fixture", path, defaultBranch: "main", testCommand: "bun test" });
  updateSettings(db, { dailyTokenBudget: 500_000, maxAgents: 2, maxPerRepo: 1 });
});
afterEach(async () => {
  crew?.shutdown();
  await crew?.drain();
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
  crew = undefined;
});
const objective = "Provide a value of two and a doubled value of four.";
const goal = () =>
  createMission(db, { title: "Arithmetic", objective, criteria: [objective], tokenBudget: 200_000, paused: true });
const makeCrew = (engine: ScriptedEngine) =>
  (crew = new Crew({ db, engine, dataDir: join(dir, "data"), publish: false }));
const drafts = (question: string | null = null) => [
  {
    repo: "Fixture",
    title: "Provide the base value",
    type: "implementation",
    brief: "Create src/a.ts exporting value 2.",
    scope: ["src/a.ts"],
    criteria: ["The value is 2"],
    missionCriteria: [objective],
    question,
    dependsOn: [],
  },
  {
    repo: "Fixture",
    title: "Double the base value",
    type: "implementation",
    brief: "Create src/b.ts importing value from a and exporting doubled=value*2.",
    scope: ["src/b.ts"],
    criteria: ["The doubled value is 4"],
    missionCriteria: [objective],
    question: null,
    dependsOn: [0],
  },
];
function review(req: PhaseRequest) {
  if (!req.prompt.startsWith("GOAL VERIFICATION\n"))
    return {
      structured: {
        verdict: "ready",
        summary: "Task checked.",
        criteria: (req.prompt.split("## Acceptance criteria\n")[1]?.split("\n\n")[0] ?? "")
          .split("\n")
          .filter((line) => line.startsWith("- "))
          .map((line) => ({ criterion: line.slice(2), met: true, evidence: "Fixture source and tests checked." })),
        concerns: [],
        report: "Task review passed.",
      },
    };
  const packet = JSON.parse(req.prompt.slice("GOAL VERIFICATION\n".length));
  const source = packet.sources.find((source: { id: string }) => source.id === "combined:diff");
  expect(source.content).toContain("doubled");
  return {
    structured: {
      verdict: "ready",
      summary: "The combined implementation provides both requested values.",
      criteria: packet.criteria.map((criterion: string) => ({
        criterion,
        met: true,
        evidence: [{ source: source.id, quote: "doubled" }],
      })),
    },
  };
}
function engineWith(question: string | null = null) {
  return new ScriptedEngine({
    compose: () => ({ structured: { tasks: drafts(question) } }),
    implement: (req) => {
      expect(req.prompt).toContain('Project test command: "bun test"');
      if (req.prompt.includes("## Task\nProvide the base value"))
        writeFileSync(join(req.cwd, "src/a.ts"), "export const value = 2;\n");
      else {
        expect(readFileSync(join(req.cwd, "src/a.ts"), "utf8")).toContain("value = 2");
        writeFileSync(join(req.cwd, "src/b.ts"), "import { value } from './a';\nexport const doubled = value * 2;\n");
      }
      return { text: "Implemented the requested behavior." };
    },
    review,
  });
}

test("one start plans, hands checked code to its dependent, executes and independently verifies without changing main", async () => {
  const mission = goal();
  const engine = engineWith();
  const runner = makeCrew(engine);
  const main = (await git(repo.path, "rev-parse", "main")).stdout.trim();
  runner.conductor.start(mission.id, repo.id);
  runner.conductor.start(mission.id, repo.id);
  await runner.drain();
  const state = getConductor(db, mission.id)!;
  expect({
    state: state.state,
    detail: state.detail,
    tasks: listTasks(db).map((task) => ({
      title: task.title,
      status: task.status,
      run: task.lastRunId ? getRun(db, task.lastRunId)?.run : null,
    })),
  }).toMatchObject({ state: "ready" });
  expect(state.taskIds).toHaveLength(2);
  expect(engine.calls.filter((call) => call.phase === "compose")).toHaveLength(1);
  expect(engine.calls.some((call) => call.phase === "plan")).toBe(false);
  expect(listTasks(db).every((task) => task.workflow === "quick")).toBe(true);
  expect(engine.calls.filter((call) => call.prompt.startsWith("GOAL VERIFICATION"))).toHaveLength(1);
  expect((await git(repo.path, "rev-parse", "main")).stdout.trim()).toBe(main);
  expect(existsSync(join(repo.path, "src/a.ts"))).toBe(false);
  const result = getGoalResult(db, state.resultId!)!;
  expect(result.status).toBe("passed");
  expect(result.checks[0]?.ok).toBe(true);
  expect((await git(repo.path, "show", `${result.commit}:src/b.ts`)).stdout).toContain("value * 2");
  const runTokens = listTasks(db).reduce((sum, task) => {
    const run = getRun(db, task.lastRunId!)!.run;
    return sum + run.tokensIn + run.tokensOut;
  }, 0);
  expect(missionTokens(db, mission.id)).toBe(runTokens + 300);
  expect(tokensOnDay(db, nightIdFor(new Date().toISOString()))).toBe(missionTokens(db, mission.id));
  expect(getSettings(db).dispatch).toBe(true);
  await runner.pump();
  expect(getConductor(db, mission.id)?.state).toBe("ready");
}, 30_000);

test("a compatible HTTP model completes the conductor loop through guarded tools and structured evidence", async () => {
  const mission = goal();
  const main = (await git(repo.path, "rev-parse", "main")).stdout.trim();
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json();
      requests++;
      const message = body.messages[1].content as string;
      const prompt = message.slice(message.indexOf("\n\n") + 2);
      const finish = body.tools?.find((tool: { function: { name: string } }) => tool.function.name === "Finish");
      let name: string | undefined;
      let args: unknown;
      if (finish?.function.parameters.properties.tasks) {
        name = "Finish";
        args = { tasks: drafts() };
      } else if (finish) {
        name = "Finish";
        args = { ...review({ prompt } as PhaseRequest).structured, challenges: [] };
      } else if (body.messages.at(-1).role !== "tool") {
        name = "Write";
        args = prompt.includes("## Task\nProvide the base value")
          ? { file_path: "src/a.ts", content: "export const value = 2;\n" }
          : { file_path: "src/b.ts", content: "import { value } from './a';\nexport const doubled = value * 2;\n" };
      }
      return Response.json({
        choices: [
          {
            finish_reason: name ? "tool_calls" : "stop",
            message: {
              content: name ? null : "Implemented and ready for project checks.",
              ...(name
                ? {
                    tool_calls: [
                      { id: `call-${requests}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
                    ],
                  }
                : {}),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 30, cost: 0.001 },
      });
    },
  });
  try {
    const engine = new ConnectionEngine({
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      model: "fixture",
      apiKeyEnv: null,
    });
    crew = new Crew({ db, engine, dataDir: join(dir, "data"), publish: false });
    crew.conductor.start(mission.id, repo.id);
    await crew.drain();
    const state = getConductor(db, mission.id)!;
    expect({
      state: state.state,
      detail: state.detail,
      runs: listTasks(db).map((task) => (task.lastRunId ? getRun(db, task.lastRunId)?.run : null)),
    }).toMatchObject({ state: "ready" });
    expect(getGoalResult(db, state.resultId!)?.status).toBe("passed");
    expect((await git(repo.path, "rev-parse", "main")).stdout.trim()).toBe(main);
    expect(missionTokens(db, mission.id)).toBe(requests * 130);
    expect(requests).toBe(8);
  } finally {
    server.stop(true);
  }
}, 30_000);

test("missing project checks stay held until configured instead of repeatedly restarting verification", async () => {
  const mission = goal();
  const engine = engineWith();
  const runner = makeCrew(engine);
  runner.conductor.start(mission.id, repo.id);
  await runner.drain();
  expect(getConductor(db, mission.id)?.state).toBe("ready");
  const calls = engine.calls.length;
  updateRepo(db, repo.id, { testCommand: null });
  updateMission(db, mission.id, { paused: true });
  runner.conductor.start(mission.id, repo.id);
  await runner.drain();
  for (let i = 0; i < 3; i++) {
    await runner.pump();
    expect(getConductor(db, mission.id)).toMatchObject({ state: "needs_you", code: "setup" });
    expect(runner.conductor.active).toBe(0);
  }
  expect(engine.calls).toHaveLength(calls);
  updateRepo(db, repo.id, { testCommand: "bun test" });
  await runner.drain();
  expect(getConductor(db, mission.id)?.state).toBe("ready");
  expect(engine.calls).toHaveLength(calls + 1);
}, 30_000);

test("a question holds dispatch and its answer continues the saved plan without replanning", async () => {
  const mission = goal();
  const engine = engineWith("Should the value be two?");
  const runner = makeCrew(engine);
  runner.conductor.start(mission.id, repo.id);
  await runner.drain();
  expect(getConductor(db, mission.id)).toMatchObject({ state: "needs_you", code: "question" });
  expect(engine.calls.map((call) => call.phase)).toEqual(["compose"]);
  updateTask(db, listTasks(db)[0]!.id, { question: null, status: "queued" });
  await runner.drain();
  expect(getConductor(db, mission.id)?.state).toBe("ready");
  expect(engine.calls.filter((call) => call.phase === "compose")).toHaveLength(1);
}, 30_000);

test("unusable plans are held instead of automatically dispatching fallback work", async () => {
  const mission = goal();
  const engine = new ScriptedEngine({ compose: () => ({ structured: { tasks: [] } }) });
  const runner = makeCrew(engine);
  runner.conductor.start(mission.id, repo.id);
  await runner.drain();
  await runner.pump();
  expect(getConductor(db, mission.id)).toMatchObject({ state: "needs_you", code: "plan" });
  expect(listTasks(db)).toHaveLength(0);
  expect(engine.calls).toHaveLength(1);
  expect(missionTokens(db, mission.id)).toBe(150);
});

test.each(["The API refused the request budget (402).", "Hit the task's token budget before finishing."])(
  "a planning refusal stops before implementation: %s",
  async (failure) => {
    const mission = goal();
    const engine = engineWith();
    const original = engine.runPhase.bind(engine);
    engine.runPhase = async (request, emit) =>
      request.phase === "plan"
        ? {
            ok: false,
            text: failure,
            structured: null,
            error: failure,
            rateLimited: false,
            tokensIn: 0,
            tokensOut: 0,
            costUsd: 0,
            turns: 1,
            usageStatus: "reported",
          }
        : original(request, emit);
    const runner = makeCrew(engine);
    createTask(db, {
      missionId: mission.id,
      repoId: repo.id,
      title: "Provide the base value",
      brief: "Implement the requested value.",
      scope: ["src/a.ts"],
      workflow: "planned",
      status: "queued",
      tokenBudget: 100_000,
    });
    runner.conductor.start(mission.id, repo.id);
    await runner.drain();
    expect(engine.calls.some((call) => call.phase === "implement")).toBe(false);
    expect(getConductor(db, mission.id)?.state).toBe("needs_you");
  },
);

test("unknown and under-reported usage retain the reservation and prevent automatic continuation", async () => {
  const mission = goal();
  const engine = new ScriptedEngine({
    compose: (_req, emit) => {
      emit({ kind: "usage", text: "", tokensIn: 500, tokensOut: 30 });
      return { structured: { tasks: drafts() }, tokensIn: 100, tokensOut: 10 };
    },
  });
  const runner = makeCrew(engine);
  runner.conductor.start(mission.id, repo.id);
  await runner.drain();
  await runner.pump();
  expect(getConductor(db, mission.id)?.code).toBe("usage");
  expect(listTasks(db)).toHaveLength(0);
  expect(missionTokens(db, mission.id)).toBe(60_000);
  expect(engine.calls).toHaveLength(1);
});

test("global pause and a reached stop time make no planning call", async () => {
  const mission = goal();
  const engine = engineWith();
  const runner = makeCrew(engine);
  updateSettings(db, { dispatch: false });
  runner.conductor.start(mission.id, repo.id);
  await runner.drain();
  expect(engine.calls).toHaveLength(0);
  expect(getSettings(db).dispatch).toBe(false);
  updateMission(db, mission.id, { stopAt: new Date(Date.now() - 1000).toISOString() });
  updateSettings(db, { dispatch: true });
  await runner.drain();
  expect(engine.calls).toHaveLength(0);
  expect(getConductor(db, mission.id)?.code).toBe("deadline");
});

test("stopping during planning ignores a late response and keeps its usage", async () => {
  const mission = goal();
  let release!: () => void;
  let began!: () => void;
  const started = new Promise<void>((r) => {
    began = r;
  });
  const engine = new ScriptedEngine({
    compose: async () => {
      began();
      await new Promise<void>((r) => {
        release = r;
      });
      return { structured: { tasks: drafts() } };
    },
  });
  const runner = makeCrew(engine);
  runner.conductor.start(mission.id, repo.id);
  await started;
  updateMission(db, mission.id, { paused: true });
  await runner.pump();
  release();
  await runner.drain();
  expect(listTasks(db)).toHaveLength(0);
  expect(missionTokens(db, mission.id)).toBe(150);
  expect(["paused", "needs_you"]).toContain(getConductor(db, mission.id)!.state);
});

test("a changed objective invalidates an in-flight plan before any task is persisted", async () => {
  const mission = goal();
  let release!: () => void;
  let began!: () => void;
  const started = new Promise<void>((r) => {
    began = r;
  });
  const engine = new ScriptedEngine({
    compose: async () => {
      began();
      await new Promise<void>((r) => {
        release = r;
      });
      return { structured: { tasks: drafts() } };
    },
  });
  const runner = makeCrew(engine);
  runner.conductor.start(mission.id, repo.id);
  await started;
  updateMission(db, mission.id, { objective: "A different outcome" });
  release();
  await runner.drain();
  expect(listTasks(db)).toHaveLength(0);
  expect(getConductor(db, mission.id)?.code).toBe("changed");
});

test("restart retains unfinished call reservations and requires an explicit continuation", async () => {
  const mission = goal();
  const engine = engineWith();
  const runner = makeCrew(engine);
  saveConductor(db, {
    missionId: mission.id,
    repoId: repo.id,
    generation: 1,
    state: "planning",
    code: "",
    detail: "Planning",
    intent: "fixture",
    taskIds: [],
    repairs: 0,
    resultId: null,
    updatedAt: new Date().toISOString(),
  });
  reserveGoalCall(db, mission.id, "planning", 40_000);
  runner.recover();
  expect(getConductor(db, mission.id)?.code).toBe("interrupted");
  expect(missionTokens(db, mission.id)).toBe(40_000);
  expect(engine.calls).toHaveLength(0);
});

test("goal planning includes only the selected project and admits no call without allowance", async () => {
  addRepo(db, { name: "Excluded", path: join(dir, "excluded"), defaultBranch: "main" });
  const mission = goal();
  const engine = new ScriptedEngine({ compose: () => ({ structured: { tasks: [] } }) });
  const runner = makeCrew(engine);
  updateSettings(db, { dailyTokenBudget: 1000 });
  runner.conductor.start(mission.id, repo.id);
  await runner.drain();
  expect(engine.calls).toHaveLength(0);
  expect(getConductor(db, mission.id)?.code).toBe("budget");
  updateSettings(db, { dailyTokenBudget: 100_000 });
  await runner.drain();
  expect(engine.calls).toHaveLength(0);
  runner.conductor.start(mission.id, repo.id);
  await runner.drain();
  expect(engine.calls[0]?.prompt).toContain("### Fixture");
  expect(engine.calls[0]?.prompt).not.toContain("### Excluded");
  expect(engine.calls[0]?.maxTokens).toBeLessThanOrEqual(100_000);
});

test("pausing and resuming the crew preserves a hold on incomplete coordinator usage", async () => {
  const mission = goal();
  const engine = new ScriptedEngine({
    compose: () => ({ structured: { tasks: drafts() }, usageStatus: "unknown" }),
  });
  const runner = makeCrew(engine);
  runner.conductor.start(mission.id, repo.id);
  await runner.drain();
  expect(getConductor(db, mission.id)?.code).toBe("usage");
  expect(engine.calls).toHaveLength(1);
  updateSettings(db, { dispatch: false });
  await runner.pump();
  expect(getConductor(db, mission.id)?.code).toBe("usage");
  updateSettings(db, { dispatch: true });
  await runner.drain();
  expect(getConductor(db, mission.id)?.code).toBe("usage");
  expect(engine.calls).toHaveLength(1);
  expect(listTasks(db)).toHaveLength(0);
});

test("forged goal evidence never certifies a result or spins repeated review calls", async () => {
  const mission = goal();
  const engine = engineWith();
  const normal = engine.runPhase.bind(engine);
  engine.runPhase = async (req, emit) => {
    const result = await normal(req, emit);
    if (req.prompt.startsWith("GOAL VERIFICATION"))
      result.structured = {
        verdict: "ready",
        summary: "Claimed success",
        criteria: [{ criterion: objective, met: true, evidence: [{ source: "invented", quote: "not observed" }] }],
      };
    return result;
  };
  const runner = makeCrew(engine);
  runner.conductor.start(mission.id, repo.id);
  await runner.drain();
  await runner.pump();
  expect(getConductor(db, mission.id)).toMatchObject({ state: "needs_you", code: "verification" });
  expect(engine.calls.filter((call) => call.prompt.startsWith("GOAL VERIFICATION"))).toHaveLength(1);
  const saved = getGoalResult(db, getConductor(db, mission.id)!.resultId!)!;
  expect(saved.status).toBe("failed");
  expect(saved.checks[0]?.ok).toBe(true);
}, 30_000);

test("changing the base branch invalidates a previously verified goal", async () => {
  const mission = goal();
  const runner = makeCrew(engineWith());
  runner.conductor.start(mission.id, repo.id);
  await runner.drain();
  expect(getConductor(db, mission.id)?.state).toBe("ready");
  writeFileSync(join(repo.path, "src/new-base.ts"), "export {};\n");
  await git(repo.path, "add", ".");
  await git(
    repo.path,
    "-c",
    "user.name=NightCrew",
    "-c",
    "user.email=crew@nightcrew.dev",
    "commit",
    "-qm",
    "Base changed",
  );
  await runner.pump();
  expect(getConductor(db, mission.id)).toMatchObject({ state: "needs_you", code: "changed" });
}, 30_000);

test("a shortened stop time aborts planning and extending it does not relax the active limit", async () => {
  const mission = goal();
  let began!: () => void;
  const started = new Promise<void>((r) => {
    began = r;
  });
  let stopped = false;
  const engine = new ScriptedEngine({
    compose: async (req) => {
      began();
      await new Promise<void>((r) => req.signal.addEventListener("abort", () => r(), { once: true }));
      stopped = true;
      return { ok: false, usageStatus: "unknown" };
    },
  });
  const runner = makeCrew(engine);
  runner.conductor.start(mission.id, repo.id);
  await started;
  updateMission(db, mission.id, { stopAt: new Date(Date.now() + 80).toISOString() });
  await runner.pump();
  updateMission(db, mission.id, { stopAt: new Date(Date.now() + 60_000).toISOString() });
  await runner.pump();
  await runner.drain();
  expect(stopped).toBe(true);
  expect(listTasks(db)).toHaveLength(0);
  expect(missionTokens(db, mission.id)).toBe(60_000);
});

test("task interruption resumes the persisted goal without a second plan or duplicate tasks", async () => {
  const mission = goal();
  let began!: () => void;
  const started = new Promise<void>((r) => {
    began = r;
  });
  const first = new ScriptedEngine({
    compose: () => ({ structured: { tasks: drafts() } }),
    implement: async (req) => {
      began();
      await new Promise<void>((r) => req.signal.addEventListener("abort", () => r(), { once: true }));
      return { ok: false, error: "Stopped", usageStatus: "reported" };
    },
  });
  const original = makeCrew(first);
  original.conductor.start(mission.id, repo.id);
  await started;
  original.shutdown();
  await original.drain();
  const next = engineWith();
  const restarted = makeCrew(next);
  restarted.recover();
  await restarted.drain();
  expect(getConductor(db, mission.id)?.state).toBe("ready");
  expect(listTasks(db)).toHaveLength(2);
  expect(next.calls.some((call) => call.phase === "compose")).toBe(false);
}, 30_000);

test("verification performs one bounded correction when independently passing changes fail together", async () => {
  // Each independent change passes its own checks; the combination is an independently checked failure.
  writeFileSync(
    join(repo.path, "check.test.ts"),
    `import {test,expect} from 'bun:test';import {existsSync} from 'node:fs';test('combination',async()=>{if(existsSync('src/a.ts')&&existsSync('src/b.ts'))expect((await import('./src/a')).value+(await import('./src/b')).doubled).toBe(4);});\n`,
  );
  await git(repo.path, "add", ".");
  await git(
    repo.path,
    "-c",
    "user.name=NightCrew",
    "-c",
    "user.email=crew@nightcrew.dev",
    "commit",
    "-qm",
    "Combined check",
  );
  const mission = goal();
  updateMission(db, mission.id, {
    objective: "Provide two independently implemented values whose sum is four.",
    criteria: ["The two values sum to four."],
  });
  let correction = false;
  const engine = new ScriptedEngine({
    compose: () => ({ structured: { tasks: drafts().map((draft) => ({ ...draft, dependsOn: [] })) } }),
    implement: (req) => {
      if (req.prompt.includes("## Task\nProvide the base value"))
        writeFileSync(join(req.cwd, "src/a.ts"), "export const value = 2;\n");
      else if (req.prompt.includes("## Task\nResolve the goal verification gaps")) {
        correction = true;
        expect(existsSync(join(req.cwd, "src/a.ts"))).toBe(true);
        writeFileSync(join(req.cwd, "src/b.ts"), "export const doubled = 2;\n");
        writeFileSync(
          join(req.cwd, "regression.test.ts"),
          "import {test,expect} from 'bun:test';import {value} from './src/a';import {doubled} from './src/b';test('combined regression',()=>expect(value+doubled).toBe(4));\n",
        );
      } else writeFileSync(join(req.cwd, "src/b.ts"), "export const doubled = -2;\n");
      return { text: "Synthetic bounded change." };
    },
    review,
  });
  const runner = makeCrew(engine);
  runner.conductor.start(mission.id, repo.id);
  await runner.drain();
  const state = getConductor(db, mission.id)!;
  expect(correction).toBe(true);
  expect(state.repairs).toBe(1);
  expect(state.taskIds).toHaveLength(3);
  expect({
    state: state.state,
    detail: state.detail,
    tasks: listTasks(db).map((task) => ({
      title: task.title,
      status: task.status,
      run: task.lastRunId ? getRun(db, task.lastRunId)?.run : null,
    })),
  }).toMatchObject({ state: "ready" });
  expect(db.$client.query("SELECT count(*) AS n FROM goal_results").get()).toEqual({ n: 2 });
}, 30_000);
