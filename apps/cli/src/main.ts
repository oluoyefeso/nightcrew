#!/usr/bin/env bun
// nightcrew: runs the local dashboard and (from M1) the overnight scheduler.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { openDb } from "@nightcrew/db";
import { createApp, VERSION } from "./server";
import { syncClassic } from "./sync";

const HELP = `nightcrew ${VERSION}

Usage
  nightcrew                 Open the dashboard (imports classic history first)
  nightcrew serve           Start the dashboard server
  nightcrew import          Import classic runs and refresh PR state
  nightcrew --version

Options
  --port <n>                Dashboard port (default 3721)
  --no-open                 Don't open a browser window
  --classic <dir>           Classic NightCrew directory (default: auto-detect)
  --data <dir>              Where NightCrew keeps its database (default ~/.nightcrew)
  --offline                 Skip GitHub lookups
`;

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    port: { type: "string", default: process.env.NIGHTCREW_PORT ?? "3721" },
    "no-open": { type: "boolean", default: false },
    classic: { type: "string" },
    data: { type: "string", default: process.env.NIGHTCREW_HOME ?? join(homedir(), ".nightcrew") },
    offline: { type: "boolean", default: false },
    dev: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
    version: { type: "boolean", short: "v", default: false },
  },
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}
if (values.version) {
  console.log(VERSION);
  process.exit(0);
}

const command = positionals[0] ?? "up";
const cwd = process.cwd();
mkdirSync(values.data, { recursive: true });
const db = openDb(join(values.data, "nightcrew.db"));
const classicRoot = values.classic ? resolve(values.classic) : undefined;

async function sync() {
  const r = await syncClassic(db, { root: classicRoot, cwd, github: !values.offline });
  if (r.root) {
    console.log(
      `  Imported ${r.runs} classic runs from ${r.root}${r.prsChecked ? `, checked ${r.prsChecked} PRs` : ""}.`,
    );
  }
  return r;
}

async function serve() {
  const port = Number(values.port);
  const webDir = resolve(import.meta.dir, "../../web/dist");
  const app = createApp({ db, cwd, classicRoot, webDir });
  const server = Bun.serve({ port, hostname: "127.0.0.1", fetch: app.fetch });
  const url = `http://localhost:${server.port}`;
  console.log(`\n  NightCrew is running at ${url}\n`);
  if (!values["no-open"] && !values.dev) openBrowser(url);
}

function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    Bun.spawn([cmd, url], { stdout: "ignore", stderr: "ignore" });
  } catch {}
}

switch (command) {
  case "up":
    await sync();
    await serve();
    break;
  case "serve":
    if (values.dev) await sync();
    await serve();
    break;
  case "import": {
    const r = await sync();
    if (!r.root) {
      console.error(
        "No classic NightCrew history found. Pass --classic <dir> pointing at a folder with state/sessions.",
      );
      process.exit(1);
    }
    break;
  }
  default:
    console.error(`Unknown command "${command}".\n`);
    console.log(HELP);
    process.exit(1);
}
