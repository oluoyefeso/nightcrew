import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFile } from "./env-file";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(content: string | Uint8Array) {
  const root = mkdtempSync(join(tmpdir(), "nc-env-file-"));
  roots.push(root);
  const path = join(root, "private.env");
  writeFileSync(path, content, { mode: 0o600 });
  return { root, path };
}

test("loads quoted credentials and comments while preserving exported values", () => {
  const { path } = fixture(
    '# Synthetic values only\nOPENROUTER_API_KEY="fixture-key"\nEXISTING=replacement\nDISABLED=replacement\n',
  );
  const env: NodeJS.ProcessEnv = { EXISTING: "exported", DISABLED: "" };
  loadEnvFile(path, env);
  expect(env).toEqual({ OPENROUTER_API_KEY: "fixture-key", EXISTING: "exported", DISABLED: "" });
});

test("never executes shell syntax or expands other environment values", () => {
  const { root, path } = fixture("");
  const marker = join(root, "must-not-exist");
  writeFileSync(path, `MODEL_API_KEY=$(touch ${marker})\nSECOND_KEY=$MODEL_API_KEY\n`);
  const env: NodeJS.ProcessEnv = {};
  loadEnvFile(path, env);
  expect(existsSync(marker)).toBe(false);
  expect(env.MODEL_API_KEY).toBe(`$(touch ${marker})`);
  expect(env.SECOND_KEY).toBe("$MODEL_API_KEY");
});

test("rejects oversized, non-file, symlink and invalid UTF-8 inputs without exposing contents or paths", () => {
  const { root, path } = fixture("SYNTHETIC_SECRET=not-for-errors\n");
  const large = join(root, "large.env");
  writeFileSync(large, `X=${"x".repeat(65536)}`);
  const dir = join(root, "folder");
  mkdirSync(dir);
  const link = join(root, "link.env");
  symlinkSync(path, link);
  const invalid = join(root, "invalid.env");
  writeFileSync(invalid, new Uint8Array([0xff]));
  for (const input of [large, dir, link, invalid, join(root, "missing.env")]) {
    const env: NodeJS.ProcessEnv = {};
    let message = "";
    try {
      loadEnvFile(input, env);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("Could not load the environment file");
    expect(message).not.toContain(root);
    expect(message).not.toContain("not-for-errors");
    expect(env).toEqual({});
  }
});

test("validates the full file before changing the environment", () => {
  const { path } = fixture("GOOD_API_KEY=synthetic\nlowercase=invalid\n");
  const env: NodeJS.ProcessEnv = {};
  expect(() => loadEnvFile(path, env)).toThrow("Could not load");
  expect(env).toEqual({});
});
