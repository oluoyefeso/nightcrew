#!/usr/bin/env bun
// nightcrew: the local dashboard, the overnight scheduler and a few commands.

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
  ManagedEngine,
  reflexesFromEnv,
  SdkEngine,
} from "@nightcrew/runner";
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
  --engine managed    Run tasks on Claude Managed Agents (needs ANTHROPIC_API_KEY; experimental)
  --no-publish        Keep branches local: don't push or open PRs
  --classic <dir>     Classic NightCrew directory (default: auto-detect)
  --data <dir>        Where NightCrew keeps its data (default ~/.nightcrew)
  --offline           Skip GitHub lookups during import
`;

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    port: { type: "string", default: process.env.NIGHTCREW_PORT ?? "3721" },
    "no-open": { type: "boolean", default: false },
    repo: { type: "string" },
    later: { type: "boolean", default: false },
    schedule: { type: "boolean", default: false },
    demo: { type: "boolean", default: process.env.NIGHTCREW_DEMO === "1" },
    engine: { type: "string", default: process.env.NIGHTCREW_ENGINE ?? "local" },
    "no-publish": { type: "boolean", default: false },
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
const engine: AgentEngine = values.demo
  ? new DemoEngine(Number(process.env.NIGHTCREW_DEMO_STEP_MS) || 900)
  : values.engine === "managed"
    ? managedEngine()
    : new SdkEngine({ claudePath: claudeOnPath() });

/** Claude Managed Agents: tasks run in Anthropic's cloud sandboxes. Needs an API key and a GitHub remote. */
function managedEngine(): AgentEngine {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("The managed engine needs ANTHROPIC_API_KEY (with Managed Agents enabled on your Anthropic org).");
    process.exit(1);
  }
  return new ManagedEngine({
    apiKey: process.env.ANTHROPIC_API_KEY,
    githubToken: async () => {
      const proc = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "ignore" });
      const token = (await new Response(proc.stdout).text()).trim();
      if (!token) throw new Error("No GitHub token: run gh auth login.");
      return token;
    },
  });
}
const publish = !values["no-publish"] && !values.demo;
const reflexes = reflexesFromEnv();
const crew = new Crew({ db, engine, dataDir: values.data, publish, reflexes });

// Reports that need a person go to Slack, if you've set a webhook.
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
  if (!import.meta.path.startsWith("/$bunfs") && !import.meta.path.includes("~BUN")) return undefined;
  return Bun.which("claude") ?? undefined;
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
  const port = Number(values.port);
  const webDir = resolve(import.meta.dir, "../../web/dist");
  const app = createApp({ db, cwd, classicRoot, webDir, crew, engine, dataDir: values.data, publish });
  const server = Bun.serve({ port, hostname: "127.0.0.1", fetch: app.fetch, idleTimeout: 0 });
  const url = `http://localhost:${server.port}`;
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
    const queued = listTasks(db, ["queued"]);
    if (!queued.length) {
      console.log("  The queue is empty.");
      break;
    }
    const st = getSettings(db);
    console.log(
      `  ${queued.length} task${queued.length === 1 ? "" : "s"} queued · up to ${st.maxAgents} agents at once (${engine.name}). Ctrl-C stops them.\n`,
    );
    process.on("SIGINT", () => crew.stopAll());
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
    const end = crew.getStatus();
    console.log(`\n  ${end.message ?? "All agents are done."} Tokens today: ${formatTokens(end.tokensToday)}.`);
    break;
  }

  default:
    console.error(`Unknown command "${command}".\n`);
    console.log(HELP);
    process.exit(1);
}
