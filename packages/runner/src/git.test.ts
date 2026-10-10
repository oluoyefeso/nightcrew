import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { run, withRepoLock } from "./git";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
