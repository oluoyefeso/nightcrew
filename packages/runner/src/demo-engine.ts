// A pretend crew for trying the dashboard without spending anything. It
// narrates believable steps and writes one small file inside the task's scope.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentEngine, EngineEvent, PhaseRequest, PhaseResult } from "./engine";

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });

export class DemoEngine implements AgentEngine {
  readonly name = "demo";
  constructor(private readonly stepMs = 900) {}

  async runPhase(req: PhaseRequest, onEvent: (e: EngineEvent) => void): Promise<PhaseResult> {
    const script: Record<PhaseRequest["phase"], EngineEvent[]> = {
      plan: [
        { kind: "tool", tool: "Glob", input: {}, text: "Looked for **/*.ts" },
        { kind: "tool", tool: "Read", input: {}, text: "Read README.md" },
        { kind: "text", text: "The change fits in one module. Writing the plan." },
      ],
      implement: [
        { kind: "tool", tool: "Read", input: {}, text: "Read package.json" },
        { kind: "tool", tool: "Write", input: {}, text: `Wrote ${this.target(req)}` },
        { kind: "tool", tool: "Bash", input: {}, text: "$ bun test" },
        { kind: "text", text: "Tests pass." },
      ],
      repair: [{ kind: "tool", tool: "Edit", input: {}, text: `Edited ${this.target(req)}` }],
      review: [
        { kind: "tool", tool: "Bash", input: {}, text: "$ git diff main...HEAD" },
        { kind: "text", text: "Checked each criterion against the diff." },
      ],
      research: [
        { kind: "tool", tool: "Grep", input: {}, text: 'Searched for "auth"' },
        { kind: "tool", tool: "WebSearch", input: {}, text: 'Searched the web for "best practice"' },
      ],
      compose: [],
    };
    const steps = script[req.phase];

    for (const s of steps) {
      if (req.signal.aborted) break;
      await wait(this.stepMs, req.signal);
      onEvent(s);
    }
    if (req.signal.aborted) return this.result({ ok: false, error: "Stopped." });

    if (req.phase === "implement" || req.phase === "repair") {
      const file = join(req.cwd, this.target(req));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `# NightCrew demo\n\nWritten at ${new Date().toISOString()} for a demo run.\n`);
      return this.result({ text: `Added ${this.target(req)} as a demo change; checks pass.` });
    }
    if (req.phase === "review") {
      return this.result({
        structured: {
          verdict: "ready",
          summary: "Demo change looks fine.",
          criteria: [{ criterion: "Demo file exists", met: true, evidence: this.target(req) }],
          concerns: [],
          report: "This was a demo run. No real review happened.",
        },
      });
    }
    if (req.phase === "compose") {
      // Split the request into sentences, one pretend task each.
      const request = req.prompt.split("The request:\n\n")[1] ?? req.prompt;
      const repo = req.prompt.match(/^### (\S+)/m)?.[1] ?? "";
      const parts = request
        .split(/(?<=[.!?])\s+|\n+|;\s*/)
        .map((p) => p.trim())
        .filter((p) => p.length > 3)
        .slice(0, 5);
      return this.result({
        structured: {
          tasks: parts.map((p, i) => ({
            repo,
            title: p
              .replace(/[.!?]$/, "")
              .replace(/^(also|and|then)\s+/i, "")
              .replace(/^./, (c) => c.toUpperCase())
              .slice(0, 70),
            type: /\b(bug|fix|broken|crash|error)\b/i.test(p)
              ? "bugfix"
              : /\b(ui|dark mode|style|layout|button)\b/i.test(p)
                ? "ui"
                : /\b(why|how|research|investigate)\b/i.test(p)
                  ? "research"
                  : "implementation",
            brief: p,
            scope: ["src/**", "tests/**"],
            criteria: ["Does what the brief asks", "Tests pass"],
            question: /\?$/.test(p) && i === 0 ? null : /\bor\b/i.test(p) ? "Which option do you prefer?" : null,
            dependsOn: [],
          })),
        },
      });
    }
    if (req.phase === "research") {
      writeFileSync(join(req.guard.writableDirs[0] ?? req.cwd, "REPORT.md"), "# Demo report\n\nThis was a demo run.");
      return this.result({ text: "Demo answer: nothing real was researched." });
    }
    return this.result({ text: "## Demo plan\n\n1. Add one small file.\n2. Run the tests." });
  }

  private target(req: PhaseRequest): string {
    const glob = req.guard.scope[0];
    const dir = glob
      ? glob
          .replace(/\/?\*\*.*$/, "")
          .replace(/\/?\*.*$/, "")
          .replace(/\{.*$/, "")
      : "";
    return join(dir, "NIGHTCREW_DEMO.md");
  }

  private result(over: Partial<PhaseResult>): PhaseResult {
    return {
      ok: true,
      text: "",
      structured: null,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      turns: 1,
      error: null,
      rateLimited: false,
      ...over,
    };
  }
}
