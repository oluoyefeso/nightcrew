import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemoEngine } from "./demo-engine";
import type { PhaseRequest } from "./engine";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nc-demo-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const request = (over: Partial<PhaseRequest> = {}): PhaseRequest => ({
  phase: "plan",
  cwd: dir,
  prompt: "Fix the bug.",
  systemPrompt: "",
  model: "demo",
  guard: { worktree: dir, writableDirs: [], scope: [], protectedBranches: ["main"], readOnly: false },
  maxTokens: 100_000,
  maxTurns: 10,
  signal: new AbortController().signal,
  ...over,
});

describe("DemoEngine", () => {
  test("concurrent phases each report their own usage", async () => {
    const engine = new DemoEngine(5);
    const [plan, implement] = await Promise.all([
      engine.runPhase(request({ phase: "plan" }), () => {}),
      engine.runPhase(request({ phase: "implement" }), () => {}),
    ]);
    expect(plan.tokensIn).toBe(18_000);
    expect(implement.tokensIn).toBe(42_000);
  });

  test("a stopped phase does nothing", async () => {
    const stop = new AbortController();
    stop.abort();
    const events: unknown[] = [];
    const r = await new DemoEngine(5).runPhase(request({ phase: "implement", signal: stop.signal }), (e) =>
      events.push(e),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Stopped: the task ran out of time or was cancelled.");
    expect(r.tokensIn).toBe(0);
    expect(events).toHaveLength(0);
    expect(existsSync(join(dir, "NIGHTCREW_DEMO.md"))).toBe(false);
  });

  test("a stop between steps ends the phase", async () => {
    const stop = new AbortController();
    const events: unknown[] = [];
    const r = await new DemoEngine(20).runPhase(request({ phase: "implement", signal: stop.signal }), (e) => {
      events.push(e);
      stop.abort();
    });
    expect(r.ok).toBe(false);
    expect(events).toHaveLength(1);
    expect(existsSync(join(dir, "NIGHTCREW_DEMO.md"))).toBe(false);
  });
});
