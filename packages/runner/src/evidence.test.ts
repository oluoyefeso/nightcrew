import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addRepo, createTask, type Db, getRepo, openDb, updateRepo } from "@nightcrew/db";
import { gatherEvidence, summarizeEvidence } from "./evidence";
import { git } from "./git";
import { ensureWorkspace } from "./workspace";

let dir: string;
let repoPath: string;
let db: Db;

async function commit(msg: string) {
  await git(repoPath, "add", "-A");
  await git(repoPath, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", msg);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "nc-ev-"));
  repoPath = join(dir, "app");
  mkdirSync(join(repoPath, "tests"), { recursive: true });
  await git(repoPath, "init", "-q", "-b", "main");
  db = openDb(":memory:");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A task clone of the app on `branch`, at main. */
async function clone(repoId: string, branch: string) {
  const base = (await git(repoPath, "rev-parse", "main")).stdout.trim();
  const task = { id: branch.replace(/\W+/g, "-"), branch };
  return (await ensureWorkspace({ dataDir: join(dir, "data"), repo: { id: repoId, path: repoPath }, task, base })).dir;
}

const opts = (taskId: string, worktree: string, repoId: string) => {
  const repo = getRepo(db, repoId);
  if (!repo) throw new Error("no repo");
  return {
    repo,
    worktree,
    artifactsDir: join(dir, "artifacts"),
    branchTestsPassed: true,
    log: () => {},
    signal: new AbortController().signal,
    task: { ...createTaskStub(taskId, repoId) },
  };
};

function createTaskStub(title: string, repoId: string) {
  return createTask(db, { repoId, title, type: title.startsWith("ui") ? "ui" : "bugfix", scope: [] });
}

describe("fail-then-pass", () => {
  beforeEach(async () => {
    writeFileSync(join(repoPath, "math.sh"), "add() { echo $(( $1 - $2 )); }\n"); // the bug: subtracts
    writeFileSync(join(repoPath, "tests", "existing.test.sh"), "true\n");
    await commit("init");
  });

  test("a new test that fails on main and passes on the branch proves the fix", async () => {
    const repo = addRepo(db, {
      name: "app",
      path: repoPath,
      defaultBranch: "main",
      testCommand: "sh -c 'for t in tests/*.test.sh; do sh $t || exit 1; done'",
    });
    const wt = await clone(repo.id, "fix/add");
    writeFileSync(join(wt, "math.sh"), "add() { echo $(( $1 + $2 )); }\n");
    writeFileSync(join(wt, "tests", "add.test.sh"), '. ./math.sh; [ "$(add 2 3)" = "5" ]\n');
    mkdirSync(join(dir, "artifacts"), { recursive: true });

    const ev = await gatherEvidence(opts("bug: add subtracts", wt, repo.id));
    expect(ev.testProof?.testFiles).toEqual(["tests/add.test.sh"]);
    expect(ev.testProof?.failsOnBase).toBe(true);
    expect(ev.missing).toEqual([]);
    expect(summarizeEvidence(ev)).toContain("FAIL on the base branch");
    // The comparison checkout is cleaned up.
    expect(existsSync(join(repoPath, ".worktrees", "_base-"))).toBe(false);
  });

  test("a test that passes without the fix is flagged", async () => {
    const repo = addRepo(db, {
      name: "app",
      path: repoPath,
      defaultBranch: "main",
      testCommand: "sh -c 'for t in tests/*.test.sh; do sh $t || exit 1; done'",
    });
    const wt = await clone(repo.id, "fix/weak");
    writeFileSync(join(wt, "tests", "weak.test.sh"), "true\n");
    mkdirSync(join(dir, "artifacts"), { recursive: true });
    const ev = await gatherEvidence(opts("bug: weak test", wt, repo.id));
    expect(ev.testProof?.failsOnBase).toBe(false);
    expect(ev.missing[0]).toContain("also passes without the fix");
  });

  test("no test at all is flagged", async () => {
    const repo = addRepo(db, { name: "app", path: repoPath, defaultBranch: "main", testCommand: "true" });
    const wt = await clone(repo.id, "fix/none");
    writeFileSync(join(wt, "math.sh"), "add() { echo $(( $1 + $2 )); }\n");
    mkdirSync(join(dir, "artifacts"), { recursive: true });
    const ev = await gatherEvidence(opts("bug: no test", wt, repo.id));
    expect(ev.missing[0]).toContain("No new or changed test");
  });
});

describe("screenshots", () => {
  test(
    "captures before/after in both viewports and themes, diffs them and scans accessibility",
    async () => {
      writeFileSync(
        join(repoPath, "index.html"),
        "<!doctype html><html lang=en><head><title>App</title><style>body{background:#fff;color:#111}@media (prefers-color-scheme:dark){body{background:#111;color:#eee}}</style></head><body><main><h1>Widgets</h1></main></body></html>",
      );
      await commit("init");
      const repo = addRepo(db, { name: "app", path: repoPath, defaultBranch: "main" });
      updateRepo(db, repo.id, { previewCommand: "static", previewUrl: "http://localhost:{port}", previewPaths: ["/"] });
      const wt = await clone(repo.id, "crew/button");
      writeFileSync(
        join(wt, "index.html"),
        // Adds a button with no accessible name: a new accessibility issue.
        "<!doctype html><html lang=en><head><title>App</title><style>body{background:#fff;color:#111}@media (prefers-color-scheme:dark){body{background:#111;color:#eee}}button{width:200px;height:80px;background:#f2a65a}</style></head><body><main><h1>Widgets</h1><button></button></main></body></html>",
      );
      mkdirSync(join(dir, "artifacts"), { recursive: true });

      const ev = await gatherEvidence(opts("ui: add a button", wt, repo.id));
      expect(ev.notes).toEqual([]);
      expect(ev.screenshots).toHaveLength(4);
      expect(new Set(ev.screenshots.map((s) => `${s.viewport}-${s.theme}`))).toEqual(
        new Set(["desktop-light", "desktop-dark", "mobile-light", "mobile-dark"]),
      );
      for (const s of ev.screenshots) {
        expect(s.before).not.toBeNull();
        expect(existsSync(join(dir, "artifacts", s.after))).toBe(true);
        expect(s.changedPct).toBeGreaterThan(0);
      }
      expect(ev.a11y?.newIssues.map((i) => i.id)).toContain("button-name");
      expect(ev.missing).toEqual([]);
    },
    { timeout: 90_000 },
  );

  test("a UI task without a preview command reports the missing screenshots", async () => {
    writeFileSync(join(repoPath, "README.md"), "x");
    await commit("init");
    const repo = addRepo(db, { name: "app", path: repoPath, defaultBranch: "main" });
    const wt = await clone(repo.id, "crew/x");
    mkdirSync(join(dir, "artifacts"), { recursive: true });
    const ev = await gatherEvidence(opts("ui: no preview", wt, repo.id));
    expect(ev.missing[0]).toContain("No preview command");
  });
});
