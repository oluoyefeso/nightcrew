import { describe, expect, test } from "bun:test";
import { branchFor, nextStart, planQueue, slugify } from "./tasks";

describe("planQueue", () => {
  const t = (id: string, position: number, dependsOn: string[] = [], status = "queued" as const) => ({
    id,
    position,
    dependsOn,
    status,
  });
  test("orders by position", () => {
    expect(planQueue([t("b", 2), t("a", 1), t("c", 3)]).order).toEqual(["a", "b", "c"]);
  });
  test("never runs a task before its dependency", () => {
    expect(planQueue([t("child", 1, ["parent"]), t("parent", 2)]).order).toEqual(["parent", "child"]);
  });
  test("done dependencies count as satisfied", () => {
    const r = planQueue([t("child", 1, ["old"]), { id: "old", position: 0, dependsOn: [], status: "done" as const }]);
    expect(r.order).toEqual(["child"]);
  });
  test("missing or circular dependencies are blocked", () => {
    const r = planQueue([t("a", 1, ["nope"]), t("x", 2, ["y"]), t("y", 3, ["x"]), t("ok", 4)]);
    expect(r.order).toEqual(["ok"]);
    expect(r.blocked.map((b) => b.id).sort()).toEqual(["a", "x", "y"]);
  });
});

describe("naming", () => {
  test("slugify", () => {
    expect(slugify("Dark mode for the widget dashboard!")).toBe("dark-mode-for-the-widget-dashboard");
    expect(slugify("  ")).toBe("task");
  });
  test("branchFor uses a prefix per type", () => {
    expect(branchFor("Detect 429s in JSON stdout", "bugfix")).toBe("fix/detect-429s-in-json-stdout");
    expect(branchFor("Dark mode", "ui")).toBe("crew/dark-mode");
  });
});

describe("nextStart", () => {
  test("later today when the time hasn't passed", () => {
    const now = new Date("2026-10-10T20:00:00");
    expect(nextStart("22:00", now).toString()).toBe(new Date("2026-10-10T22:00:00").toString());
  });
  test("tomorrow once it has", () => {
    const now = new Date("2026-10-10T23:30:00");
    expect(nextStart("22:00", now).toString()).toBe(new Date("2026-10-11T22:00:00").toString());
  });
});
