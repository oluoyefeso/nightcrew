import { describe, expect, test } from "bun:test";
import { AUTONOMY_ORDER, DEFAULT_TASK_POLICY, resolvePolicy, tightenPolicy, validatePolicies } from "./policy";

describe("task routes", () => {
  test("a task rule never exceeds the repo ceiling", () => {
    for (const [i, level] of AUTONOMY_ORDER.entries())
      for (const [j, autonomy] of AUTONOMY_ORDER.entries()) {
        expect(
          resolvePolicy({ level, policies: { refactor: { ...DEFAULT_TASK_POLICY, autonomy } } }, "refactor").authority,
        ).toBe(AUTONOMY_ORDER[Math.min(i, j)]!);
      }
  });
  test("default routes preserve UI and bug-fix requirements and keep research read-only", () => {
    expect(resolvePolicy({ level: "ship" }, "ui").visual).toBe(true);
    expect(resolvePolicy({ level: "ship" }, "bugfix").regression).toBe(true);
    expect(resolvePolicy({ level: "ship" }, "research")).toMatchObject({
      authority: "propose",
      visual: false,
      regression: false,
    });
  });
  test("a running route retains every restriction already observed", () => {
    const start = resolvePolicy(
      { level: "train", policies: { refactor: { ...DEFAULT_TASK_POLICY, visual: true } } },
      "refactor",
    );
    const current = resolvePolicy(
      { level: "ship", policies: { refactor: { ...DEFAULT_TASK_POLICY, regression: true } } },
      "refactor",
    );
    expect(tightenPolicy(start, current)).toMatchObject({
      authority: "train",
      visual: true,
      regression: true,
      requireTests: true,
    });
    const held = tightenPolicy(start, resolvePolicy({ level: "propose" }, "refactor"));
    expect(tightenPolicy(held, current).authority).toBe("propose");
  });
  test("unknown keys, misspellings and non-boolean settings are rejected", () => {
    expect(validatePolicies({ ui: DEFAULT_TASK_POLICY })).toBeNull();
    for (const value of [
      null,
      [],
      { research: DEFAULT_TASK_POLICY },
      { ui: {} },
      { ui: { ...DEFAULT_TASK_POLICY, visual: "false" } },
      { ui: { ...DEFAULT_TASK_POLICY, autonomy: "main" } },
      { ui: { ...DEFAULT_TASK_POLICY, bypass: true } },
    ])
      expect(validatePolicies(value)).not.toBeNull();
  });
});
