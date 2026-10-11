import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseWorktree, git, openOrUpdatePr, pushTo, run, withRepoLock } from "./git";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** pids still in process group `pgid`. */
const inGroup = (pgid: number) =>
  Bun.spawnSync(["ps", "-A", "-o", "pid=,pgid="])
    .stdout.toString()
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter(([, g]) => g === pgid)
    .map(([pid]) => pid);
const PERL_SETSID =
  'use POSIX qw(setsid); setsid() >= 0 or die "setsid: $!"; exec { $ARGV[0] } @ARGV or die "exec: $!"';
// A check leads its own group (it starts a new session), like this wrapper.
const leader = (script: string) => ["perl", "-e", PERL_SETSID, "sh", "-c", script];
/** Wait up to `ms` for group `pgid` to empty, and return what's left. */
async function drained(pgid: number, ms = 4000) {
  const deadline = Date.now() + ms;
  while (inGroup(pgid).length && Date.now() < deadline) await sleep(100);
  return inGroup(pgid);
}

describe("withRepoLock", () => {
  // Value: protects=git admin work on one repo runs one at a time, other repos stay parallel, and a throwing holder frees the lock; fails_when=the lock chain is dropped, keyed wrongly or wedged by a rejection; why_new=lock untested; seam=none
  test("serializes work on one repo, runs other repos concurrently, and survives a throwing holder", async () => {
    const log: string[] = [];
    const job = (name: string, ms: number) => async () => {
      log.push(`${name}:start`);
      await sleep(ms);
      log.push(`${name}:end`);
      return name;
    };
    const repoA = `/repos/a-${crypto.randomUUID()}`;
    const repoB = `/repos/b-${crypto.randomUUID()}`;

    const failing = withRepoLock(repoA, async () => {
      log.push("boom:start");
      await sleep(40);
      log.push("boom:end");
      throw new Error("git worktree add failed");
    });
    const first = withRepoLock(repoA, job("a1", 30));
    const second = withRepoLock(repoA, job("a2", 10));
    const other = withRepoLock(repoB, job("b1", 10));

    await expect(failing).rejects.toThrow("git worktree add failed");
    expect(await first).toBe("a1");
    expect(await second).toBe("a2");
    expect(await other).toBe("b1");

    const a = log.filter((e) => !e.startsWith("b1"));
    expect(a).toEqual(["boom:start", "boom:end", "a1:start", "a1:end", "a2:start", "a2:end"]);
    // Repo b didn't wait for repo a's queue.
    expect(log.indexOf("b1:end")).toBeLessThan(log.indexOf("boom:end"));
  });
});

describe("run with a stop signal", () => {
  // Value: protects=a stop kills setup, test and preview commands instead of waiting them out, with SIGKILL for ones that ignore SIGTERM; fails_when=run() drops the signal, the SIGKILL fallback, or waits on pipes a killed command's children still hold; why_new=R1 added the signal; seam=none
  test("kills the command on stop, and SIGKILLs one that ignores SIGTERM", async () => {
    for (const script of ["sleep 30; echo done", "trap '' TERM; sleep 30; echo done"]) {
      const stop = new AbortController();
      setTimeout(() => stop.abort(), 100);
      const started = Date.now();
      const r = await run(["sh", "-c", script], tmpdir(), { signal: stop.signal });
      expect(r.ok).toBe(false);
      expect(r.stdout).not.toContain("done");
      expect(Date.now() - started).toBeLessThan(6000);
    }
  }, 15_000);

  test("an already-stopped signal runs nothing, and no signal behaves as before", async () => {
    const stop = new AbortController();
    stop.abort();
    expect((await run(["sh", "-c", "echo ran"], tmpdir(), { signal: stop.signal })).stdout).toBe("");
    expect(await run(["sh", "-c", "echo ran; exit 3"], tmpdir())).toMatchObject({
      ok: false,
      code: 3,
      stdout: "ran\n",
    });
  });
});

describe("run kills the whole process group", () => {
  // Value: protects=a stopped or timed-out check leaves no grandchildren behind (ppid 1) and run() returns promptly even when one holds stdout or ignores SIGTERM; fails_when=run() signals only the leader pid, drops the group SIGKILL after the grace, or awaits a timed-out command's pipes forever; why_new=K4 setsid made checks their own group; seam=none
  test.each([
    ["stop", "(sleep 60 &) ; sleep 60"],
    ["timeout", "(sleep 60 &) ; sleep 60"],
    ["stop", "(trap '' TERM; sleep 60 &) ; sleep 60"],
    ["timeout", "(trap '' TERM; sleep 60 &) ; sleep 60"],
  ])(
    "%s: %s",
    async (how, script) => {
      const dir = mkdtempSync(join(tmpdir(), "nc-run-"));
      try {
        const pidFile = join(dir, "pid");
        const stop = new AbortController();
        if (how === "stop") setTimeout(() => stop.abort(), 300);
        const started = Date.now();
        const r = await run(leader(`echo $$ > ${pidFile}; ${script}`), dir, {
          signal: stop.signal,
          timeoutMs: how === "timeout" ? 300 : undefined,
        });
        expect(Date.now() - started).toBeLessThan(3000);
        expect(r.ok).toBe(false);
        expect(r.stderr).toContain(how === "stop" ? "Stopped." : "Timed out.");
        const pgid = Number(readFileSync(pidFile, "utf8").trim());
        expect(pgid).toBeGreaterThan(1);
        // SIGTERM reaches the group at once, SIGKILL after the 2s grace.
        const deadline = Date.now() + 4000;
        while (inGroup(pgid).length && Date.now() < deadline) await sleep(100);
        expect(inGroup(pgid)).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    15_000,
  );
});

describe("withRepoLock with a stop signal", () => {
  // Value: protects=a stopped task stops waiting for the repo lock at once and its work never runs, while work that already holds the lock finishes; fails_when=withRepoLock ignores the signal (a stopped task queues behind a long clone or merge) or abandons a holder mid-way; why_new=G10 lock waits ignored stops; seam=none
  test("a stop gives up the wait, and the queued work never runs", async () => {
    const repo = `/repos/s-${crypto.randomUUID()}`;
    const ran: string[] = [];
    const stop = new AbortController();
    const holder = withRepoLock(
      repo,
      async () => {
        await sleep(80);
        ran.push("holder");
        return "held";
      },
      stop.signal,
    );
    await sleep(10);
    const waiter = new AbortController();
    const queued = withRepoLock(
      repo,
      async () => {
        ran.push("queued");
      },
      waiter.signal,
    );
    waiter.abort();
    stop.abort();
    await expect(queued).rejects.toThrow("Stopped.");
    expect(await holder).toBe("held");
    await withRepoLock(repo, async () => {});
    expect(ran).toEqual(["holder"]);
  });
});

describe("hardened host git", () => {
  // Value: protects=checkouts NightCrew makes in your repo (base and integration worktrees) never run a git-lfs filter, even one your repo's config points at a command; fails_when=GIT_HARDEN loses the filter.lfs overrides and a checkout of agent-written trees runs the smudge or process filter; why_new=G3 lane checkouts ran LFS filters; seam=none
  test("a base checkout runs no lfs filter", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nc-git-"));
    try {
      const marker = join(dir, "filter-ran");
      await git(dir, "init", "-q", "-b", "main");
      writeFileSync(join(dir, ".gitattributes"), "*.bin filter=lfs\n");
      writeFileSync(join(dir, "a.bin"), "data\n");
      await git(dir, "add", "-A");
      await git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
      await git(dir, "config", "filter.lfs.smudge", `sh -c 'echo smudge >> ${marker}; cat'`);
      await git(dir, "config", "filter.lfs.process", `sh -c 'echo process >> ${marker}; exit 1'`);
      await git(dir, "config", "filter.lfs.required", "true");
      const base = await baseWorktree(dir, "main", "lfs");
      expect(readFileSync(join(base.dir, "a.bin"), "utf8")).toBe("data\n");
      await base.remove();
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("run keeps output bounded", () => {
  // Value: protects=a check that floods stdout returns bounded output and keeps the end (where failures are); fails_when=run() returns the whole stream or drops the tail; why_new=G1 unbounded output; seam=none
  test("50 MB of output keeps the head and tail and stays bounded", async () => {
    const r = await run(["sh", "-c", "echo START; head -c 50000000 /dev/zero | tr '\\0' x; echo; echo END"], tmpdir());
    expect(r.ok).toBe(true);
    // RSS is an allocator high-water mark: Bun can keep released pipe buffers
    // mapped after the command ends, particularly on Linux. Check the value
    // retained for callers rather than the process's mapped pages.
    expect(r.stdout.length).toBeLessThan(64 * 1024 + 1024 * 1024 + 200);
    expect(r.stdout.startsWith("START\n")).toBe(true);
    expect(r.stdout.trimEnd().endsWith("END")).toBe(true);
    expect(r.stdout).toMatch(/… \d+ bytes omitted …/);
  }, 30_000);
});

describe("run after the leader exits", () => {
  // Value: protects=a finished check whose background grandchild holds stdout returns promptly, keeps its output, and leaves nothing running; fails_when=run() waits on the pipes until every holder exits or stops watching the group once the leader is gone; why_new=G4 finished checks could hang; seam=none
  test("a background child holding stdout doesn't hang a finished check", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nc-run-"));
    try {
      const pidFile = join(dir, "pid");
      const started = Date.now();
      const r = await run(leader(`echo $$ > ${pidFile}; (sleep 20) & echo started`), dir, { timeoutMs: 3000 });
      expect(Date.now() - started).toBeLessThan(4000);
      expect(r.stdout).toContain("started");
      expect(await drained(Number(readFileSync(pidFile, "utf8").trim()))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  // Value: protects=a stop or timeout that lands after the leader exited still kills the group and returns; fails_when=run() disarms the abort listener or timer at leader exit; why_new=G4 stop after leader exit was lost; seam=none
  test.each(["stop", "timeout"])(
    "%s after the leader exits kills what's left",
    async (how) => {
      const dir = mkdtempSync(join(tmpdir(), "nc-run-"));
      try {
        const pidFile = join(dir, "pid");
        const stop = new AbortController();
        if (how === "stop") setTimeout(() => stop.abort(), 300);
        const started = Date.now();
        const r = await run(leader(`echo $$ > ${pidFile}; (trap '' TERM; sleep 20) & echo started`), dir, {
          signal: stop.signal,
          timeoutMs: how === "timeout" ? 300 : undefined,
        });
        expect(Date.now() - started).toBeLessThan(2500);
        expect(r.ok).toBe(false);
        expect(r.stderr).toContain(how === "stop" ? "Stopped." : "Timed out.");
        expect(r.stdout).toContain("started");
        expect(await drained(Number(readFileSync(pidFile, "utf8").trim()))).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    15_000,
  );

  // Value: protects=live check groups die with NightCrew instead of running on as orphans; fails_when=the exit handler or group tracking is dropped; why_new=G4 exit left checks running; seam=none
  test("NightCrew exiting SIGKILLs live check groups", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nc-run-"));
    try {
      const pidFile = join(dir, "pid");
      const script = `
        import { run } from ${JSON.stringify(join(import.meta.dir, "git.ts"))};
        void run(["perl", "-e", ${JSON.stringify(PERL_SETSID)}, "sh", "-c", "echo $$ > ${pidFile}; (sleep 30 &); sleep 30"], ${JSON.stringify(dir)});
        const until = Date.now() + 5000;
        while (!(await Bun.file(${JSON.stringify(pidFile)}).exists()) && Date.now() < until) await Bun.sleep(50);
        await Bun.sleep(100);
        process.exit(0);
      `;
      const child = Bun.spawn(["bun", "-e", script], { stdout: "inherit", stderr: "inherit" });
      expect(await child.exited).toBe(0);
      expect(await drained(Number(readFileSync(pidFile, "utf8").trim()), 1000)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("publishing never hangs", () => {
  let dir: string;
  let path: string | undefined;
  /** A fake `gh` first on PATH, running `body` as a shell script. */
  function fakeGh(body: string) {
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gh"), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, "gh"), 0o755);
    path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
  }
  const pr = { branch: "crew/x", base: "main", title: "t", body: "b" };

  // Value: protects=a push to a remote that never answers fails the publish step instead of hanging the task forever; fails_when=pushTo drops its timeout; why_new=G2 publishing could hang; seam=none
  test("a stalled push times out", async () => {
    dir = mkdtempSync(join(tmpdir(), "nc-pub-"));
    try {
      await git(dir, "init", "-q", "-b", "main");
      await git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
      await git(dir, "remote", "add", "origin", "ssh://nightcrew.invalid/x.git");
      await git(dir, "config", "core.sshCommand", "sleep 5 #");
      const started = Date.now();
      const r = await pushTo(dir, "HEAD", "crew/x", 300);
      expect(Date.now() - started).toBeLessThan(3000);
      expect(r.ok).toBe(false);
      expect(r.stderr).toContain("Timed out.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  // Value: protects=a gh that never answers fails the PR step instead of hanging it, and a stop cuts it off; fails_when=openOrUpdatePr's gh calls lose their timeout or signal; why_new=G2 publishing could hang; seam=none
  test("a stalled gh times out, and a stop cuts it off", async () => {
    dir = mkdtempSync(join(tmpdir(), "nc-pub-"));
    try {
      fakeGh("exec sleep 30");
      let started = Date.now();
      await expect(openOrUpdatePr(dir, pr, { timeoutMs: 300 })).rejects.toThrow("Timed out.");
      expect(Date.now() - started).toBeLessThan(3000);
      const stop = new AbortController();
      setTimeout(() => stop.abort(), 300);
      started = Date.now();
      await expect(openOrUpdatePr(dir, pr, { signal: stop.signal })).rejects.toThrow("Stopped.");
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      if (path !== undefined) process.env.PATH = path;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  // Value: protects=a failed body update on an open PR is reported, not silently treated as done; fails_when=openOrUpdatePr ignores gh pr edit's result again; why_new=G3 edit failure was swallowed; seam=none
  test("a failed gh pr edit keeps the PR but warns", async () => {
    dir = mkdtempSync(join(tmpdir(), "nc-pub-"));
    try {
      fakeGh(`case "$2" in
  list) echo '[{"url":"https://github.com/o/r/pull/7","number":7}]' ;;
  edit) echo "GraphQL: Resource not accessible" >&2; exit 1 ;;
  *) exit 2 ;;
esac`);
      const r = await openOrUpdatePr(dir, pr);
      expect(r).toMatchObject({ url: "https://github.com/o/r/pull/7", number: 7 });
      expect(r.warning).toContain("Resource not accessible");
    } finally {
      if (path !== undefined) process.env.PATH = path;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
