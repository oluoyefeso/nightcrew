import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, run, taskChangedFiles } from "./git";
import {
  cloneChangedFiles,
  commitInClone,
  ensureWorkspace,
  fetchTask,
  repoSupport,
  resolveRelativeUrl,
  taskRef,
  updateLocalBranch,
  workspaceFor,
} from "./workspace";

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
    const refused = workspace();
    await expect(refused).rejects.toThrow("isn't a NightCrew clone");
    // Deleting the folder resumes from the fetched work; starting over takes the ref and the pinned base too.
    await expect(refused).rejects.toThrow(`picks up from ${taskRef("task_1")}. To start the task over from scratch`);
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

describe("starting and refreshing a clone", () => {
  // Value: protects=a task whose clone is gone (deleted, as the refusal message advises, or a new data folder) starts its new clone from the work last fetched into refs/nightcrew/tasks/<id>, ahead of a stale local branch and the base; fails_when=ensureWorkspace drops the taskRef lookup or reorders it, so a WIP-only task restarts from main and loses its work; why_new=only the legacy-branch start was covered; seam=none
  test("a new clone starts from the last fetched work, ahead of the task branch and the base", async () => {
    const first = await workspace();
    await agentCommit(first.dir, "src/wip.ts", "half\n");
    const fetched = await fetchTask(first);
    // A stale local branch from an earlier version sits at the base.
    await git(repoPath, "branch", "crew/one", base);
    rmSync(first.dir, { recursive: true, force: true });
    const again = await workspace();
    expect(again.fresh).toBe(true);
    expect(await sha(again.dir, "HEAD")).toBe(fetched);
    expect(readFileSync(join(again.dir, "src", "wip.ts"), "utf8")).toBe("half\n");
  });

  // Value: protects=a leftover half-made clone from an earlier crash is cleared, and the next call builds a whole clone at the base; fails_when=ensureWorkspace reuses or trips over ${dir}.new instead of clearing it; why_new=G11 split the weak combined test; seam=none
  test("a leftover half-made clone is cleared and a fresh one is built", async () => {
    const target = join(dir, "data", "work", "repo_1", "task_1");
    mkdirSync(`${target}.new`, { recursive: true });
    writeFileSync(join(`${target}.new`, "junk"), "x");
    const ws = await workspace();
    expect(ws.fresh).toBe(true);
    expect(await sha(ws.dir, "HEAD")).toBe(base);
    expect(existsSync(`${target}.new`)).toBe(false);
    expect(existsSync(join(ws.dir, "junk"))).toBe(false);
  });

  // Value: protects=a clone that fails to set up leaves nothing behind to be reused as if it were whole; fails_when=ensureWorkspace clones straight into the final folder or skips cleanup on failure, so the next call reuses a broken clone (fresh=false); why_new=the build-aside-then-rename path was untested; seam=none
  test("a clone that fails to set up leaves nothing to reuse", async () => {
    const target = join(dir, "data", "work", "repo_1", "task_1");
    await expect(
      ensureWorkspace({
        dataDir: join(dir, "data"),
        repo: { id: "repo_1", path: repoPath },
        task: { id: "task_1", branch: "crew/one" },
        base: "f".repeat(40),
      }),
    ).rejects.toThrow("Couldn't set up the task's workspace");
    expect(existsSync(target)).toBe(false);
    expect(existsSync(`${target}.new`)).toBe(false);
    const ws = await workspace();
    expect(ws.fresh).toBe(true);
    expect(await sha(ws.dir, "HEAD")).toBe(base);
  });

  // Value: protects=a fetch from a clone with no commit checked out fails loudly and leaves the last good copy in refs/nightcrew/tasks/<id> and no stray incoming ref; fails_when=fetchTask resolves the task ref after a failed fetch and hands back the stale sha as current, or swallows the error; why_new=only the shallow-file refusal touched this path, and it accepts either outcome; seam=none
  test("a fetch from a clone with nothing checked out fails and keeps the last copy", async () => {
    const ws = await workspace();
    await agentCommit(ws.dir, "src/a.ts");
    const good = await fetchTask(ws);
    await git(ws.dir, "checkout", "-q", "--orphan", "empty");
    await expect(fetchTask(ws)).rejects.toThrow("Couldn't take the task's work from its workspace");
    expect(await sha(repoPath, taskRef("task_1"))).toBe(good);
    expect((await git(repoPath, "for-each-ref", "refs/nightcrew/incoming")).stdout).toBe("");
  });

  // Value: protects=the fetch takes the clone's checked-out commit (what NightCrew just tested), so switching branches in the clone can't hand over a different, untested tip; fails_when=fetchTask goes back to refs/heads/<branch>; why_new=G4 branch switch landed an older tip; seam=none
  test("the fetch takes the checked-out commit, whatever branch it's on", async () => {
    const ws = await workspace();
    await agentCommit(ws.dir, "src/old.ts");
    const old = await sha(ws.dir, "HEAD");
    await git(ws.dir, "checkout", "-q", "-b", "side", base);
    await agentCommit(ws.dir, "src/tested.ts");
    const tested = await sha(ws.dir, "HEAD");
    expect(await sha(ws.dir, "refs/heads/crew/one")).toBe(old);
    expect(await fetchTask(ws)).toBe(tested);
  });

  // Value: protects=the convenience copy of the task branch in your repo only fast-forwards, so it never overwrites commits you made on that branch yourself, and says why when it can't update; fails_when=updateLocalBranch force-moves the branch regardless of ancestry, or reports success when git refused; why_new=updateLocalBranch had no direct test; seam=none
  test("the local task branch fast-forwards, but a branch you moved elsewhere is left alone", async () => {
    const ws = await workspace();
    await agentCommit(ws.dir, "src/a.ts");
    const first = await fetchTask(ws);
    expect(await updateLocalBranch(repoPath, "crew/one", first)).toEqual({ ok: true });
    expect(await sha(repoPath, "refs/heads/crew/one")).toBe(first);
    await agentCommit(ws.dir, "src/b.ts");
    const second = await fetchTask(ws);
    expect(await updateLocalBranch(repoPath, "crew/one", second)).toEqual({ ok: true });
    expect(await sha(repoPath, "refs/heads/crew/one")).toBe(second);

    // You commit on the branch yourself; the next run's commit doesn't descend from yours.
    const mine = join(dir, "mine");
    await git(repoPath, "worktree", "add", "-q", mine, "crew/one");
    await agentCommit(mine, "src/mine.ts");
    const yours = await sha(mine, "HEAD");
    await git(repoPath, "worktree", "remove", "--force", mine);
    await agentCommit(ws.dir, "src/c.ts");
    const moved = await updateLocalBranch(repoPath, "crew/one", await fetchTask(ws));
    expect(moved).toEqual({ ok: false, reason: "crew/one has commits that aren't in the task's work" });
    expect(await sha(repoPath, "refs/heads/crew/one")).toBe(yours);
  });

  // Value: protects=a task branch checked out in your repo isn't updated, and the caller hears why so it can point you at refs/nightcrew/tasks/<id>; fails_when=updateLocalBranch ignores git branch's exit code and reports the branch as holding the work; why_new=G7 the result of git branch --force was never checked; seam=none
  test("a checked-out task branch isn't updated, and says so", async () => {
    const ws = await workspace();
    await git(repoPath, "checkout", "-q", "-b", "crew/one");
    await agentCommit(ws.dir, "src/a.ts");
    const fetched = await fetchTask(ws);
    expect(await updateLocalBranch(repoPath, "crew/one", fetched)).toEqual({
      ok: false,
      reason: "crew/one is checked out",
    });
    expect(await sha(repoPath, "refs/heads/crew/one")).toBe(base);
  });

  // Value: protects=a task branch you moved past the work NightCrew last fetched (locally, or on origin as last fetched) stops the task with what to do, instead of being ignored; fails_when=ensureWorkspace drops the moved-branch check and quietly resumes from refs/nightcrew/tasks/<id>; why_new=G8 user-moved branch was silently ignored; seam=none
  test("a task branch you moved since the last run stops the task with what to do", async () => {
    const first = await workspace();
    await agentCommit(first.dir, "src/wip.ts");
    const fetched = await fetchTask(first);
    // Behind the fetched work is fine: the clone carries on.
    await git(repoPath, "branch", "crew/one", base);
    expect((await workspace()).fresh).toBe(false);
    // You commit on top of the fetched work.
    const mine = join(dir, "mine");
    await git(repoPath, "worktree", "add", "-q", mine, "crew/one");
    await git(mine, "reset", "-q", "--hard", fetched);
    await agentCommit(mine, "src/mine.ts");
    await git(repoPath, "worktree", "remove", "--force", mine);
    await expect(workspace()).rejects.toThrow(
      `You moved crew/one since NightCrew last worked on it. Reset it to ${taskRef("task_1")}, or delete that ref and the task's workspace at ${first.dir} to start from your branch.`,
    );
    rmSync(first.dir, { recursive: true, force: true });
    await expect(workspace()).rejects.toThrow("or delete that ref to start from your branch.");

    // Origin's copy, as last fetched, counts too.
    await git(repoPath, "branch", "-f", "crew/one", fetched);
    await agentCommit(repoPath, "src/theirs.ts");
    await git(repoPath, "update-ref", "refs/remotes/origin/crew/one", await sha(repoPath, "HEAD"));
    await expect(workspace()).rejects.toThrow("crew/one on origin has commits NightCrew hasn't seen.");
  });

  // Value: protects=a new clone has the default branch at the pinned base, so the agent's `git diff main...HEAD` works even when your checkout is on another branch; fails_when=ensureWorkspace leaves only the branch your repo had checked out (or none) in the clone; why_new=G4 prompts diff against the default branch by name; seam=none
  test("a new clone has the default branch at the pinned base, whatever your checkout is on", async () => {
    await git(repoPath, "checkout", "-q", "-b", "feature");
    await agentCommit(repoPath, "src/feature.ts");
    await git(repoPath, "checkout", "-q", "main");
    await agentCommit(repoPath, "src/later.ts");
    await git(repoPath, "checkout", "-q", "feature");
    const ws = await ensureWorkspace({
      dataDir: join(dir, "data"),
      repo: { id: "repo_1", path: repoPath, defaultBranch: "main" },
      task: { id: "task_1", branch: "crew/one" },
      base,
    });
    expect(await sha(ws.dir, "refs/heads/main")).toBe(base);
    expect((await git(ws.dir, "diff", "--name-only", "main...HEAD")).ok).toBe(true);
  });

  // Value: protects=a clone of a repo with a relative-URL submodule can still init it after its origin is removed, because the URL is resolved against your repo first; fails_when=ensureWorkspace removes origin without copying submodule URLs, so `../sub` resolves against the clone's own folder; why_new=G5 probed submodule failure in clones; seam=none
  test("a relative-URL submodule still initializes in the clone", async () => {
    const sub = join(dir, "sub");
    mkdirSync(sub);
    writeFileSync(join(sub, "lib.txt"), "lib\n");
    await git(sub, "init", "-q", "-b", "main");
    await git(sub, "add", "-A");
    await git(sub, ...ID, "commit", "-qm", "lib");
    await git(repoPath, "-c", "protocol.file.allow=always", "submodule", "add", "-q", "../sub", "sub");
    await git(repoPath, ...ID, "commit", "-qm", "add sub");
    // Rely on .gitmodules alone, the way a repo that never ran `submodule init` looks.
    await git(repoPath, "config", "--unset", "submodule.sub.url");
    const ws = await ensureWorkspace({
      dataDir: join(dir, "data"),
      repo: { id: "repo_1", path: repoPath },
      task: { id: "task_1", branch: "crew/one" },
      base: await sha(repoPath, "HEAD"),
    });
    expect((await git(ws.dir, "config", "--get", "submodule.sub.url")).stdout.trim()).toBe(sub);
    const init = await run(
      ["git", "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--quiet"],
      ws.dir,
    );
    expect(init.stderr).toBe("");
    expect(readFileSync(join(ws.dir, "sub", "lib.txt"), "utf8")).toBe("lib\n");
  });

  // Value: protects=relative submodule URLs resolve the way git does, against a path, an https URL or an scp-style remote; fails_when=resolveRelativeUrl drops a component too many or too few, or mangles host:path remotes; why_new=G5; seam=none
  test("relative submodule URLs resolve like git's", () => {
    expect(resolveRelativeUrl("/x/acme", "../sub")).toBe("/x/sub");
    expect(resolveRelativeUrl("/x/acme/", "./sub")).toBe("/x/acme/sub");
    expect(resolveRelativeUrl("https://github.com/o/r.git", "../lib.git")).toBe("https://github.com/o/lib.git");
    expect(resolveRelativeUrl("git@github.com:o/r.git", "../../p/lib")).toBe("git@github.com:p/lib");
  });
});

describe("repos a clone can't reproduce", () => {
  // Value: protects=repos that rely on local git setup (git-lfs, git-crypt, sparse checkout) are refused with a clear reason before any clone, and an ordinary repo isn't; fails_when=repoSupport misses one of the three or flags a plain repo; why_new=G6 (D15) repos that rely on local git setup; seam=none
  test("git-lfs, git-crypt and sparse checkout are named; a plain repo is fine", async () => {
    expect(repoSupport(repoPath)).toBeNull();
    writeFileSync(join(repoPath, ".gitattributes"), "*.png filter=lfs diff=lfs merge=lfs -text\n");
    expect(repoSupport(repoPath)).toBe(
      "NightCrew can't work in this repo yet: it uses git-lfs. Support is coming; see docs/security.md.",
    );
    writeFileSync(join(repoPath, ".gitattributes"), "secrets/** filter=git-crypt diff=git-crypt\n");
    expect(repoSupport(repoPath)).toContain("it uses git-crypt.");
    rmSync(join(repoPath, ".gitattributes"));
    await git(repoPath, "config", "core.sparseCheckout", "true");
    expect(repoSupport(repoPath)).toContain("it uses sparse checkout.");
  });
});
