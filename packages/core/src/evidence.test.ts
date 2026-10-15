import { expect, test } from "bun:test";
import { type Evidence, parseEvidence } from "./evidence";

const evidence: Evidence = {
  required: ["Screenshots"],
  screenshots: [
    {
      path: "/",
      viewport: "desktop",
      theme: "light",
      before: null,
      after: "shots/after.png",
      diff: null,
      changedPct: null,
    },
  ],
  a11y: { before: null, after: 0, newIssues: [] },
  consoleErrors: [],
  testProof: {
    testFiles: ["example.test.ts"],
    failsOnBase: null,
    passesOnBranch: true,
    log: "Base check unavailable.",
    unavailable: "Runner could not start.",
  },
  missing: ["Regression proof"],
  notes: [],
};

test("valid evidence retains unknown, missing and failed observations", () => {
  expect(parseEvidence(JSON.stringify(evidence))).toEqual(evidence);
  const older = { ...evidence, screenshots: [], a11y: null, testProof: null };
  expect(parseEvidence(JSON.stringify(older))).toEqual(older);
});

test("malformed shapes and incomplete checks cannot enter the evidence view", () => {
  for (const value of [
    null,
    [],
    {},
    true,
    "text",
    { ...evidence, required: null },
    { ...evidence, notes: [false] },
    { ...evidence, screenshots: [{}] },
    { ...evidence, screenshots: [{ ...evidence.screenshots[0], after: "../other.png" }] },
    { ...evidence, screenshots: [{ ...evidence.screenshots[0], changedPct: -1 }] },
    { ...evidence, screenshots: [{ ...evidence.screenshots[0], viewport: "unknown" }] },
    { ...evidence, testProof: { ...evidence.testProof, passesOnBranch: "true" } },
    { ...evidence, testProof: { ...evidence.testProof, testFiles: null } },
    { ...evidence, a11y: { before: null, after: 0, newIssues: [{}] } },
    { ...evidence, a11y: { before: null, after: -1, newIssues: [] } },
    { ...evidence, missing: undefined },
  ])
    expect(parseEvidence(JSON.stringify(value))).toBeNull();
  expect(parseEvidence("{unfinished")).toBeNull();
});
