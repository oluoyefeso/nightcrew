import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realSdk from "@anthropic-ai/claude-agent-sdk";
import { type PhaseRequest, STOPPED } from "./engine";
import { git, run } from "./git";
import { agentEnv, SdkEngine, sandboxFor } from "./sdk-engine";

// query() can be swapped for a scripted stream. Unset, it is the real SDK, so
// other test files sharing this process are unaffected.
let scripted: ((args: unknown) => AsyncGenerator<unknown>) | null = null;
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  ...realSdk,
  query: (args: Parameters<typeof realSdk.query>[0]) => (scripted ? scripted(args) : realSdk.query(args)),
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
      yield assistant("m2", { input_tokens: 300, cache_creation_input_tokens: 20, output_tokens: 5 });
      stop.abort();
    };
    const r = await new SdkEngine().runPhase(request({ signal: stop.signal }), () => {});
    expect(r.tokensIn).toBe(150 + 320);
    expect(r.tokensOut).toBe(40 + 5);
    expect(r.error).toBe(STOPPED);
    expect(r.ok).toBe(false);
    expect(r.sessionId).toBe("s1");
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

  // Value: protects=GitHub, cloud and registry tokens from the agent's shell; fails_when=agentEnv copies credentials or drops the Anthropic sign-in; why_new=the env was copied wholesale before; seam=none
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
      ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "HOME", "PATH"].sort(),
    );
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant");
  });

  test("the sandbox limits Bash writes to the worktree, its git data, artifacts, temp and caches", async () => {
    const wt = join(repo, ".worktrees", "task");
    await git(repo, "worktree", "add", "-q", "-b", "nc/task", wt);
    const artifacts = join(root, "artifacts");
    const s = sandboxFor(
      request({ cwd: wt, guard: { ...request().guard, worktree: wt, writableDirs: [artifacts] } }),
      "/home/me",
    );
    expect(s.enabled).toBe(true);
    expect(s.allowUnsandboxedCommands).toBe(false);
    expect(s.failIfUnavailable).toBe(false);
    const allow = s.filesystem?.allowWrite ?? [];
    expect(allow).toContain(wt);
    expect(allow).toContain(artifacts);
    expect(allow).toContain(tmpdir());
    expect(allow).toContain("/home/me/.npm");
    expect(allow).not.toContain(repo);
    expect(allow).not.toContain("/home/me");
    expect(s.network?.allowedDomains).toEqual(["*"]);
  });

  // Value: protects=main, the ship branch and the repo's git plumbing from the agent's shell; fails_when=the sandbox leaves other refs, pointer files, hooks or config writable; why_new=refs, logs and objects were all writable before; seam=none
  test("the sandbox lets a worktree commit on its own branch and denies the rest of git", async () => {
    const wt = join(repo, ".worktrees", "crew-x");
    await git(repo, "worktree", "add", "-q", "-b", "crew/x", wt);
    await git(repo, "worktree", "add", "-q", "-b", "crew/y", join(repo, ".worktrees", "crew-y"));
    // A packed branch has no folder of its own; the sandbox can't create one.
    await git(repo, "pack-refs", "--all");
    const common = join(repo, ".git");
    const own = join(common, "worktrees", "crew-x");
    const guard = { ...request().guard, worktree: wt, protectedBranches: ["main", "nc/ship"] };
    const s = sandboxFor(request({ cwd: wt, guard }), "/home/me");
    const allow = (s.filesystem?.allowWrite ?? []).filter((p) => p.startsWith(common));
    expect(allow.sort()).toEqual(
      [
        own,
        join(common, "objects"),
        join(common, "refs/heads/crew/x"),
        join(common, "refs/heads/crew/x.lock"),
        join(common, "logs/refs/heads/crew/x"),
        join(common, "refs/stash"),
        join(common, "refs/stash.lock"),
        join(common, "logs/refs/stash"),
      ].sort(),
    );
    const deny = s.filesystem?.denyWrite ?? [];
    for (const p of [
      join(wt, ".git"),
      join(own, "HEAD"),
      join(own, "commondir"),
      join(own, "gitdir"),
      join(own, "config.worktree"),
      join(common, "worktrees", "crew-y"),
      join(common, "refs/heads/main"),
      join(common, "refs/heads/main.lock"),
      join(common, "refs/heads/crew/y"),
      join(common, "refs/heads/nc/ship"),
      join(common, "refs/tags"),
      join(common, "HEAD"),
      join(common, "commondir"),
      join(common, "packed-refs"),
      join(common, "hooks"),
      join(common, "config"),
      join(common, "info"),
      join(common, "remotes"),
      join(common, "objects/info/alternates"),
    ])
      expect(deny).toContain(p);
    expect(deny.filter((p) => p.includes("crew/x"))).toEqual([]);
    expect(existsSync(join(common, "refs/heads/crew"))).toBe(true);
  });

  // Value: protects=the repo's own refs when a phase runs in the main checkout; fails_when=the main checkout's .git is left writable under cwd; why_new=only hooks and config were denied there before; seam=none
  test("in the main checkout the sandbox denies every ref", () => {
    const s = sandboxFor(request(), "/home/me");
    const deny = s.filesystem?.denyWrite ?? [];
    expect(deny).toContain(join(repo, ".git", "refs"));
    expect(deny).toContain(join(repo, ".git", "HEAD"));
    expect(deny).toContain(join(repo, ".git", "packed-refs"));
  });
});
