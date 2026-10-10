import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./git";
import { bwrapArgs, runCheck, seatbeltProfile } from "./sandbox";

let dir: string;
let repo: string;
let wt: string;
let clone: string;

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
  clone = join(dir, "clone");
  await git(dir, "clone", "-q", "--shared", repo, clone);
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

  // Value: protects=git in an integration worktree can write its own index, logs, lfs and submodule data, but never the files that tie it to a repo and a branch; fails_when=the worktree's gitdir isn't allowed, or HEAD, commondir, gitdir or config.worktree aren't denied after it; why_new=design point 10; seam=none
  test("a linked worktree may write its own gitdir, lfs and modules, minus what ties it to a branch", () => {
    const p = seatbeltProfile(wt);
    const own = join(repo, ".git", "worktrees", "wt");
    const allows = p.slice(p.indexOf("(allow file-write*"), p.lastIndexOf("(deny file-write*"));
    for (const sub of [own, join(repo, ".git", "lfs"), join(repo, ".git", "modules")])
      expect(allows).toContain(`(subpath "${sub}")`);
    const denies = p.slice(p.lastIndexOf("(deny file-write*"));
    for (const f of ["HEAD", "commondir", "gitdir", "config.worktree"])
      expect(denies).toContain(`(literal "${join(own, f)}")`);
  });

  // Value: protects=submodules, git-lfs and stash in a task's clone, which shares nothing writable with the host; fails_when=a clone's .git is still denied; why_new=design point 10, clones replace linked worktrees; seam=none
  test("a standalone clone is writable whole, .git included", () => {
    const p = seatbeltProfile(clone);
    expect(p).toContain(`(subpath "${clone}")`);
    expect(p).not.toContain("(deny file-write*\n");
    expect(p).not.toContain(join(repo, ".git"));
  });

  // Value: protects=checks from starting a process outside the sandbox through launchd, LaunchServices or Apple Events; fails_when=the exec or mach-lookup denies go missing; why_new=the profile only limited writes, so `open` or `launchctl` escaped it; seam=none
  test("blocks the launchers and the services that start work outside the sandbox", () => {
    const p = seatbeltProfile(clone);
    const exec = p.slice(p.indexOf("(deny process-exec"));
    for (const bin of ["/bin/launchctl", "/usr/bin/open", "/usr/bin/osascript"])
      expect(exec).toContain(`(literal "${bin}")`);
    const mach = p.slice(p.indexOf("(deny mach-lookup"));
    expect(mach).toContain('(global-name "com.apple.coreservices.launchservicesd")');
    expect(mach).toContain('(global-name "com.apple.coreservices.quarantine-resolver")');
    expect(mach).toContain('(global-name "com.apple.coreservices.appleevents")');
    expect(mach).toContain('(global-name-regex #"^com\\.apple\\.lsd\\.")');
  });

  // Value: protects=a check on Linux from writing a linked worktree's pointer, HEAD or the shared config, from injecting into the caller's terminal, and from outliving NightCrew; fails_when=a deny is bound before the writable mount it narrows (later mounts win), or --new-session, --die-with-parent or --unshare-pid go missing; why_new=S5 and design point 10; seam=none
  test("bubblewrap binds the worktree and its gitdir writable, then the git denies read-only", () => {
    const a = bwrapArgs(wt).join(" ");
    expect(a).toContain(
      "--ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --new-session --die-with-parent --unshare-pid",
    );
    const own = join(repo, ".git", "worktrees", "wt");
    const wtBind = a.indexOf(`--bind ${wt} ${wt}`);
    const ownBind = a.indexOf(`--bind ${own} ${own}`);
    expect(wtBind).toBeGreaterThan(a.indexOf(`--ro-bind ${join(repo, ".git")} `));
    expect(ownBind).toBeGreaterThan(wtBind);
    expect(a.indexOf(`--ro-bind ${join(wt, ".git")} `)).toBeGreaterThan(wtBind);
    expect(a.indexOf(`--ro-bind ${join(own, "HEAD")} `)).toBeGreaterThan(ownBind);
    expect(a.indexOf(`--ro-bind ${join(repo, ".git", "config")} `)).toBeGreaterThan(wtBind);
  });

  // Value: protects=git in a clone under /tmp on Linux, whose borrowed objects the /tmp tmpfs would hide; fails_when=the alternates' object dir isn't bound read-only; why_new=clones borrow objects through alternates; seam=none
  test("bubblewrap keeps a clone's borrowed objects readable", () => {
    const a = bwrapArgs(clone).join(" ");
    const objects = join(repo, ".git", "objects");
    expect(a).toContain(`--ro-bind ${objects} ${objects}`);
    expect(a.indexOf(`--bind ${clone} ${clone}`)).toBeGreaterThan(a.indexOf(`--ro-bind ${objects}`));
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
          "echo f > ../repo/.git/worktrees/wt/nc-probe && echo ok-gitdir",
          "echo ref: refs/heads/main > ../repo/.git/worktrees/wt/HEAD && echo LEAK-head",
          "bun --version >/dev/null && echo ok-bun",
          "true",
        ].join("; "),
        wt,
      );
      expect(r.stdout.split("\n").filter(Boolean)).toEqual(["ok-inside", "ok-tmp", "ok-gitdir", "ok-bun"]);
      expect(existsSync(join(wt, "inside.txt"))).toBe(true);
      expect(existsSync(outside)).toBe(false);
      expect(existsSync(join(repo, ".git", "hooks", "pre-commit"))).toBe(false);
      expect((await git(wt, "branch", "--show-current")).stdout.trim()).toBe("task");
    } finally {
      rmSync(outside, { force: true });
      rmSync(join(tmpdir(), "nc-sbx-x"), { force: true });
    }
  });

  // Value: protects=git commit, stash and hook files inside a task's clone; fails_when=the clone's .git is denied; why_new=design point 10; seam=none
  test("git works inside a clone", async () => {
    const r = await runCheck(
      [
        "echo b > b.txt && git add -A && git -c user.name=t -c user.email=t@t commit -qm b && echo ok-commit",
        "echo c > c.txt && git stash -q -u && git stash list | grep -q stash@ && echo ok-stash",
        "echo x > .git/hooks/post-commit && echo ok-hooks",
        "true",
      ].join("; "),
      clone,
    );
    expect(r.stdout.split("\n").filter(Boolean)).toEqual(["ok-commit", "ok-stash", "ok-hooks"]);
  });

  // Value: protects=checks from escaping the sandbox through launchd, LaunchServices or Apple Events; fails_when=the exec denies stop applying; why_new=the profile only limited writes; seam=none
  test("launchctl, open and osascript can't run", async () => {
    const r = await runCheck(
      "for b in /bin/launchctl /usr/bin/open /usr/bin/osascript; do $b >/dev/null 2>&1; echo $?; done; bun --version >/dev/null && echo ok-bun",
      clone,
    );
    expect(r.stdout.split("\n").filter(Boolean)).toEqual(["126", "126", "126", "ok-bun"]);
  });
});
