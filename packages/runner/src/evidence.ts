/// <reference path="./assets.d.ts" />
// Evidence NightCrew gathers itself, independent of what the agent claims:
// before/after screenshots with visual diffs, accessibility scans, console
// errors, and for bug fixes a test that fails on the base branch and passes
// on the fix.

import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, normalize } from "node:path";
import { policyEvidence, type Repo, type ResolvedPolicy, resolvePolicy, slugify, type Task } from "@nightcrew/core";
import { matchesAny } from "@nightcrew/core/guard";
import axeSource from "axe-core/axe.min.js" with { type: "text" };
import { baseWorktree, type Exec, lastLine, terminateTree, trackTree } from "./git";
import { checkEnv, runCheck, sandboxed } from "./sandbox";
import { cloneChangedFiles } from "./workspace";

interface A11yIssue {
  id: string;
  impact: string;
  help: string;
  count: number;
}

export interface Shot {
  path: string;
  viewport: "desktop" | "mobile";
  theme: "light" | "dark";
  before: string | null;
  after: string;
  diff: string | null;
  /** Share of pixels that changed, 0–100. Null without a before shot. */
  changedPct: number | null;
}

export interface Evidence {
  required: string[];
  screenshots: Shot[];
  a11y: { before: number | null; after: number; newIssues: A11yIssue[] } | null;
  consoleErrors: string[];
  testProof: {
    testFiles: string[];
    failsOnBase: boolean | null;
    passesOnBranch: boolean;
    log: string;
    /** Why the base run proves nothing either way (setup failed, the runner couldn't start, timed out). */
    unavailable?: string;
  } | null;
  /** What was asked for but couldn't be gathered, in plain words. */
  missing: string[];
  notes: string[];
}

export const TEST_FILE_GLOBS = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/test_*.py",
  "**/*_test.py",
  "**/*_test.go",
  "test/**",
  "tests/**",
  "__tests__/**",
  "spec/**",
];

const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } } as const;

export interface EvidenceOptions {
  task: Task;
  repo: Repo;
  /** The task's clone: the "after" side. The "before" side is a checkout of `base` in your repo. */
  worktree: string;
  /** The files the task changed, if already known (from validate). Otherwise the clone is asked. */
  files?: string[];
  /** The commit the task forked from. Defaults to the default branch. */
  base?: string;
  artifactsDir: string;
  /** Results of the branch's own test run, already done by validate(). */
  branchTestsPassed: boolean;
  log: (text: string) => void;
  signal: AbortSignal;
  policy?: ResolvedPolicy;
}

export async function gatherEvidence(o: EvidenceOptions): Promise<Evidence> {
  const policy = o.policy ?? resolvePolicy(o.repo, o.task.type);
  const ev: Evidence = {
    required: policyEvidence(policy),
    screenshots: [],
    a11y: null,
    consoleErrors: [],
    testProof: null,
    missing: [],
    notes: [],
  };
  const needsShots = policy.visual;
  const needsProof = policy.regression;
  if (policy.requireTests && !(o.task.testCommand ?? o.repo.testCommand)?.trim())
    ev.missing.push("The route requires a configured test command.");
  if (!needsShots && !needsProof) return ev;

  let base: Awaited<ReturnType<typeof baseWorktree>> | null = null;
  try {
    base = await baseWorktree(o.repo.path, o.base ?? o.repo.defaultBranch, `${o.task.id}`);
    let setupFailed: string | undefined;
    if (o.repo.setupCommand) {
      o.log(`Installing dependencies on ${o.repo.defaultBranch} for comparison`);
      const setup = await runCheck(o.repo.setupCommand, base.dir, {
        timeoutMs: 10 * 60_000,
        signal: o.signal,
        warn: o.log,
      });
      if (!setup.ok)
        setupFailed = `setup failed on ${o.repo.defaultBranch} (exit ${setup.code}): ${lastLine(setup.stderr) || lastLine(setup.stdout)}`;
    }
    if (needsProof) ev.testProof = await failThenPass(o, base.dir, setupFailed);
    if (needsShots) await screenshots(o, base.dir, ev);
  } catch (e) {
    ev.notes.push(`Evidence gathering hit a problem: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await base?.remove().catch(() => {});
  }

  if (needsProof) {
    if (!ev.testProof || ev.testProof.testFiles.length === 0) ev.missing.push("No new or changed test proves the fix.");
    else if (ev.testProof.failsOnBase === false)
      ev.missing.push("The new test also passes without the fix, so it doesn't prove anything.");
    else if (ev.testProof.failsOnBase === null)
      ev.missing.push(
        `Couldn't run the new test against the base branch${ev.testProof.unavailable ? `: ${ev.testProof.unavailable}` : "."}`,
      );
  }
  if (needsShots && ev.screenshots.length === 0) {
    ev.missing.push(
      o.repo.previewCommand
        ? "Screenshots couldn't be captured."
        : "No preview command is set for this repo, so there are no screenshots.",
    );
  }
  ev.missing = missingPolicyEvidence(policy, ev, Boolean((o.task.testCommand ?? o.repo.testCommand)?.trim()));
  writeFileSync(join(o.artifactsDir, "evidence.json"), JSON.stringify(ev, null, 2));
  return ev;
}

/** Evaluate the current route against evidence actually gathered, including rules tightened mid-run. */
export function missingPolicyEvidence(
  policy: ResolvedPolicy,
  evidence: Evidence | null,
  testsConfigured: boolean,
): string[] {
  const missing = [...(evidence?.missing ?? [])];
  if (policy.requireTests && !testsConfigured) missing.push("The route requires a configured test command.");
  if (policy.visual && !evidence?.screenshots.length)
    missing.push("The route requires visual evidence that was not collected.");
  if (policy.visual && evidence?.screenshots.length) {
    if (evidence.screenshots.some((shot) => !shot.before))
      missing.push("The visual route requires before and after screenshots.");
    if (!evidence.a11y) missing.push("The visual route requires an accessibility scan.");
  }
  if (policy.regression && (!evidence?.testProof?.failsOnBase || !evidence.testProof.passesOnBranch))
    missing.push("The route requires a test that fails on the base branch and passes on the change.");
  return [...new Set(missing)];
}

// ── Fail-then-pass ──────────────────────────────────────────────────────────

/**
 * Why a failed base run isn't a test failure, or null when it is one. Only a
 * runner that started and exited 1-125 counts: 126/127 (couldn't run), signals
 * (128+), timeouts and stops are the machinery failing, not the test.
 */
export function baseRunUnavailable(r: Exec): string | null {
  const last = lastLine(r.stderr);
  if (last === "Timed out." || last === "Stopped.")
    return `the test command ${last === "Stopped." ? "was stopped" : "timed out"}`;
  if (r.code === 126 || r.code === 127) return `the test command couldn't start (exit ${r.code})`;
  if (r.code < 1 || r.code > 125) return `the test command crashed or was killed (exit ${r.code})`;
  return null;
}

async function failThenPass(
  o: EvidenceOptions,
  baseDir: string,
  /** Why the base checkout's setup failed, if it did: a run there proves nothing. */
  setupFailed?: string,
): Promise<Evidence["testProof"]> {
  const cmd = o.task.testCommand ?? o.repo.testCommand;
  const changed =
    o.files ?? (await cloneChangedFiles(o.worktree, o.base ?? o.repo.defaultBranch, { signal: o.signal, warn: o.log }));
  // The clone's list is the agent's word: only plain files at plain relative paths get copied.
  const testFiles = changed.filter((f) => matchesAny(f, TEST_FILE_GLOBS) && plainFile(o.worktree, f));
  if (!cmd || testFiles.length === 0)
    return {
      testFiles,
      failsOnBase: null,
      passesOnBranch: o.branchTestsPassed,
      log: cmd ? "No test files changed." : "No test command.",
    };

  if (setupFailed)
    return {
      testFiles,
      failsOnBase: null,
      passesOnBranch: o.branchTestsPassed,
      log: `Not run: ${setupFailed}`,
      unavailable: setupFailed,
    };

  o.log(`Running the new tests against ${o.repo.defaultBranch}, where they should fail`);
  for (const f of testFiles) {
    const dest = join(baseDir, f);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(o.worktree, f), dest);
  }
  const r = await runCheck(cmd, baseDir, { timeoutMs: 15 * 60_000, signal: o.signal, warn: o.log });
  const out = `${r.stdout}\n${r.stderr}`.trim();
  const unavailable = r.ok ? null : baseRunUnavailable(r);
  return {
    testFiles,
    failsOnBase: r.ok ? false : unavailable ? null : true,
    passesOnBranch: o.branchTestsPassed,
    log: `$ ${cmd}  (on ${o.repo.defaultBranch} with the new tests, exit ${r.code})\n${out.slice(-4000)}`,
    ...(unavailable ? { unavailable } : {}),
  };
}

/** A regular file (not a link) at a relative path that stays inside `dir` and out of git's folders. */
function plainFile(dir: string, f: string): boolean {
  if (isAbsolute(f) || f.split("/").some((p) => p === ".." || p === ".git" || p === "")) return false;
  return lstatSync(join(dir, f), { throwIfNoEntry: false })?.isFile() ?? false;
}

// ── Screenshots ─────────────────────────────────────────────────────────────

interface Preview {
  url: string;
  stop: () => Promise<void>;
}

export async function startPreview(
  repo: Repo,
  dir: string,
  signal: AbortSignal,
  warn: (text: string) => void,
  /** `dir` is the task's clone, not a checkout NightCrew owns. */
  clone: boolean,
): Promise<Preview> {
  const port = await freePort();
  const url = (repo.previewUrl ?? "http://localhost:{port}").replace("{port}", String(port));
  if (!repo.previewCommand) throw new Error("No preview command.");

  if (repo.previewCommand === "static") {
    const server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch(req) {
        const path = normalize(decodeURIComponent(new URL(req.url).pathname)).replace(/^(\.\.[/\\])+/, "");
        let file = join(dir, path);
        if (path.endsWith("/") || !extname(path)) file = join(file, "index.html");
        return existsSync(file) ? new Response(Bun.file(file)) : new Response("Not found", { status: 404 });
      },
    });
    return { url, stop: async () => server.stop(true) };
  }

  const argv = sandboxed(repo.previewCommand, dir, warn, { clone });
  const proc = Bun.spawn(argv, {
    cwd: dir,
    env: checkEnv({ PORT: String(port), BROWSER: "none", CI: "1" }),
    stdout: "ignore",
    stderr: "ignore",
    // The app leads its own process group, so a stop reaches the servers it
    // starts. The sandboxed argv starts its own session; a plain `sh -c` doesn't.
    detached: argv[0] === "sh",
  });
  trackTree(proc);
  // A stop kills the app at once, not after the remaining screenshots.
  const kill = () => void terminateTree(proc);
  signal.addEventListener("abort", kill, { once: true });
  const stop = async () => {
    signal.removeEventListener("abort", kill);
    await terminateTree(proc);
  };
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && !signal.aborted) {
    if (proc.exitCode !== null) {
      await stop();
      throw new Error(`The preview command exited (${proc.exitCode}) before serving.`);
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.status < 500) return { url, stop };
    } catch {}
    await Bun.sleep(750);
  }
  await stop();
  throw new Error(`The preview didn't respond at ${url} within two minutes.`);
}

async function screenshots(o: EvidenceOptions, baseDir: string, ev: Evidence) {
  if (!o.repo.previewCommand) return;
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
  const axe = readAxe();
  const shotsDir = join(o.artifactsDir, "shots");
  mkdirSync(shotsDir, { recursive: true });
  const paths = o.repo.previewPaths.length ? o.repo.previewPaths.slice(0, 6) : ["/"];

  const capture = async (dir: string, label: "before" | "after") => {
    o.log(`Starting the app (${label === "before" ? o.repo.defaultBranch : "this branch"}) for screenshots`);
    const preview = await startPreview(o.repo, dir, o.signal, o.log, label === "after");
    const results: { key: string; file: string; a11y: Map<string, A11yIssue>; errors: string[] }[] = [];
    try {
      for (const path of paths) {
        for (const viewport of ["desktop", "mobile"] as const) {
          for (const theme of ["light", "dark"] as const) {
            const page = await browser.newPage({
              viewport: VIEWPORTS[viewport],
              colorScheme: theme,
              deviceScaleFactor: 1,
            });
            const errors: string[] = [];
            page.on("console", (m) => {
              // A missing favicon isn't something the task broke.
              if (m.type() === "error" && !/favicon\.ico/.test(m.location()?.url ?? ""))
                errors.push(m.text().slice(0, 300));
            });
            page.on("pageerror", (e) => errors.push(e.message.slice(0, 300)));
            await page
              .goto(new URL(path, preview.url).toString(), { waitUntil: "networkidle", timeout: 30_000 })
              .catch(() => {});
            await page
              .addStyleTag({
                content:
                  "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}",
              })
              .catch(() => {});
            await page.waitForTimeout(300);
            const key = `${slugify(path === "/" ? "home" : path, 30)}-${viewport}-${theme}`;
            const file = join(shotsDir, `${key}-${label}.png`);
            await page.screenshot({ path: file, fullPage: false });
            const a11y = new Map<string, A11yIssue>();
            if (axe && viewport === "desktop" && theme === "light") {
              try {
                await page.addScriptTag({ content: axe });
                const violations = (await page.evaluate(
                  "axe.run(document, { resultTypes: ['violations'] }).then(r => r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, count: v.nodes.length })))",
                )) as {
                  id: string;
                  impact: string;
                  help: string;
                  count: number;
                }[];
                for (const v of violations) a11y.set(v.id, v);
              } catch {}
            }
            results.push({ key, file, a11y, errors });
            await page.close();
          }
        }
      }
    } finally {
      await preview.stop();
    }
    return results;
  };

  try {
    const before = await capture(baseDir, "before").catch((e) => {
      ev.notes.push(`No before shots: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    });
    const after = await capture(o.worktree, "after");
    const beforeByKey = new Map(before.map((b) => [b.key, b]));
    let a11yBefore: Map<string, A11yIssue> | null = null;
    let a11yAfter = new Map<string, A11yIssue>();

    for (const a of after) {
      const b = beforeByKey.get(a.key);
      const [path, viewport, theme] = parseKey(a.key, paths);
      let diff: string | null = null;
      let changedPct: number | null = null;
      if (b) {
        const d = await diffImages(b.file, a.file, a.file.replace(/-after\.png$/, "-diff.png"));
        diff = d.file;
        changedPct = d.pct;
      }
      ev.screenshots.push({
        path,
        viewport,
        theme,
        before: b ? rel(o.artifactsDir, b.file) : null,
        after: rel(o.artifactsDir, a.file),
        diff: diff ? rel(o.artifactsDir, diff) : null,
        changedPct,
      });
      ev.consoleErrors.push(...a.errors);
      if (a.a11y.size || (viewport === "desktop" && theme === "light")) {
        a11yAfter = mergeA11y(a11yAfter, a.a11y);
        if (b) a11yBefore = mergeA11y(a11yBefore ?? new Map(), b.a11y);
      }
    }
    ev.consoleErrors = [...new Set(ev.consoleErrors)].slice(0, 20);
    if (axe) {
      const newIssues = [...a11yAfter.values()].filter((v) => {
        const prior = a11yBefore?.get(v.id);
        return !prior || v.count > prior.count;
      });
      ev.a11y = {
        before: a11yBefore ? sum(a11yBefore) : null,
        after: sum(a11yAfter),
        newIssues,
      };
    }
  } finally {
    await browser.close();
  }
}

function parseKey(key: string, paths: string[]): [string, "desktop" | "mobile", "light" | "dark"] {
  const m = key.match(/^(.*)-(desktop|mobile)-(light|dark)$/);
  const slug = m?.[1] ?? "home";
  const path = paths.find((p) => slugify(p === "/" ? "home" : p, 30) === slug) ?? "/";
  return [path, (m?.[2] ?? "desktop") as "desktop" | "mobile", (m?.[3] ?? "light") as "light" | "dark"];
}

function mergeA11y(into: Map<string, A11yIssue>, add: Map<string, A11yIssue>) {
  for (const [id, v] of add) {
    const prior = into.get(id);
    into.set(id, prior ? { ...v, count: Math.max(prior.count, v.count) } : v);
  }
  return into;
}

const sum = (m: Map<string, { count: number }>) => [...m.values()].reduce((n, v) => n + v.count, 0);
const rel = (root: string, file: string) => file.slice(root.length + 1);

async function diffImages(a: string, b: string, out: string): Promise<{ file: string | null; pct: number }> {
  const { PNG } = await import("pngjs");
  const pixelmatch = (await import("pixelmatch")).default;
  const imgA = PNG.sync.read(readFileSync(a));
  const imgB = PNG.sync.read(readFileSync(b));
  if (imgA.width !== imgB.width || imgA.height !== imgB.height) return { file: null, pct: 100 };
  const diff = new PNG({ width: imgA.width, height: imgA.height });
  const changed = pixelmatch(imgA.data, imgB.data, diff.data, imgA.width, imgA.height, {
    threshold: 0.1,
    alpha: 0.25,
    diffColor: [242, 166, 90],
  });
  writeFileSync(out, PNG.sync.write(diff));
  return { file: out, pct: Math.round((changed / (imgA.width * imgA.height)) * 10000) / 100 };
}

function readAxe(): string | null {
  // Embedded at build time so the compiled binary carries it too.
  return axeSource || null;
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = s.port as number;
  s.stop(true);
  return port;
}

/** A short summary for the reviewer's prompt and the PR body. */
export function summarizeEvidence(ev: Evidence): string {
  const lines: string[] = [];
  if (ev.testProof) {
    const p = ev.testProof;
    lines.push(
      p.testFiles.length
        ? `- Fail-then-pass: new tests (${p.testFiles.join(", ")}) ${p.failsOnBase === true ? "FAIL on the base branch" : p.failsOnBase === false ? "also PASS on the base branch (they don't prove the fix)" : `couldn't be run on the base branch${p.unavailable ? ` (${p.unavailable})` : ""}`} and ${p.passesOnBranch ? "pass" : "fail"} on this branch.`
        : "- Fail-then-pass: no test files were added or changed.",
    );
  }
  if (ev.screenshots.length) {
    const changed = ev.screenshots.filter((s) => (s.changedPct ?? 0) > 0.05);
    lines.push(
      `- Screenshots: ${ev.screenshots.length} captured (${[...new Set(ev.screenshots.map((s) => s.path))].join(", ")} × desktop/mobile × light/dark); ${changed.length} visibly changed vs the base branch.`,
    );
  }
  if (ev.a11y)
    lines.push(
      `- Accessibility: ${ev.a11y.after} issue(s) after${ev.a11y.before !== null ? ` vs ${ev.a11y.before} before` : ""}; ${ev.a11y.newIssues.length} new (${ev.a11y.newIssues.map((i) => i.id).join(", ") || "none"}).`,
    );
  if (ev.screenshots.length)
    lines.push(
      `- Console errors on the new pages: ${ev.consoleErrors.length ? ev.consoleErrors.slice(0, 5).join(" | ") : "none"}.`,
    );
  for (const m of ev.missing) lines.push(`- MISSING: ${m}`);
  for (const n of ev.notes) lines.push(`- Note: ${n}`);
  return lines.join("\n") || "- No automatic evidence applies to this task type.";
}
