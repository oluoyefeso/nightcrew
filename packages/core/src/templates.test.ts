import { expect, test } from "bun:test";
import { DEFAULT_TASK_POLICY, resolvePolicy } from "./policy";
import { portableTemplate, validatePortableTemplate } from "./templates";

test("portable templates round-trip only names and rules, with authority still bounded by the target repository", () => {
  const template = portableTemplate("  Reviewed changes  ", {
    implementation: { ...DEFAULT_TASK_POLICY, autonomy: "ship", requireTests: true, reviewers: 2 },
  });
  const imported = JSON.parse(JSON.stringify(template));
  expect(validatePortableTemplate(imported)).toBeNull();
  expect(imported.name).toBe("Reviewed changes");
  expect(Object.keys(imported).sort()).toEqual(["format", "name", "policies", "version"]);
  expect(resolvePolicy({ level: "draft_pr", policies: imported.policies }, "implementation").authority).toBe(
    "draft_pr",
  );
  expect(validatePortableTemplate({ ...imported, path: "/private/project" })).toContain("only");
  expect(validatePortableTemplate({ ...imported, version: 2 })).toContain("not supported");
  expect(
    validatePortableTemplate({
      ...imported,
      policies: { implementation: { ...DEFAULT_TASK_POLICY, command: "false" } },
    }),
  ).not.toBeNull();
  expect(
    validatePortableTemplate({ ...imported, policies: { implementation: { ...DEFAULT_TASK_POLICY, reviewers: 4 } } }),
  ).not.toBeNull();
});
