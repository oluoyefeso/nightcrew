import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, run, taskChangedFiles } from "./git";
import { cloneChangedFiles, commitInClone, ensureWorkspace, fetchTask, taskRef, workspaceFor } from "./workspace";

let dir: string;
let repoPath: string;
let base: string;
const ID = ["-c", "user.name=t", "-c", "user.email=t@t"];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "nc-ws-"));
  repoPath = join(dir, "acme");
  mkdirSync(join(repoPath, "src"), { recursive: true });
  writeFileSync(join(repoPath, "src", "index.ts"), "export const x = 1;\n");
  await git(repoPath, "init", "-q", "-b", "main");
  await git(repoPath, "add", "-A");
  await git(repoPath, ...ID, "commit", "-qm", "init");
  base = (await git(repoPath, "rev-parse", "main")).stdout.trim();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const workspace = (taskId = "task_1", branch = "crew/one") =>
  ensureWorkspace({
    dataDir: join(dir, "data"),
    repo: { id: "repo_1", path: repoPath },
    task: { id: taskId, branch },
    base,
  });

const sha = async (cwd: string, ref: string) => (await git(cwd, "rev-parse", ref)).stdout.trim();

/** Commit in the clone the way an agent would, with plain git. */
async function agentCommit(cwd: string, file: string, content = "x\n") {
  mkdirSync(join(cwd, file, ".."), { recursive: true });
  writeFileSync(join(cwd, file), content);
  await git(cwd, "add", "-A");
  await git(cwd, ...ID, "commit", "-qm", `agent: ${file}`);
}

describe("task workspaces", () => {
  // Value: protects=each task gets a standalone clone outside the repo (own .git folder, borrowed objects, no remote) and nothing done to git in it moves the repo's refs; fails_when=tasks go back to linked worktrees sharing the repo's .git, or the clone keeps an origin pointing at the repo; why_new=D12 per-task isolation; seam=none
  test("a clone is standalone, has no remote, and can't move your repo's refs", async () => {
    const ws = await workspace();
    expect(ws.dir).toBe(join(dir, "data", "work", "repo_1", "task_1"));
    expect(ws.fresh).toBe(true);
    expect(statSync(join(ws.dir, ".git")).isDirectory()).toBe(true);
    expect(readFileSync(join(ws.dir, ".git", "objects", "info", "alternates"), "utf8")).toContain(
      join(repoPath, ".git", "objects"),
    );
    expect((await git(ws.dir, "remote")).stdout.trim()).toBe("");
    expect((await git(ws.dir, "branch", "--show-current")).stdout.trim()).toBe("crew/one");
    expect(await sha(ws.dir, "HEAD")).toBe(base);
    expect(workspaceFor(ws.dir)).toMatchObject({ repoPath, taskId: "task_1", branch: "crew/one" });

    // Everything an agent can do to git in its clone stays in the clone.
    await agentCommit(ws.dir, "evil.txt");
    const evil = await sha(ws.dir, "HEAD");
    for (const ref of ["refs/heads/main", "refs/heads/dev", "refs/remotes/origin/main", "refs/crew/one"])
      expect((await git(ws.dir, "update-ref", ref, evil)).ok).toBe(true);
    await git(ws.dir, "config", "core.hooksPath", ".husky/_");
    expect(await sha(repoPath, "refs/heads/main")).toBe(base);
    expect((await git(repoPath, "for-each-ref", "--format=%(refname)")).stdout.trim()).toBe("refs/heads/main");
    expect((await git(repoPath, "config", "--local", "--get", "core.hooksPath")).ok).toBe(false);

    // A second call reuses the clone, work and all.
    const again = await workspace();
    expect(again.fresh).toBe(false);
    expect(existsSync(join(again.dir, "evil.txt"))).toBe(true);
  });

  // Value: protects=a folder at the workspace path that isn't a clone (e.g. .git swapped for a pointer to your repo's git dir) is refused, not reused; fails_when=ensureWorkspace reuses any existing folder; why_new=D12 reuse check; seam=none
  test("a workspace whose .git isn't a folder is refused", async () => {
    const ws = await workspace();
    rmSync(join(ws.dir, ".git"), { recursive: true, force: true });
    writeFileSync(join(ws.dir, ".git"), `gitdir: ${join(repoPath, ".git")}\n`);
    await expect(workspace()).rejects.toThrow("isn't a NightCrew clone");
  });

  // Value: protects=clone-side commits run through the check sandbox without hooks, and say whether anything was committed; fails_when=commitInClone runs the clone's hooks or reports a commit when nothing changed; why_new=D12 no host git in clones; seam=none
  test("commits in the clone run without its hooks", async () => {
    const ws = await workspace();
    mkdirSync(join(ws.dir, ".husky", "_"), { recursive: true });
    const marker = join(dir, "hook-ran");
    for (const hook of ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"]) {
      writeFileSync(join(ws.dir, ".husky", "_", hook), `#!/bin/sh\necho ${hook} >> '${marker}'\n`, { mode: 0o755 });
    }
    await git(ws.dir, "config", "core.hooksPath", ".husky/_");
    writeFileSync(join(ws.dir, "src", "a.ts"), "a\n");
    expect(await commitInClone(ws.dir, "work")).toBe(true);
    expect(await commitInClone(ws.dir, "nothing")).toBe(false);
    expect(existsSync(marker)).toBe(false);
    expect(await cloneChangedFiles(ws.dir, base)).toEqual([
      ".husky/_/commit-msg",
      ".husky/_/post-commit",
      ".husky/_/pre-commit",
      ".husky/_/prepare-commit-msg",
      "src/a.ts",
    ]);
  });
});

describe("fetch, then check in your repo", () => {
  // Value: protects=the final gate reads the fetched commit with your repo's git, so replace refs and a shallow file planted in the clone can't hide a workflow change; fails_when=the gate trusts the clone's git (or honors replace objects) and sees only src/ changes; why_new=D12 fetch-then-validate; seam=none
  test("a workflow change is seen even when the clone's replace refs and shallow file hide it", async () => {
    const ws = await workspace();
    await agentCommit(ws.dir, "src/feature.ts");
    const decoy = await sha(ws.dir, "HEAD");
    await agentCommit(ws.dir, ".github/workflows/ci.yml", "on: push\n");
    const real = await sha(ws.dir, "HEAD");
    // The agent swaps its real commit for the decoy: the clone's own git now hides the workflow.
    await git(ws.dir, "replace", "-f", real, decoy);
    const fooled = await run(["git", "diff", "--name-only", base, "HEAD"], ws.dir);
    expect(fooled.stdout).not.toContain(".github/workflows/ci.yml");
    expect(await taskChangedFiles(repoPath, base, await fetchTask(ws))).toContain(".github/workflows/ci.yml");

    // And cuts history short. The fetch is refused, or the real change is still in the list.
    writeFileSync(join(ws.dir, ".git", "shallow"), `${decoy}\n`);
    let files: string[] | null = null;
    let refused: unknown = null;
    try {
      files = await taskChangedFiles(repoPath, base, await fetchTask(ws));
    } catch (e) {
      refused = e;
    }
    if (refused === null) expect(files).toContain(".github/workflows/ci.yml");
    else expect(String(refused)).toContain("Couldn't take the task's work");
    // Nothing the clone did reached your repo's own state.
    expect(existsSync(join(repoPath, ".git", "shallow"))).toBe(false);
    expect((await git(repoPath, "for-each-ref", "refs/replace")).stdout).toBe("");
  });

  // Value: protects=a fetched commit that doesn't descend from the pinned base is refused instead of diffed; fails_when=taskChangedFiles diffs any two commits, so a rewritten branch picks its own base; why_new=D12 ancestry check; seam=none
  test("work that doesn't build on the pinned base is refused", async () => {
    const ws = await workspace();
    await git(ws.dir, "checkout", "-q", "--orphan", "fresh");
    await agentCommit(ws.dir, "src/new.ts");
    await git(ws.dir, "branch", "-f", "crew/one", "HEAD");
    const fetched = await fetchTask(ws);
    expect(await sha(repoPath, taskRef("task_1"))).toBe(fetched);
    await expect(taskChangedFiles(repoPath, base, fetched)).rejects.toThrow(
      "doesn't build on the commit it started from",
    );
  });

  // Value: protects=the changed-file check fails closed and never hides a deleted path behind a rename; fails_when=a diff error returns an empty list (fail open) or rename detection lists only the new name; why_new=cycle-3 review: changedFiles failed open; seam=none
  test("the changed-file list fails closed and shows both sides of a rename", async () => {
    const ws = await workspace();
    await git(ws.dir, "mv", "src/index.ts", "src/renamed.ts");
    await git(ws.dir, ...ID, "commit", "-qm", "rename");
    const fetched = await fetchTask(ws);
    expect(await taskChangedFiles(repoPath, base, fetched)).toEqual(["src/index.ts", "src/renamed.ts"]);
    await expect(taskChangedFiles(repoPath, base, "0".repeat(40))).rejects.toThrow("Couldn't");
    await expect(cloneChangedFiles(ws.dir, "not-a-commit")).rejects.toThrow("Couldn't list");
  });
});
