import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realSdk from "@anthropic-ai/claude-agent-sdk";
import { browserProfileDirs } from "@nightcrew/core/guard";
import { type EngineEvent, type PhaseRequest, STOPPED } from "./engine";
import { cacheDirs } from "./env";
import { git, run } from "./git";
import { agentEnv, SdkEngine, sandboxFor, TAMPERED } from "./sdk-engine";

// query() can be swapped for a scripted stream. Unset, it is the real SDK, so
// other test files sharing this process are unaffected. mock.module patches
// the imported namespace in place, so the real exports are copied first;
// calling realSdk.query inside the mock would call the mock again.
const real = { ...realSdk };
let scripted: ((args: unknown) => AsyncGenerator<unknown>) | null = null;
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  ...real,
  query: (args: Parameters<typeof real.query>[0]) => (scripted ? scripted(args) : real.query(args)),
}));

let root: string;
let repo: string;

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "nc-sdk-")));
  repo = join(root, "repo");
  await git(root, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "README.md"), "# r\n");
  await git(repo, "add", "-A");
  await git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
});
afterEach(() => {
  scripted = null;
  rmSync(root, { recursive: true, force: true });
});

const request = (over: Partial<PhaseRequest> = {}): PhaseRequest => ({
  phase: "implement",
  cwd: repo,
  prompt: "Fix the bug.",
  systemPrompt: "You are a careful engineer.",
  model: "claude-haiku-5-5",
  guard: { worktree: repo, writableDirs: [], scope: [], protectedBranches: ["main"], readOnly: false },
  maxTokens: 10_000,
  maxTurns: 3,
  signal: new AbortController().signal,
  ...over,
});

describe("SdkEngine", () => {
  test("review keeps phase and project instructions with inspection tools and guarded mutations", async () => {
    writeFileSync(join(repo, "CLAUDE.md"), "Use the project's existing tests.");
    const captured: { options?: realSdk.Options } = {};
    scripted = async function* (args) {
      captured.options = (args as Parameters<typeof real.query>[0]).options;
      yield { type: "result", subtype: "success", is_error: false, result: "Reviewed." };
    };
    await new SdkEngine().runPhase(
      request({ phase: "review", guard: { ...request().guard, readOnly: true } }),
      () => {},
    );
    const options = captured.options!;
    expect(typeof options.systemPrompt).toBe("string");
    expect(options.systemPrompt).toContain("You are a careful engineer.");
    expect(options.systemPrompt).toContain("Use the project's existing tests.");
    expect(options.systemPrompt).toContain("Never read or expose credentials");
    expect(options.tools).toEqual(["Read", "Bash", "Glob", "Grep"]);
    expect(options.settingSources).toEqual([]);
    const hook = options.hooks!.PreToolUse![0]!.hooks[0]!;
    for (const command of ["git stash", "git push origin main"]) {
      const decision = await hook(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command },
          tool_use_id: "tool-1",
          session_id: "session-1",
          transcript_path: "",
          cwd: repo,
        },
        "tool-1",
        { signal: new AbortController().signal },
      );
      expect(
        "hookSpecificOutput" in decision &&
          decision.hookSpecificOutput?.hookEventName === "PreToolUse" &&
          decision.hookSpecificOutput.permissionDecision,
      ).toBe("deny");
    }
  });

  test.each([false, true])("success after exceeding allowance stays failed (streamed: %s)", async (streamed) => {
    scripted = async function* () {
      if (streamed)
        yield { type: "assistant", message: { id: "m1", content: [], usage: { input_tokens: 120, output_tokens: 5 } } };
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Finished",
        total_cost_usd: 0.01,
        num_turns: 1,
        modelUsage: {
          fixture: {
            inputTokens: 120,
            outputTokens: 5,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 0.01,
          },
        },
      };
    };
    const result = await new SdkEngine().runPhase(request({ maxTokens: 100 }), () => {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("token budget");
    expect(result.tokensIn + result.tokensOut).toBe(125);
    expect(result.usageStatus).toBe("reported");
  });

  test("an already stopped phase returns without starting the agent", async () => {
    const stop = new AbortController();
    stop.abort();
    // A missing executable would fail loudly if the SDK were called.
    const engine = new SdkEngine({ claudePath: join(root, "no-such-claude") });
    const r = await engine.runPhase(request({ signal: stop.signal }), () => {});
    expect(r).toEqual({
      ok: false,
      text: "",
      structured: null,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      turns: 0,
      error: "Stopped: the task ran out of time or was cancelled.",
      rateLimited: false,
    });
  });

  // Value: protects=task and daily budgets seeing tokens spent before a stop; fails_when=a stream that ends without a result reports zero tokens, or double counts one call's repeated usage; why_new=the streamed floor had no test; seam=none
  test("a stopped stream with no result reports the most each call streamed", async () => {
    const stop = new AbortController();
    const assistant = (id: string, usage: Record<string, number>) => ({
      type: "assistant",
      session_id: "s1",
      parent_tool_use_id: null,
      message: { id, content: [], usage },
    });
    scripted = async function* () {
      yield assistant("m1", { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 10 });
      yield assistant("m1", { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 40 });
      yield assistant("m1", { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 40 });
      yield assistant("m2", { input_tokens: 300, cache_creation_input_tokens: 20, output_tokens: 5 });
      stop.abort();
    };
    const events: EngineEvent[] = [];
    const r = await new SdkEngine().runPhase(request({ signal: stop.signal }), (event) => events.push(event));
    expect(events.filter((event) => event.kind === "usage").map((event) => [event.tokensIn, event.tokensOut])).toEqual([
      [150, 10],
      [150, 40],
      [470, 45],
    ]);
    expect(r.tokensIn).toBe(150 + 320);
    expect(r.tokensOut).toBe(40 + 5);
    expect(r.error).toBe(STOPPED);
    expect(r.ok).toBe(false);
    expect(r.sessionId).toBe("s1");
    expect(r.usageStatus).toBe("partial");
  });

  test("a stream without usage does not report a known zero-cost attempt", async () => {
    scripted = async function* () {};
    const r = await new SdkEngine().runPhase(request(), () => {});
    expect(r.ok).toBe(false);
    expect(r.usageStatus).toBe("unknown");
  });

  test("a payment refusal gives fixed credit guidance without exposing provider details", async () => {
    scripted = async function* () {
      yield {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        api_error_status: 402,
        result: "synthetic-private-provider-detail",
        num_turns: 1,
      };
    };
    const r = await new SdkEngine().runPhase(request(), () => {});
    expect(r.ok).toBe(false);
    expect(r.error).toBe(
      "The API refused the request budget (402). Check available credits, key limits and requested output tokens; concurrent requests can also reserve credit.",
    );
    expect(JSON.stringify(r)).not.toContain("synthetic-private-provider-detail");
    expect(r.rateLimited).toBe(false);
    expect(r.usageStatus).not.toBe("reported");
  });

  test("terminal usage includes cache reads and writes exactly once", async () => {
    scripted = async function* () {
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Done",
        total_cost_usd: 0.12,
        num_turns: 2,
        modelUsage: {
          example: {
            inputTokens: 10,
            cacheReadInputTokens: 80,
            cacheCreationInputTokens: 10,
            outputTokens: 5,
            costUSD: 0.12,
          },
        },
      };
    };
    const r = await new SdkEngine().runPhase(request(), () => {});
    expect(r).toMatchObject({
      ok: true,
      tokensIn: 100,
      tokensOut: 5,
      costUsd: 0.12,
      turns: 2,
      usageStatus: "reported",
    });
  });

  test("a terminal response without accounting remains unknown", async () => {
    scripted = async function* () {
      yield { type: "result", subtype: "error_during_execution", is_error: true, result: "Unavailable" };
    };
    const r = await new SdkEngine().runPhase(request(), () => {});
    expect(r.usageStatus).toBe("unknown");
  });

  test("the agent's git can't push to a real remote, and this process still can", async () => {
    await git(repo, "remote", "add", "origin", "https://github.com/acme/widgets.git");
    await git(repo, "remote", "add", "ssh", "git@github.com:acme/widgets.git");
    const before = { ...process.env };
    const env = agentEnv(process.env) as Record<string, string>;
    // Only the copy changes; this process's own environment is left alone.
    expect(process.env).toEqual(before);
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");

    const pushUrl = (remote: string, e?: Record<string, string>) =>
      run(["git", "remote", "get-url", "--push", remote], repo, { env: e });
    expect((await pushUrl("origin", env)).stdout.trim()).toBe("nightcrew-blocked://blocked");
    expect((await pushUrl("ssh", env)).stdout.trim()).toStartWith("nightcrew-blocked://");
    // Fetching is unaffected.
    expect((await run(["git", "remote", "get-url", "origin"], repo, { env })).stdout.trim()).toBe(
      "https://github.com/acme/widgets.git",
    );
    expect((await pushUrl("origin")).stdout.trim()).toBe("https://github.com/acme/widgets.git");
  });

  test("the push block appends to git config already in the environment", () => {
    const env = agentEnv({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.pager", GIT_CONFIG_VALUE_0: "cat" });
    expect(env.GIT_CONFIG_KEY_0).toBe("core.pager");
    expect(env.GIT_CONFIG_KEY_1).toBe("url.nightcrew-blocked://.pushInsteadOf");
    expect(Number(env.GIT_CONFIG_COUNT)).toBeGreaterThan(1);
  });

  // Value: protects=the agent pushing through an ssh alias remote; fails_when=origin is an scp-style alias that no pushInsteadOf prefix matches; why_new=only URL prefixes were blocked before; seam=none
  test("an ssh alias on origin can't be pushed to either", async () => {
    await git(repo, "remote", "add", "origin", "gh:acme/widgets");
    const env = agentEnv({ PATH: process.env.PATH }) as Record<string, string>;
    const push = await run(["git", "remote", "get-url", "--push", "--all", "origin"], repo, { env });
    expect(push.stdout.trim()).toBe("nightcrew-blocked://blocked");
    expect((await run(["git", "remote", "get-url", "origin"], repo, { env })).stdout.trim()).toBe("gh:acme/widgets");
  });

  // Value: protects=GitHub, cloud and registry tokens from the agent's shell, while config like AWS_PROFILE stays; fails_when=agentEnv copies credentials or drops the Anthropic sign-in; why_new=the env was copied wholesale before; seam=none
  test("the agent's environment drops credentials and keeps the Anthropic sign-in", () => {
    const env = agentEnv({
      PATH: "/bin",
      HOME: "/home/me",
      GH_TOKEN: "x",
      GITHUB_TOKEN: "x",
      GH_ENTERPRISE_TOKEN: "x",
      GITHUB_PAT: "x",
      NPM_TOKEN: "x",
      NODE_AUTH_TOKEN: "x",
      AWS_ACCESS_KEY_ID: "x",
      AWS_SECRET_ACCESS_KEY: "x",
      AWS_PROFILE: "x",
      GOOGLE_APPLICATION_CREDENTIALS: "/k.json",
      AZURE_CLIENT_SECRET: "x",
      TYPESAFE_API_KEY: "x",
      SLACK_BOT_TOKEN: "x",
      ANTHROPIC_API_KEY: "sk-ant",
      ANTHROPIC_BASE_URL: "https://api.example",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
    });
    const kept = Object.keys(env).filter((k) => !k.startsWith("GIT_"));
    expect(kept.sort()).toEqual(
      ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "AWS_PROFILE", "CLAUDE_CODE_OAUTH_TOKEN", "HOME", "PATH"].sort(),
    );
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant");
  });

  // Value: protects=git in a task's clone (commit, stash, submodules, lfs), which shares nothing writable with the host repo; fails_when=an isolated phase gets git denies, extra allows, or the host repo it borrows objects from; why_new=design point 9, clones replace linked worktrees; seam=none
  test("in a task's clone the sandbox allows only the clone, artifacts, temp and caches", async () => {
    const clone = join(root, "work", "task-1");
    await git(root, "clone", "-q", "--shared", repo, clone);
    const artifacts = join(root, "artifacts");
    const guard = { ...request().guard, worktree: clone, writableDirs: [artifacts] };
    const s = sandboxFor(request({ cwd: clone, guard, isolated: true }), "/home/me");
    expect(s.enabled).toBe(true);
    expect(s.allowUnsandboxedCommands).toBe(false);
    expect(s.failIfUnavailable).toBe(false);
    expect(s.filesystem?.allowWrite).toEqual([clone, artifacts, tmpdir(), ...cacheDirs("/home/me")]);
    expect(s.filesystem?.denyWrite).toBeUndefined();
    expect(s.network?.allowedDomains).toEqual(["*"]);
  });

  // Value: protects=the host repo's .git from an agent that swaps its clone's .git for a `gitdir:` pointer between phases; fails_when=the next phase reads the pointer and allows host git paths, or runs at all; why_new=F1, clone mode was read from the clone's own .git; seam=none
  test("a clone whose .git became a pointer gets no host paths and the phase refuses to run", async () => {
    const clone = join(root, "work", "task-2");
    await git(root, "clone", "-q", "--shared", repo, clone);
    rmSync(join(clone, ".git"), { recursive: true, force: true });
    writeFileSync(join(clone, ".git"), `gitdir: ${join(repo, ".git")}\n`);
    const guard = { ...request().guard, worktree: clone };
    const req = request({ cwd: clone, guard, isolated: true });
    const allow = sandboxFor(req, "/home/me").filesystem?.allowWrite ?? [];
    expect(allow.some((p) => p.startsWith(repo))).toBe(false);
    let called = false;
    scripted = async function* () {
      called = true;
      yield { type: "system" };
    };
    const r = await new SdkEngine().runPhase(req, () => {});
    expect(called).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.error).toBe(TAMPERED);
    // A symlinked .git is refused too.
    rmSync(join(clone, ".git"));
    symlinkSync(join(repo, ".git"), join(clone, ".git"));
    expect((await new SdkEngine().runPhase(req, () => {})).error).toBe(TAMPERED);
    expect(called).toBe(false);
  });

  // Value: protects=the repo's own refs when a phase runs in the main checkout; fails_when=the main checkout's .git is left writable under cwd; why_new=only hooks and config were denied there before; seam=none
  test("in the main checkout the sandbox denies every ref", () => {
    const s = sandboxFor(request(), "/home/me");
    expect(s.filesystem?.allowWrite).toContain(repo);
    const deny = s.filesystem?.denyWrite ?? [];
    expect(deny).toContain(join(repo, ".git", "refs"));
    expect(deny).toContain(join(repo, ".git", "HEAD"));
    expect(deny).toContain(join(repo, ".git", "packed-refs"));
  });

  // Value: protects=the dashboard token in browser localStorage from the agent's Bash; fails_when=denyRead goes, or a deniedDomains entry (which a probe showed doesn't block loopback) leaks the API port to the agent; why_new=Y2/Y3; seam=none
  test("the sandbox denies reading browser profiles and doesn't name the API port", () => {
    const old = process.env.NIGHTCREW_API_PORT;
    process.env.NIGHTCREW_API_PORT = "48123";
    try {
      const s = sandboxFor(request(), "/home/me");
      expect(s.filesystem?.denyRead).toEqual(browserProfileDirs("/home/me"));
      expect(JSON.stringify(s)).not.toContain("48123");
    } finally {
      if (old === undefined) delete process.env.NIGHTCREW_API_PORT;
      else process.env.NIGHTCREW_API_PORT = old;
    }
  });
});
