#!/usr/bin/env bun
// nightcrew: the local dashboard, the overnight scheduler and a few commands.

import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { formatTokens, nextStart } from "@nightcrew/core";
import { addRepo, createTask, getRepoByPath, getSettings, listRepos, listTasks, openDb } from "@nightcrew/db";
import {
  type AgentEngine,
  Crew,
  DemoEngine,
  detectPreview,
  detectSetupCommand,
  detectTestCommand,
  draftTasks,
  inspectRepo,
  RoutedEngine,
  reflexesFromEnv,
  repoSupport,
  SdkEngine,
  setLandingHome,
  takeCrewLock,
} from "@nightcrew/runner";
import { loadEnvFile } from "./env-file";
import { createApp, VERSION } from "./server";
import { syncClassic } from "./sync";

const HELP = `nightcrew ${VERSION}

Usage
  nightcrew                     Open the dashboard; agents pick up work around the clock
  nightcrew add "<request>"     Draft tasks from a sentence and dispatch them
  nightcrew repo add [path]     Let the crew work in a repo (default: current folder)
  nightcrew run                 Run the queue in this terminal until it's empty
  nightcrew import              Import classic runs and refresh PR state

Options
  --port <n>          Dashboard port (default 3721)
  --no-open           Don't open a browser window
  --repo <path>       Repo for \`add\` (default: current folder if it's a known repo)
  --later             With \`add\`: park the tasks in Later
  --schedule          With \`add\`: hold the tasks until the schedule time (Settings, default 22:00)
  --demo              Use a pretend crew that spends nothing (for trying things out)
  --engine local      Run agents on your machine (default; managed mode is coming soon)
  --no-publish        Keep branches local: don't push or open PRs
  --classic <dir>     Classic NightCrew directory (default: auto-detect)
  --data <dir>        Where NightCrew keeps its data (default ~/.nightcrew)
  --env-file <file>   Load a private environment file; exported variables take precedence
  --offline           Skip GitHub lookups during import
`;

const { values: args, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    port: { type: "string" },
    "no-open": { type: "boolean", default: false },
    repo: { type: "string" },
    later: { type: "boolean", default: false },
    schedule: { type: "boolean", default: false },
    demo: { type: "boolean" },
    engine: { type: "string" },
    "no-publish": { type: "boolean", default: false },
    classic: { type: "string" },
    data: { type: "string" },
    "env-file": { type: "string" },
    offline: { type: "boolean", default: false },
    dev: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
    version: { type: "boolean", short: "v", default: false },
  },
});

if (args.help) {
  console.log(HELP);
  process.exit(0);
}
if (args.version) {
  console.log(VERSION);
  process.exit(0);
}

if (args["env-file"]) {
  try {
    loadEnvFile(resolve(args["env-file"]));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
const values = {
  ...args,
  port: args.port ?? process.env.NIGHTCREW_PORT ?? "3721",
  demo: args.demo ?? process.env.NIGHTCREW_DEMO === "1",
  engine: args.engine ?? process.env.NIGHTCREW_ENGINE ?? "local",
  // Downstream git commands change cwd; resolve paths from the launch directory.
  data: resolve(args.data ?? process.env.NIGHTCREW_HOME ?? join(homedir(), ".nightcrew")),
};

const command = positionals[0] ?? "up";
const cwd = process.cwd();
const compiled = import.meta.path.startsWith("/$bunfs") || import.meta.path.includes("~BUN");
if (values.engine !== "local") {
  console.error(
    values.engine === "managed"
      ? "Managed mode is coming soon. Run nightcrew --engine local to use the open-source crew on your machine."
      : "Unknown engine. Use --engine local, or --demo to try NightCrew without running agents.",
  );
  process.exit(1);
}
mkdirSync(values.data, { recursive: true });
setLandingHome(values.data);
const db = openDb(join(values.data, "nightcrew.db"));
const classicRoot = values.classic ? resolve(values.classic) : undefined;
const engine: AgentEngine = values.demo
  ? new DemoEngine(Number(process.env.NIGHTCREW_DEMO_STEP_MS) || 900)
  : new RoutedEngine(db, new SdkEngine({ claudePath: claudeOnPath() }));
const publish = !values["no-publish"] && !values.demo;
const reflexes = reflexesFromEnv();
const crew = new Crew({ db, engine, dataDir: values.data, publish, reflexes });

// Every report goes to Slack, if you've set a webhook: agents report there when they finish or need you.
crew.subscribe((e) => {
  if (e.type !== "report") return;
  const hook = getSettings(db).slackWebhookUrl;
  if (!hook) return;
  const o = e.outcome;
  const text =
    o.status === "complete"
      ? `NightCrew finished "${o.title}"${o.prUrl ? `: ${o.prUrl}` : ""} (${formatTokens(o.tokens)} tokens)`
      : `NightCrew needs you: "${o.title}" stopped. ${o.reason ?? ""}`;
  void fetch(hook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  }).catch(() => {});
});

/** In the compiled binary the SDK can't find its bundled CLI, so use Claude Code from PATH. */
function claudeOnPath(): string | undefined {
  if (!compiled) return undefined;
  return Bun.which("claude") ?? "";
}

/**
 * Become the one process that dispatches the queue, then requeue whatever a
 * crash left running. Exits if another live process already dispatches.
 */
function takeQueue(busy: (pid: number) => string): () => void {
  const lock = takeCrewLock(values.data);
  if (!lock.ok) {
    console.error(`${busy(lock.pid)} If that's wrong, delete ${lock.file}.`);
    process.exit(1);
  }
  process.on("exit", lock.release);
  const recovered = crew.recover();
  if (recovered)
    console.log(`  Put ${recovered} task${recovered === 1 ? "" : "s"} left running by a crash back in the queue.`);
  return lock.release;
}

/**
 * Ctrl-C or SIGTERM stops the agents, lets them save their work and puts
 * their tasks back in the queue; a second signal (or 20s) quits at once.
 */
function quitOnSignals(release: () => void) {
  let stopping = false;
  const stopOn = (signal: "SIGINT" | "SIGTERM", code: number) => {
    const quit = () => {
      release();
      process.exit(code);
    };
    process.on(signal, () => {
      if (stopping) quit();
      stopping = true;
      crew.shutdown();
      console.log(
        `\n  Stopping local work and saving its outcome...${signal === "SIGINT" ? " press Ctrl-C again to quit now." : ""}`,
      );
      void crew.drain().then(quit);
      setTimeout(quit, 20_000).unref();
    });
  };
  stopOn("SIGINT", 130);
  stopOn("SIGTERM", 143);
}

async function sync() {
  const r = await syncClassic(db, { root: classicRoot, cwd, github: !values.offline });
  if (r.root)
    console.log(
      `  Imported ${r.runs} classic runs from ${r.root}${r.prsChecked ? `, checked ${r.prsChecked} PRs` : ""}.`,
    );
  return r;
}

async function serve() {
  const release = takeQueue(
    (pid) => `Another NightCrew is already running the queue (pid ${pid}). Use its dashboard, or stop it first.`,
  );
  quitOnSignals(release);
  const port = Number(values.port);
  const webDir = resolve(import.meta.dir, "../../web/dist");
  // A fresh key per launch: only the link printed below opens the dashboard and
  // its API. It lives in memory only. Development (the Vite server) goes without.
  const token = values.dev || process.env.NIGHTCREW_DEV === "1" ? undefined : randomBytes(32).toString("hex");
  const app = createApp({ db, cwd, classicRoot, webDir, crew, engine, dataDir: values.data, publish, token });
  const server = Bun.serve({ port, hostname: "127.0.0.1", fetch: app.fetch, idleTimeout: 0 });
  // Agent sandboxes read this to deny loopback access to the dashboard's own port.
  process.env.NIGHTCREW_API_PORT = String(server.port);
  const url = `http://localhost:${server.port}/${token ? `?t=${token}` : ""}`;
  crew.startSchedule();
  const s = getSettings(db);
  console.log(`\n  NightCrew is running at ${url}`);
  console.log(
    `  Agents: up to ${s.maxAgents} at once (${s.maxPerRepo} per repo) · ${formatTokens(s.dailyTokenBudget)} tokens a day · ${engine.name}${publish ? "" : ", branches stay local"} · reflexes: ${reflexes.name}${s.dispatch ? "" : " · dispatch paused"}\n`,
  );
  if (!values["no-open"] && !values.dev) openBrowser(url);
}

function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    Bun.spawn([cmd, url], { stdout: "ignore", stderr: "ignore" });
  } catch {}
}

async function repoFor(path: string | undefined) {
  const info = await inspectRepo(path ?? cwd);
  const unsupported = await repoSupport(info.path);
  if (unsupported) {
    console.error(`  ${unsupported}`);
    process.exit(1);
  }
  const preview = detectPreview(info.path);
  return (
    getRepoByPath(db, info.path) ??
    addRepo(db, {
      name: info.name,
      path: info.path,
      defaultBranch: info.defaultBranch,
      testCommand: detectTestCommand(info.path),
      setupCommand: detectSetupCommand(info.path),
      previewCommand: preview?.command ?? null,
      previewUrl: preview?.url ?? null,
    })
  );
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

  case "repo": {
    if (positionals[1] !== "add") {
      for (const r of listRepos(db)) console.log(`  ${r.name.padEnd(24)} ${r.path}`);
      if (!listRepos(db).length) console.log('  No repos yet. Add one with "nightcrew repo add <path>".');
      break;
    }
    const repo = await repoFor(positionals[2]);
    console.log(`  Added ${repo.name} (${repo.path})`);
    console.log(`    default branch  ${repo.defaultBranch}`);
    console.log(`    tests           ${repo.testCommand ?? "none found (set one in Settings)"}`);
    console.log(`    install         ${repo.setupCommand ?? "none"}`);
    console.log(`    preview         ${repo.previewCommand ?? "none (UI tasks won't get screenshots)"}`);
    break;
  }

  case "add": {
    const text = positionals.slice(1).join(" ").trim();
    if (!text) {
      console.error('Describe the work: nightcrew add "fix the flaky login test"');
      process.exit(1);
    }
    // Never register a repo as a side effect: use --repo, the current folder if
    // it's already known, or the only repo there is.
    const repos = listRepos(db);
    const here = await inspectRepo(values.repo ?? cwd).catch(() => null);
    const repo = (here && getRepoByPath(db, here.path)) ?? (values.repo ? null : repos.length === 1 ? repos[0] : null);
    if (!repo) {
      console.error(
        repos.length === 0
          ? "Add a repo first: nightcrew repo add <path>"
          : values.repo
            ? `${values.repo} isn't a repo the crew knows. Add it with: nightcrew repo add ${values.repo}`
            : `Which repo? Run this inside one of: ${repos.map((r) => r.name).join(", ")}, or pass --repo <path>.`,
      );
      process.exit(1);
    }
    console.log("  Drafting…");
    const { drafts, fallback } = await draftTasks(engine, {
      text,
      repos: listRepos(db),
      defaultRepoId: repo.id,
      model: getSettings(db).buildModel,
    });
    const ids: string[] = [];
    for (const d of drafts) {
      const t = createTask(db, {
        repoId: d.repoId,
        title: d.title,
        type: d.type,
        brief: d.brief,
        scope: d.scope,
        criteria: d.criteria,
        question: d.question,
        dependsOn: d.dependsOn.map((i) => ids[i]).filter((x): x is string => Boolean(x)),
        status: d.question ? "draft" : values.later ? "later" : "queued",
        runAt: values.schedule ? nextStart(getSettings(db).scheduleAt).toISOString() : null,
        source: "cli",
      });
      ids.push(t.id);
      console.log(
        `  ${t.status === "draft" ? "?" : "+"} ${t.title}  [${t.repoName} · ${t.type}]${d.question ? `\n    Needs an answer: ${d.question}` : ""}`,
      );
    }
    if (fallback)
      console.log("  (Couldn't reach Claude to shape this, so it's saved as one task. Edit it in the dashboard.)");
    if (!values.later)
      console.log(
        values.schedule
          ? `  Scheduled for ${getSettings(db).scheduleAt}.`
          : "  Queued. The running dashboard's agents pick it up as soon as a slot is free (or run: nightcrew run).",
      );
    break;
  }

  case "run": {
    const release = takeQueue(
      (pid) => `The dashboard is already running the queue (pid ${pid}). Add work there, or stop it first.`,
    );
    const queued = listTasks(db, ["queued"]);
    if (!queued.length) {
      console.log("  The queue is empty.");
      release();
      break;
    }
    const st = getSettings(db);
    console.log(
      `  ${queued.length} task${queued.length === 1 ? "" : "s"} queued · up to ${st.maxAgents} agents at once (${engine.name}). Ctrl-C stops them.\n`,
    );
    quitOnSignals(release);
    const titles = new Map<string, string>();
    crew.subscribe((e) => {
      if (e.type === "status") for (const a of e.status.active) if (a.runId) titles.set(a.runId, a.title);
      if (e.type === "report") {
        const o = e.outcome;
        console.log(
          `  ${o.status === "complete" ? "✓" : "!"} [${o.title}] ${o.status === "complete" ? "finished" : o.reason} · ${formatTokens(o.tokens)} tokens${o.prUrl ? ` · ${o.prUrl}` : ""}`,
        );
      }
      if (e.type === "run_event") {
        const ev = e.event;
        const who = (titles.get(ev.runId) ?? "").slice(0, 28);
        const mark =
          ev.kind === "phase"
            ? "▸"
            : ev.kind === "denied"
              ? "✕"
              : ev.kind === "error"
                ? "!"
                : ev.kind === "result"
                  ? "✓"
                  : " ";
        if (ev.kind === "text" || ev.kind === "result") return;
        console.log(
          `  ${mark} ${who ? `[${who}] ` : ""}${ev.kind === "phase" ? ev.text : `  ${ev.text}`}`.slice(0, 200),
        );
      }
    });
    await crew.drain();
    release();
    const end = crew.getStatus();
    console.log(`\n  ${end.message ?? "All agents are done."} Tokens today: ${formatTokens(end.tokensToday)}.`);
    break;
  }

  default:
    console.error(`Unknown command "${command}".\n`);
    console.log(HELP);
    process.exit(1);
}
