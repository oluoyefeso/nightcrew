import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { parseEnv } from "node:util";

const LIMIT = 64 * 1024;

/** Explicit opt-in only. Parse data, never source it as shell code or echo it. */
export function loadEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > LIMIT) throw new Error();
    const bytes = Buffer.alloc(LIMIT + 1);
    let size = 0;
    for (;;) {
      const n = readSync(fd, bytes, size, bytes.length - size, null);
      size += n;
      if (size > LIMIT) throw new Error();
      if (n === 0) break;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
    const values = parseEnv(text);
    if (Object.keys(values).some((key) => !/^[A-Z_][A-Z0-9_]{0,99}$/.test(key))) throw new Error();
    // An exported value takes precedence, including an intentionally empty one.
    for (const [key, value] of Object.entries(values)) if (env[key] === undefined) env[key] = value;
  } catch {
    throw new Error(
      "Could not load the environment file. Use a readable regular UTF-8 file up to 64 KiB with uppercase variable names.",
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
