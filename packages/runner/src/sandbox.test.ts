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
  // Value: protects=checks may write only their dir, temp dirs, package caches and a few device files, never the dir's .git pointer, with denies after the allows; fails_when=a subpath is dropped, a path isn't resolved to its real path, /dev is writable whole, the deny moves before the allows, or a quote in a path breaks out of the string; why_new=G6 sandbox is new, F3 narrowed /dev; seam=none
  test("allows the dir, temp, caches and safe devices, then denies the pointer", () => {
    const p = seatbeltProfile(wt);
    expect(p.startsWith("(version 1)\n(allow default)\n(deny file-write*)")).toBe(true);
    for (const sub of [
      wt,
      realpathSync(tmpdir()),
      "/private/tmp",
      "/private/var/folders",
      "/dev/fd",
      join(homedir(), ".npm"),
      join(homedir(), ".bun/install/cache"),
      join(homedir(), ".cache"),
      join(homedir(), ".pnpm-store"),
      join(homedir(), ".yarn"),
      join(homedir(), "Library/Caches"),
      join(homedir(), ".cargo/registry"),
    ])
      expect(p).toContain(`(subpath "${sub}")`);
    for (const dev of ["/dev/null", "/dev/zero", "/dev/random", "/dev/urandom"])
      expect(p).toContain(`(literal "${dev}")`);
    expect(p).not.toContain('(subpath "/dev")');
    const denies = p.lastIndexOf("(deny file-write*");
    expect(denies).toBeGreaterThan(p.indexOf("(allow file-write*"));
    expect(p.slice(denies)).toContain(`(literal "${join(wt, ".git")}")`);
    expect(seatbeltProfile('/x/a "b"\\c')).toContain('(subpath "/x/a \\"b\\"\\\\c")');
  });

  // Value: protects=the host repo's git dir, lfs, submodule git dirs (config, hooks) from checks in NightCrew's own worktrees; fails_when=the profile follows the worktree's pointer and allows its gitdir, <common>/lfs or <common>/modules; why_new=F2, checks there could write the host's submodule hooks; seam=none
  test("a worktree NightCrew owns may write only itself, none of the repo's git data", () => {
    const p = seatbeltProfile(wt);
    expect(p).not.toContain(join(repo, ".git"));
    expect(bwrapArgs(wt).join(" ")).not.toContain(join(repo, ".git"));
  });

  // Value: protects=submodules, git-lfs and stash in a task's clone, and the host repo when the agent swaps the clone's .git for a pointer; fails_when=a clone gets denies, or its .git is parsed so a planted `gitdir:` adds host paths; why_new=F2, the clone's .git was parsed; seam=none
  test("a clone is writable whole and its .git is never read", () => {
    const p = seatbeltProfile(clone, { clone: true });
    expect(p).toContain(`(subpath "${clone}")`);
    expect(p).not.toContain("(deny file-write*\n");
    expect(p).not.toContain(join(repo, ".git"));
    rmSync(join(clone, ".git"), { recursive: true, force: true });
    writeFileSync(join(clone, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "wt")}\n`);
    expect(seatbeltProfile(clone, { clone: true })).not.toContain(join(repo, ".git"));
    const a = bwrapArgs(clone, { clone: true }).join(" ");
    expect(a).not.toContain(join(repo, ".git"));
    expect(a).not.toContain(`--ro-bind ${join(clone, ".git")}`);
  });

  // Value: protects=checks from starting a process outside the sandbox through launchd, LaunchServices or Apple Events, and from typing into a terminal; fails_when=the exec, mach-lookup or tty ioctl denies go missing; why_new=the profile only limited writes, so `open` or `launchctl` escaped it; seam=none
  test("blocks the launchers, the services that start work outside the sandbox, and tty ioctls", () => {
    const p = seatbeltProfile(clone, { clone: true });
    const exec = p.slice(p.indexOf("(deny process-exec"));
    for (const bin of ["/bin/launchctl", "/usr/bin/open", "/usr/bin/osascript"])
      expect(exec).toContain(`(literal "${bin}")`);
    const mach = p.slice(p.indexOf("(deny mach-lookup"));
    expect(mach).toContain('(global-name "com.apple.coreservices.launchservicesd")');
    expect(mach).toContain('(global-name "com.apple.coreservices.quarantine-resolver")');
    expect(mach).toContain('(global-name "com.apple.coreservices.appleevents")');
    expect(mach).toContain('(global-name-regex #"^com\\.apple\\.lsd\\.")');
    expect(p).toContain('(deny file-ioctl (literal "/dev/tty") (regex #"^/dev/ttys"))');
  });

  // Value: protects=what's typed in NightCrew's and the user's other terminals from a check reading it; fails_when=the file-read deny on /dev/tty, /dev/ttysN or /dev/ptmx goes missing, or widens to all of /dev; why_new=K2 probe opened /dev/ttys000 read-only; seam=none
  test("denies reading terminals and the pty master, not other devices", () => {
    const p = seatbeltProfile(clone, { clone: true });
    expect(p).toContain('(deny file-read* (literal "/dev/tty") (regex #"^/dev/ttys[0-9]+$") (literal "/dev/ptmx"))');
    expect(p).not.toContain('(deny file-read* (subpath "/dev")');
  });

  // Value: protects=a check on Linux from writing a worktree's pointer, from injecting into the caller's terminal, and from outliving NightCrew; fails_when=the deny is bound before the writable mount it narrows (later mounts win), or --new-session, --die-with-parent or --unshare-pid go missing; why_new=S5; seam=none
  test("bubblewrap binds the dir writable, then the pointer read-only", () => {
    const a = bwrapArgs(wt).join(" ");
    expect(a).toContain(
      "--ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --new-session --die-with-parent --unshare-pid",
    );
    const wtBind = a.indexOf(`--bind ${wt} ${wt}`);
    expect(wtBind).toBeGreaterThan(0);
    expect(a.indexOf(`--ro-bind ${join(wt, ".git")} `)).toBeGreaterThan(wtBind);
  });

  // Value: protects=a clone of a repo under /tmp can read the objects it borrows inside bwrap, from paths NightCrew passes, never its alternates file; fails_when=the objects bind lands before --tmpfs /tmp (hidden again), is writable, or comes from the clone's alternates; why_new=K5 private /tmp hid the alternates target; seam=none
  test("bubblewrap binds a clone's borrowed objects read-only after the private /tmp", () => {
    const objects = join(repo, ".git", "objects");
    const a = bwrapArgs(clone, { clone: true, objects: [objects, join(dir, "missing")] });
    const bind = a.findIndex((x, i) => x === "--ro-bind" && a[i + 1] === objects && a[i + 2] === objects);
    expect(bind).toBeGreaterThan(a.indexOf("--tmpfs"));
    expect(bind).toBeGreaterThan(a.indexOf(clone));
    expect(a).not.toContain(join(dir, "missing"));
    expect(a.slice(-2)).toEqual(["--chdir", clone]);
    // Nothing is read from the clone: with no objects given, no repo path appears.
    writeFileSync(join(clone, ".git", "objects", "info", "alternates"), `${join(dir, "elsewhere")}\n`);
    const plain = bwrapArgs(clone, { clone: true }).join(" ");
    expect(plain).not.toContain(repo);
    expect(plain).not.toContain(join(dir, "elsewhere"));
  });
});

describe.skipIf(process.platform !== "darwin")("real sandbox on macOS", () => {
  // Value: protects=a check really can't write outside its worktree, temp dirs and caches, can't touch the repo's git data from a worktree NightCrew owns, and still runs bun; fails_when=the profile stops applying, the deny order flips (Seatbelt is last-match-wins), the gitdir is writable again, or the allows are too narrow for bun; why_new=G6 sandbox is new, F2 dropped the gitdir allow; seam=none
  test("writes inside the worktree and temp work, writes elsewhere fail", async () => {
    // Temp is writable, so the repo here lives outside it, like a real one.
    const home = realpathSync(mkdtempSync(join(homedir(), ".nc-sbx-")));
    const outside = join(homedir(), `nc-probe-outside-${crypto.randomUUID()}.txt`);
    try {
      const hrepo = join(home, "repo");
      const hwt = join(home, "wt");
      await git(home, "clone", "-q", repo, hrepo);
      await git(hrepo, "worktree", "add", "-q", "-b", "task", hwt);
      const r = await runCheck(
        [
          "echo a > ./inside.txt && echo ok-inside",
          'echo b > "$TMPDIR/nc-sbx-x" && echo ok-tmp',
          `echo c > '${outside}' && echo LEAK-home`,
          "echo d > .git && echo LEAK-pointer",
          "echo e > ../repo/.git/hooks/pre-commit && echo LEAK-hooks",
          "echo f > ../repo/.git/worktrees/wt/nc-probe && echo LEAK-gitdir",
          "mkdir -p ../repo/.git/modules/x && echo LEAK-modules",
          "echo ref: refs/heads/main > ../repo/.git/worktrees/wt/HEAD && echo LEAK-head",
          "bun --version >/dev/null && echo ok-bun",
          "true",
        ].join("; "),
        hwt,
      );
      expect(r.stdout.split("\n").filter(Boolean)).toEqual(["ok-inside", "ok-tmp", "ok-bun"]);
      expect(existsSync(join(hwt, "inside.txt"))).toBe(true);
      expect(existsSync(outside)).toBe(false);
      expect(existsSync(join(hrepo, ".git", "hooks", "pre-commit"))).toBe(false);
      expect(existsSync(join(hrepo, ".git", "modules"))).toBe(false);
      expect((await git(hwt, "branch", "--show-current")).stdout.trim()).toBe("task");
    } finally {
      rmSync(home, { recursive: true, force: true });
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
      { clone: true },
    );
    expect(r.stdout.split("\n").filter(Boolean)).toEqual(["ok-commit", "ok-stash", "ok-hooks"]);
  });

  // Value: protects=NightCrew's terminal from a check (typing into it, writing to it, reading other terminals); fails_when=checks inherit the controlling tty, /dev is writable whole, or /dev/ttysN and /dev/ptmx can be opened for reading; why_new=F3, Seatbelt allowed all of /dev and checks kept the session; K2 added the read probe; seam=none
  test("a check has no terminal and can't write to one", async () => {
    const r = await runCheck(
      [
        "(exec 3</dev/tty) 2>/dev/null && echo LEAK-tty-open",
        'python3 -c \'import os,glob; [os.open(p, os.O_RDONLY|os.O_NONBLOCK|os.O_NOCTTY) for p in glob.glob("/dev/ttys[0-9]*") + ["/dev/ptmx"]]\' 2>/dev/null && echo LEAK-tty-read',
        "sh -c 'echo x > /dev/tty' 2>/dev/null && echo LEAK-tty-write",
        "echo x > /dev/null && head -c1 /dev/urandom >/dev/null && echo ok-dev",
        "true",
      ].join("; "),
      clone,
      { clone: true },
    );
    expect(r.stdout.split("\n").filter(Boolean)).toEqual(["ok-dev"]);
  });

  // Value: protects=checks from escaping the sandbox through launchd, LaunchServices or Apple Events; fails_when=the exec denies stop applying; why_new=the profile only limited writes; seam=none
  test("launchctl, open and osascript can't run", async () => {
    const r = await runCheck(
      "for b in /bin/launchctl /usr/bin/open /usr/bin/osascript; do $b >/dev/null 2>&1; echo $?; done; bun --version >/dev/null && echo ok-bun",
      clone,
      { clone: true },
    );
    expect(r.stdout.split("\n").filter(Boolean)).toEqual(["126", "126", "126", "ok-bun"]);
  });
});
