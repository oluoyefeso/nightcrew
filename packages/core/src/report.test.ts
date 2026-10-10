import { describe, expect, test } from "bun:test";
import type { Run } from "./model";
import { classify, greeting, horizonPosition, horizonWindow, nightIdFor, summarize } from "./report";

function run(over: Partial<Run>): Run {
  return {
    id: "r",
    nightId: "2026-04-16",
    taskId: "t",
    title: "T",
    repo: "nightcrew",
    type: null,
    status: "complete",
    bucket: "ready",
    source: "classic",
    startedAt: null,
    endedAt: null,
    model: null,
    costCents: 0,
    tokensIn: 0,
    tokensOut: 0,
    attempt: 1,
    prUrl: null,
    prNumber: null,
    prState: null,
    branch: null,
    additions: null,
    deletions: null,
    changedFiles: null,
    reason: null,
    verdict: null,
    phase: null,
    confidence: null,
    shipSha: null,
    shipBranch: null,
    undoneAt: null,
    trainId: null,
    summary: null,
    triage: null,
    note: null,
    artifactKinds: [],
    ...over,
  };
}

describe("classify", () => {
  test("open PR from a completed run is ready to merge", () => {
    expect(classify({ status: "complete", prState: "draft", prUrl: "u" })).toBe("ready");
  });
  test("merged PR counts as shipped", () => {
    expect(classify({ status: "complete", prState: "merged", prUrl: "u" })).toBe("shipped");
  });
  test("a reviewer who wants a closer look sends it to needs eyes", () => {
    expect(classify({ status: "complete", prState: "draft", prUrl: "u", verdict: "needs_eyes" })).toBe("eyes");
    expect(classify({ status: "complete", prState: "draft", prUrl: "u", verdict: "ready" })).toBe("ready");
  });
  test("a ready task on the nightly train is ready to merge", () => {
    expect(classify({ status: "complete", prState: null, prUrl: null, verdict: "ready", onTrain: true })).toBe("ready");
  });
  test("a finished research task is shipped", () => {
    expect(classify({ status: "complete", prState: null, prUrl: null, type: "research" })).toBe("shipped");
  });
  test("completed without a PR needs eyes", () => {
    expect(classify({ status: "complete", prState: null, prUrl: null })).toBe("eyes");
  });
  test("failed, timeout and blocked are failed", () => {
    for (const status of ["failed", "timeout", "blocked"] as const) {
      expect(classify({ status, prState: null, prUrl: null })).toBe("failed");
    }
  });
  test("triage wins over run status", () => {
    expect(classify({ status: "failed", prState: null, prUrl: null, triage: "tonight" })).toBe("back");
    expect(classify({ status: "complete", prState: "merged", prUrl: "u", triage: "send_back" })).toBe("back");
    expect(classify({ status: "complete", prState: "open", prUrl: "u", triage: "close" })).toBe("failed");
  });
});

describe("nightIdFor", () => {
  test("evening and the following morning share a report day", () => {
    expect(nightIdFor("2026-04-16T22:30:00Z", 0)).toBe("2026-04-16");
    expect(nightIdFor("2026-04-17T06:10:00Z", 0)).toBe("2026-04-16");
  });
  test("cutoff is 18:00 local", () => {
    expect(nightIdFor("2026-04-17T17:59:00Z", 0)).toBe("2026-04-16");
    expect(nightIdFor("2026-04-17T18:00:00Z", 0)).toBe("2026-04-17");
  });
  test("respects the timezone offset", () => {
    // 02:00 UTC is 19:00 the previous day in UTC-7 (offset +420)
    expect(nightIdFor("2026-04-17T02:00:00Z", 420)).toBe("2026-04-16");
    // ...but 00:30 UTC is 17:30, still the day before's report
    expect(nightIdFor("2026-04-17T00:30:00Z", 420)).toBe("2026-04-15");
  });
});

describe("horizon", () => {
  test("overnight runs use the 22:00 → 07:00 window", () => {
    const start = new Date("2026-04-16T23:00:00").toISOString();
    const end = new Date("2026-04-17T03:00:00").toISOString();
    const w = horizonWindow([{ startedAt: start, endedAt: end }], "2026-04-16");
    expect(w.start.getHours()).toBe(22);
    expect(w.end.getHours()).toBe(7);
    expect(horizonPosition(start, w)).toBeCloseTo((1 / 9) * 100, 5);
  });
  test("daytime runs stretch the window to whole hours around them", () => {
    const start = new Date("2026-04-17T11:15:00").toISOString();
    const end = new Date("2026-04-17T14:31:00").toISOString();
    const w = horizonWindow([{ startedAt: start, endedAt: end }], "2026-04-16");
    expect(w.start.getHours()).toBe(11);
    expect(w.end.getHours()).toBe(15);
  });
  test("position is clamped", () => {
    const w = { start: new Date("2026-04-16T22:00:00Z"), end: new Date("2026-04-17T07:00:00Z") };
    expect(horizonPosition("2026-04-16T20:00:00Z", w)).toBe(0);
    expect(horizonPosition("2026-04-17T09:00:00Z", w)).toBe(100);
  });
});

describe("summary and greeting", () => {
  test("counts buckets, PRs and cost", () => {
    const s = summarize([
      run({ bucket: "shipped", prUrl: "a", costCents: 100 }),
      run({ bucket: "ready", prUrl: "b", costCents: 50 }),
      run({ bucket: "failed", costCents: 10 }),
    ]);
    expect(s.byBucket.shipped).toBe(1);
    expect(s.prs).toBe(2);
    expect(s.costCents).toBe(160);
  });
  test("greeting reads like a sentence", () => {
    const morning = new Date("2026-04-17T07:30:00");
    const s = summarize([
      run({ bucket: "shipped" }),
      run({ bucket: "shipped" }),
      run({ bucket: "ready" }),
      run({ bucket: "eyes" }),
    ]);
    expect(greeting(s, morning)).toBe("Good morning. Two shipped and two need you.");
    expect(greeting(summarize([run({ bucket: "failed" })]), morning)).toBe("Good morning. One failed.");
    expect(greeting(summarize([]), morning)).toBe("Good morning. Nothing ran this night.");
  });
});
