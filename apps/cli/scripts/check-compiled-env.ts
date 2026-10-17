// Run against a compiled release binary. Source-mode tests cannot catch Bun's
// executable-level dotenv autoloading, which happens before main.ts starts.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const binary = resolve(process.argv[2] ?? "apps/cli/dist/nightcrew");
const root = mkdtempSync(join(tmpdir(), "nc-compiled-env-"));
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) =>
      value !== undefined &&
      !/^(NIGHTCREW|ANTHROPIC|CLAUDE)_/.test(key) &&
      !/TOKEN|SECRET|PASSWORD|API_?KEY|CREDENTIAL|WEBHOOK/i.test(key),
  ),
);
function run(name: string, ...args: string[]) {
  return Bun.spawnSync([binary, "repo", "--demo", "--data", join(root, name), ...args], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
}
try {
  writeFileSync(join(root, ".env.local"), "NIGHTCREW_ENGINE=unselected-fixture\n");
  const explicit = join(root, "selected.env");
  writeFileSync(explicit, "NIGHTCREW_ENGINE=managed\n", { mode: 0o600 });

  assert.equal(run("unselected").exitCode, 0, "An unselected dotenv file must not alter startup.");
  assert(existsSync(join(root, "unselected", "nightcrew.db")));

  const selected = run("selected", "--env-file", explicit);
  assert.equal(selected.exitCode, 1);
  assert(new TextDecoder().decode(selected.stderr).includes("Managed mode is coming soon"));
  assert(!existsSync(join(root, "selected")), "The explicit engine setting must apply before creating data.");

  assert.equal(run("override", "--env-file", explicit, "--engine", "local").exitCode, 0);
  assert(existsSync(join(root, "override", "nightcrew.db")));
  console.log("Compiled env checks passed: explicit file selection and CLI precedence.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
