import { expect, test } from "bun:test";
import { type DepartureTask, departureChecks, scopesMayOverlap } from "./departure";
import type { Repo } from "./tasks";

const repo: Repo = {
  id: "repo",
  name: "Demo",
  path: "/demo",
  defaultBranch: "main",
  protectedBranches: [],
  testCommand: null,
  level: "train",
  createdAt: "",
  setupCommand: null,
  previewCommand: null,
  previewUrl: null,
  previewPaths: ["/"],
  shipBranch: null,
  allowShip: [],
  alwaysAsk: [],
};
const task: DepartureTask = {
  id: "task",
  repoId: repo.id,
  title: "Feature",
  type: "implementation",
  scope: ["src/**"],
  dependsOn: [],
  tokenBudget: 100_000,
  testCommand: null,
  question: null,
  runAt: null,
};

test("unsupported routing metadata produces a hold without constructing a policy", () => {
  for (const invalid of [{ type: "feature" }, { workflow: "unbounded" }]) {
    const check = departureChecks({ ...task, ...invalid } as DepartureTask, repo);
    expect(check.route).toBeNull();
    expect(check.evidence).toEqual([]);
    expect(check.signals).toMatchObject([{ code: "task-routing", kind: "hold", target: "task" }]);
  }
});

test("required verification holds before dispatch; task command overrides the repository default", () => {
  const configured: Repo = {
    ...repo,
    policies: { implementation: { autonomy: null, requireTests: true, visual: true, regression: false } },
  };
  expect(
    departureChecks(task, configured)
      .signals.filter((s) => s.kind === "hold")
      .map((s) => s.code),
  ).toEqual(["tests", "preview"]);
  expect(
    departureChecks({ ...task, testCommand: "bun test" }, { ...configured, previewCommand: "static" }).signals,
  ).toEqual([]);
  expect(departureChecks({ ...task, testCommand: "   " }, configured).signals.some((s) => s.code === "tests")).toBe(
    true,
  );
});

test("planning and research require no build configuration, but unanswered questions hold", () => {
  expect(departureChecks({ ...task, type: "ui" }, { ...repo, level: "propose" }).signals).toEqual([]);
  expect(departureChecks({ ...task, type: "research" }, repo).signals).toEqual([]);
  expect(
    departureChecks({ ...task, question: "Which behavior?" }, repo).signals.some(
      (s) => s.kind === "hold" && s.code === "question",
    ),
  ).toBe(true);
  expect(departureChecks(task, repo).signals.some((s) => s.kind === "hold")).toBe(false);
  expect(departureChecks(task, null).signals[0]?.code).toBe("repo");
});

test("scope overlap is conservative for globs, while separate directories and files stay distinct", () => {
  expect(scopesMayOverlap(["src/**"], ["src/ui/button.ts"])).toBe(true);
  expect(scopesMayOverlap([], ["docs/**"])).toBe(true);
  expect(scopesMayOverlap(["**/*.ts"], ["lib/**"])).toBe(true);
  expect(scopesMayOverlap(["src/ui/**"], ["src/server/**"])).toBe(false);
  expect(scopesMayOverlap(["src/a.ts"], ["src/b.ts"])).toBe(false);
});
