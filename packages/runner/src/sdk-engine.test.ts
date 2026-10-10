import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PhaseRequest } from "./engine";
import { git, run } from "./git";
import { agentEnv, SdkEngine, sandboxFor } from "./sdk-engine";

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
afterEach(() => rmSync(root, { recursive: true, force: true }));

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

  test("the agent's git can't push to a real remote, and this process still can", async () => {
    await git(repo, "remote", "add", "origin", "https://github.com/acme/widgets.git");
    await git(repo, "remote", "add", "ssh", "git@github.com:acme/widgets.git");
    const env = agentEnv(process.env) as Record<string, string>;
    expect(process.env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");

    const pushUrl = (remote: string, e?: Record<string, string>) =>
      run(["git", "remote", "get-url", "--push", remote], repo, { env: e });
    expect((await pushUrl("origin", env)).stdout.trim()).toBe("nightcrew-blocked://github.com/acme/widgets.git");
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
    expect(allow).toContain(join(repo, ".git", "worktrees", "task"));
    expect(allow).toContain(join(repo, ".git", "objects"));
    expect(allow).toContain("/home/me/.npm");
    expect(allow).not.toContain(repo);
    expect(allow).not.toContain("/home/me");
    expect(s.filesystem?.denyWrite).toEqual([join(repo, ".git", "hooks"), join(repo, ".git", "config")]);
    expect(s.network?.allowedDomains).toEqual(["*"]);
  });
});
