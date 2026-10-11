import { expect, test } from "bun:test";
import { interventionFor } from "./intervention";
import type { Artifact, Run } from "./model";

const run: Run = {
  id: "run",
  nightId: "2026-10-11",
  taskId: "task",
  title: "Feature",
  repo: "Demo",
  type: "implementation",
  status: "complete",
  bucket: "eyes",
  source: "local",
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
  verdict: "needs_eyes",
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
};
const artifact = (kind: Artifact["kind"], content = "Example"): Artifact => ({ kind, content, name: kind });

test("decision briefs route failures and incomplete proof to the evidence actually available", () => {
  const failed = interventionFor({ ...run, status: "failed", bucket: "failed", reason: "Checks failed" }, [
    artifact("tests"),
    artifact("plan"),
  ]);
  expect(failed.title).toBe("Recover this run");
  expect(failed.reason).toBe("Checks failed");
  expect(failed.inspect).toEqual(["tests", "plan"]);
  const proof = interventionFor(run, [
    artifact("evidence", JSON.stringify({ missing: ["No before screenshot", 123] })),
    artifact("policy"),
  ]);
  expect(proof.title).toBe("Complete the evidence");
  expect(proof.missing).toEqual(["No before screenshot"]);
  expect(proof.inspect).toEqual(["evidence", "policy"]);
});

test("plans and research get specific next steps; corrupt legacy evidence stays inspectable", () => {
  expect(interventionFor(run, [artifact("plan")]).title).toBe("Review the plan");
  expect(interventionFor({ ...run, type: "research" }, [artifact("report")]).title).toBe("Review the research");
  const old = interventionFor(run, [artifact("evidence", "legacy text")]);
  expect(old.missing).toEqual([]);
  expect(old.inspect).toEqual(["evidence"]);
  expect(
    interventionFor({ ...run, prUrl: "https://example.test/pr/1" }, [artifact("plan"), artifact("tests")]).title,
  ).not.toBe("Review the plan");
});
