import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./git";
import { bwrapArgs, checkEnv, runCheck, seatbeltProfile } from "./sandbox";

let dir: string;
let repo: string;
let wt: string;

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "nc-sbx-")));
  repo = join(dir, "repo");
  wt = join(dir, "wt");
  mkdirSync(repo);
  writeFileSync(join(repo, "a.txt"), "a\n");
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "add", "-A");
  await git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  await git(repo, "worktree", "add", "-q", "-b", "task", wt, "main");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("seatbelt profile", () => {
  // Value: protects=checks may write only the worktree, temp dirs and package caches, never the worktree's .git pointer or the repo's hooks and config, with denies after the allows; fails_when=a subpath is dropped, a path isn't resolved to its real path, the git denies move before the allows, or a quote in a path breaks out of the string; why_new=G6 sandbox is new; seam=none
  test("allows the worktree, temp and caches, then denies git internals", () => {
    const p = seatbeltProfile(wt);
    expect(p.startsWith("(version 1)\n(allow default)\n(deny file-write*)")).toBe(true);
    for (const sub of [
      wt,
      realpathSync(tmpdir()),
      "/private/tmp",
      "/private/var/folders",
      "/dev",
      join(homedir(), ".npm"),
      join(homedir(), ".bun/install/cache"),
      join(homedir(), ".cache"),
      join(homedir(), ".pnpm-store"),
      join(homedir(), ".yarn"),
      join(homedir(), "Library/Caches"),
      join(homedir(), ".cargo/registry"),
    ])
      expect(p).toContain(`(subpath "${sub}")`);
    expect(p).toContain('(literal "/dev/null")');
    const denies = p.lastIndexOf("(deny file-write*");
    expect(denies).toBeGreaterThan(p.indexOf("(allow file-write*"));
    expect(p.slice(denies)).toContain(`(literal "${join(wt, ".git")}")`);
    expect(p.slice(denies)).toContain(`(subpath "${join(repo, ".git", "hooks")}")`);
    expect(p.slice(denies)).toContain(`(literal "${join(repo, ".git", "config")}")`);
    expect(seatbeltProfile('/x/a "b"\\c')).toContain('(subpath "/x/a \\"b\\"\\\\c")');
  });

  test("bubblewrap binds the worktree writable and its .git pointer read-only after it", () => {
    const a = bwrapArgs(wt).join(" ");
    expect(a).toContain("--ro-bind / / --dev /dev --proc /proc --tmpfs /tmp");
    expect(a).toContain(`--bind ${wt} ${wt}`);
    expect(a.indexOf(`--ro-bind ${join(wt, ".git")}`)).toBeGreaterThan(a.indexOf(`--bind ${wt} ${wt}`));
  });
});

describe("check environment", () => {
  // Value: protects=repo commands never see NightCrew's GitHub, npm, cloud, Slack or model credentials; fails_when=a token variable or prefix is dropped from the strip list; why_new=G6 env sanitizer is new; seam=none
  test("strips credentials and keeps the rest", () => {
    const added = {
      GH_TOKEN: "x",
      GITHUB_TOKEN: "x",
      NPM_TOKEN: "x",
      AWS_SECRET_ACCESS_KEY: "x",
      AZURE_CLIENT_SECRET: "x",
      SLACK_BOT_TOKEN: "x",
      ANTHROPIC_API_KEY: "x",
      TYPESAFE_API_KEY: "x",
      NC_KEEP_ME: "yes",
    };
    Object.assign(process.env, added);
    try {
      const env = checkEnv({ PORT: "3000" });
      for (const k of [
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "NPM_TOKEN",
        "AWS_SECRET_ACCESS_KEY",
        "AZURE_CLIENT_SECRET",
        "SLACK_BOT_TOKEN",
        "ANTHROPIC_API_KEY",
        "TYPESAFE_API_KEY",
      ])
        expect(env[k]).toBeUndefined();
      expect(env).toMatchObject({ NC_KEEP_ME: "yes", PORT: "3000", GIT_TERMINAL_PROMPT: "0" });
    } finally {
      for (const k of Object.keys(added)) delete process.env[k];
    }
  });
});

describe.skipIf(process.platform !== "darwin")("real sandbox on macOS", () => {
  // Value: protects=a check really can't write outside its worktree, temp dirs and caches, can't touch git hooks even under an allowed temp dir, and still runs bun; fails_when=the profile stops applying, the deny order flips (Seatbelt is last-match-wins), or the allows are too narrow for bun; why_new=G6 sandbox is new; seam=none
  test("writes inside the worktree and temp work, writes elsewhere fail", async () => {
    const outside = join(homedir(), `nc-probe-outside-${crypto.randomUUID()}.txt`);
    try {
      const r = await runCheck(
        [
          "echo a > ./inside.txt && echo ok-inside",
          'echo b > "$TMPDIR/nc-sbx-x" && echo ok-tmp',
          `echo c > '${outside}' && echo LEAK-home`,
          "echo d > .git && echo LEAK-pointer",
          "echo e > ../repo/.git/hooks/pre-commit && echo LEAK-hooks",
          "bun --version >/dev/null && echo ok-bun",
          "true",
        ].join("; "),
        wt,
      );
      expect(r.stdout.split("\n").filter(Boolean)).toEqual(["ok-inside", "ok-tmp", "ok-bun"]);
      expect(existsSync(join(wt, "inside.txt"))).toBe(true);
      expect(existsSync(outside)).toBe(false);
      expect(existsSync(join(repo, ".git", "hooks", "pre-commit"))).toBe(false);
      expect((await git(wt, "branch", "--show-current")).stdout.trim()).toBe("task");
    } finally {
      rmSync(outside, { force: true });
      rmSync(join(tmpdir(), "nc-sbx-x"), { force: true });
    }
  });
});
