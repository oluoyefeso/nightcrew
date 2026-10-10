// Runs a phase on Claude Managed Agents: an Anthropic-hosted agent working in
// a cloud sandbox with the task's GitHub repo mounted. The agent pushes its
// commits to the task branch; afterwards the local worktree fast-forwards to
// them, so the rest of the pipeline (checks, evidence, landing) is unchanged.

import Anthropic from "@anthropic-ai/sdk";
import type {
  AgentCreateParams,
  BetaManagedAgentsAgentToolConfigParams,
  BetaManagedAgentsAgentToolset20260401Params,
} from "@anthropic-ai/sdk/resources/beta/agents/agents";
import type { EnvironmentCreateParams } from "@anthropic-ai/sdk/resources/beta/environments/environments";
import type {
  BetaManagedAgentsSessionErrorEvent,
  BetaManagedAgentsSessionEvent,
  BetaManagedAgentsSessionUsageSnapshot,
  BetaManagedAgentsStreamSessionEvents,
  BetaManagedAgentsUserToolConfirmationEventParams,
  EventListParams,
  EventSendParams,
  EventStreamParams,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";
import type {
  BetaManagedAgentsGitHubRepositoryResourceParams,
  BetaManagedAgentsSession,
  BetaManagedAgentsSessionUsage,
  SessionCreateParams,
} from "@anthropic-ai/sdk/resources/beta/sessions/sessions";
import {
  type AgentEngine,
  checkGuard,
  describeTool,
  type EngineEvent,
  type PhaseRequest,
  type PhaseResult,
} from "./engine";
import { git, run } from "./git";
import { withRepoInstructions } from "./sdk-engine";

/** The slice of the Anthropic client this engine uses. Tests pass a fake. */
export interface ManagedAgentsClient {
  beta: {
    environments: { create(params: EnvironmentCreateParams): PromiseLike<{ id: string }> };
    agents: { create(params: AgentCreateParams): PromiseLike<{ id: string }> };
    sessions: {
      create(params: SessionCreateParams): PromiseLike<{ id: string }>;
      retrieve(sessionID: string): PromiseLike<Pick<BetaManagedAgentsSession, "id" | "status" | "usage">>;
      events: {
        stream(
          sessionID: string,
          params?: EventStreamParams,
          options?: { signal?: AbortSignal | null },
        ): PromiseLike<AsyncIterable<BetaManagedAgentsStreamSessionEvents>>;
        list(sessionID: string, params?: EventListParams | null): AsyncIterable<BetaManagedAgentsSessionEvent>;
        send(sessionID: string, params: EventSendParams): PromiseLike<unknown>;
      };
    };
  };
}

export interface ManagedEngineOptions {
  client?: ManagedAgentsClient;
  apiKey?: string;
  /** A GitHub token for the session's repo mount. Fetched per session, never logged. */
  githubToken: () => Promise<string>;
  /** Used when a phase doesn't name a model. */
  model?: string;
}

// Built-in toolset names, mapped to the names describeTool and the guard know.
const TOOL_NAMES: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  glob: "Glob",
  grep: "Grep",
  web_fetch: "WebFetch",
  web_search: "WebSearch",
};
const TOOLSET_NAME = Object.fromEntries(Object.entries(TOOL_NAMES).map(([k, v]) => [v, k])) as Record<
  string,
  BetaManagedAgentsAgentToolConfigParams["name"]
>;

/** Hosts the sandbox may reach, besides public package registries. */
const ALLOWED_HOSTS = ["github.com", "api.github.com"];
const MAX_RECONNECTS = 5;
const GIT_TIMEOUT_MS = 120_000;

const AGENT_SYSTEM =
  "You are a member of NightCrew, an overnight coding crew. You work unattended in a cloud sandbox: nobody is watching, so never stop to ask questions. Follow the instructions in each message exactly, including the limits on what you may change and push.";

type PhaseKind = "write" | "read-only" | "no-tools";

export class ManagedEngine implements AgentEngine {
  readonly name = "managed";
  private readonly client: ManagedAgentsClient;
  private environment: Promise<string> | null = null;
  private readonly agents = new Map<string, Promise<string>>();

  constructor(private readonly opts: ManagedEngineOptions) {
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey });
  }

  async runPhase(req: PhaseRequest, onEvent: (e: EngineEvent) => void): Promise<PhaseResult> {
    const result: PhaseResult = {
      ok: false,
      text: "",
      structured: null,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      turns: 0,
      error: null,
      rateLimited: false,
    };
    const model = req.model || this.opts.model || "";
    const kind: PhaseKind =
      req.outputSchema && req.phase === "compose" ? "no-tools" : req.guard.readOnly ? "read-only" : "write";
    const writes = kind === "write";

    // Where the work happens: the task's GitHub repo and branch.
    let repo: { url: string; mountPath: string; branch: string } | null = null;
    if (req.phase !== "compose") {
      const url = await githubRepoUrl(req.cwd);
      if (!url) return fail(result, "The cloud engine needs the repo to have a GitHub remote named origin.");
      const branch = (await git(req.cwd, "branch", "--show-current")).stdout.trim();
      if (!branch) return fail(result, "The cloud engine needs the worktree to be on a branch, not a detached HEAD.");
      if (req.guard.protectedBranches.includes(branch))
        return fail(result, `Branch "${branch}" is protected. The cloud engine only works on task branches.`);
      // The sandbox clones from GitHub, so it can only check out what's there.
      const push = await run(["git", "push", "origin", `HEAD:refs/heads/${branch}`], req.cwd, {
        timeoutMs: GIT_TIMEOUT_MS,
      });
      if (!push.ok)
        return fail(result, `Couldn't push the task branch for the cloud session: ${lastLine(push.stderr)}`);
      repo = { url, mountPath: `/workspace/${url.split("/").pop()}`, branch };
    }

    const local = new AbortController();
    let sessionId: string | undefined;
    let interrupt: Promise<unknown> | null = null;
    const sendInterrupt = () => {
      if (sessionId && !interrupt)
        interrupt = Promise.resolve(
          this.client.beta.sessions.events.send(sessionId, { events: [{ type: "user.interrupt" }] }),
        ).catch(() => {});
    };
    const onAbort = () => {
      sendInterrupt();
      local.abort();
    };
    req.signal.addEventListener("abort", onAbort, { once: true });

    let lastText = "";
    let lastError: BetaManagedAgentsSessionErrorEvent["error"] | null = null;
    let usage: BetaManagedAgentsSessionUsage | BetaManagedAgentsSessionUsageSnapshot | null = null;
    let turnLimitHit = false;
    let finished = false;
    const toolUses = new Map<string, { tool: string; input: Record<string, unknown> }>();

    try {
      const [environmentId, agentId] = await Promise.all([
        this.ensureEnvironment(),
        this.ensureAgent(model, kind, req),
      ]);
      if (req.signal.aborted) throw new Error("aborted");

      const resources: SessionCreateParams["resources"] = [];
      if (repo) {
        const resource: BetaManagedAgentsGitHubRepositoryResourceParams = {
          type: "github_repository",
          url: repo.url,
          mount_path: repo.mountPath,
          checkout: { type: "branch", name: repo.branch },
          authorization_token: await this.opts.githubToken(),
        };
        resources.push(resource);
      }
      const cents = Math.floor(req.maxBudgetUsd * 100);
      const session = await this.client.beta.sessions.create({
        agent: agentId,
        environment_id: environmentId,
        title: `NightCrew ${req.phase}`,
        metadata: { phase: req.phase },
        ...(resources.length ? { resources } : {}),
        ...(Number.isFinite(cents) && cents > 0
          ? { budget: { type: "limit", max_list_cost: { amount: String(cents), currency: "USD" } } }
          : {}),
      });
      sessionId = session.id;
      result.sessionId = session.id;
      if (req.signal.aborted) {
        sendInterrupt();
        throw new Error("aborted");
      }

      const seen = new Set<string>();
      const handle = async (ev: BetaManagedAgentsStreamSessionEvents | BetaManagedAgentsSessionEvent) => {
        if (!("id" in ev)) return; // delta previews; not requested
        if (seen.has(ev.id)) return;
        seen.add(ev.id);
        switch (ev.type) {
          case "agent.message": {
            const text = ev.content
              .map((b) => (b.type === "text" ? b.text : ""))
              .join("")
              .trim();
            if (text) {
              lastText = text;
              onEvent({ kind: "text", text });
            }
            break;
          }
          case "agent.tool_use": {
            const tool = TOOL_NAMES[ev.name] ?? ev.name;
            const text = describeTool(tool, ev.input, repo?.mountPath ?? "/workspace");
            if (ev.evaluated_permission === "deny") {
              onEvent({ kind: "denied", tool, text: `Blocked ${text}: the cloud's safety check refused it.` });
            } else if (ev.evaluated_permission === "ask") {
              toolUses.set(ev.id, { tool, input: ev.input }); // answered on requires_action
            } else {
              onEvent({ kind: "tool", tool, input: ev.input, text });
            }
            break;
          }
          case "span.model_request_end":
            result.turns++;
            if (result.turns > req.maxTurns && !turnLimitHit) {
              turnLimitHit = true;
              sendInterrupt();
            }
            break;
          case "session.usage":
            usage = ev.usage;
            break;
          case "session.error":
            lastError = ev.error;
            if (ev.error.retry_status.type === "retrying")
              onEvent({ kind: "info", text: `The cloud session hit an error and is retrying: ${ev.error.message}` });
            break;
          case "session.status_idle":
            if (ev.stop_reason.type === "requires_action") {
              await this.confirm(session.id, ev.stop_reason.event_ids, toolUses, req, repo, onEvent);
              break;
            }
            finished = true;
            if (ev.stop_reason.type === "end_turn") {
              if (turnLimitHit) result.error = "Hit the turn limit before finishing.";
              else result.ok = true;
            } else if (ev.stop_reason.type === "budget_reached") {
              result.error = "Hit the task's budget before finishing.";
            } else if (ev.stop_reason.type === "refusal") {
              const why = ev.stop_details?.explanation;
              result.error = `The model declined to continue${why ? `: ${why}` : "."}`;
            } else {
              result.error = describeSessionError(lastError, result);
            }
            break;
          case "session.status_terminated":
          case "session.deleted":
            finished = true;
            result.error = lastError
              ? describeSessionError(lastError, result)
              : "The cloud session ended unexpectedly.";
            break;
        }
      };

      // Open the stream before sending the message, so no event is missed.
      const events = this.client.beta.sessions.events;
      let stream = await events.stream(session.id, {}, { signal: local.signal });
      await events.send(session.id, {
        events: [{ type: "user.message", content: [{ type: "text", text: buildPrompt(req, repo, writes) }] }],
      });
      for (let reconnects = 0; ; reconnects++) {
        for await (const ev of untilAborted(stream, local.signal)) {
          await handle(ev);
          if (finished) break;
        }
        if (finished || req.signal.aborted) break;
        // The connection dropped: reopen, then catch up from the history.
        if (reconnects >= MAX_RECONNECTS) throw new Error("Lost the connection to the cloud session.");
        stream = await events.stream(session.id, {}, { signal: local.signal });
        for await (const ev of untilAborted(events.list(session.id), local.signal)) {
          await handle(ev);
          if (finished) break;
        }
        if (finished || req.signal.aborted) break;
      }
      if (req.signal.aborted && !finished) throw new Error("aborted");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const status = typeof e === "object" && e && "status" in e ? (e as { status: unknown }).status : null;
      result.ok = false;
      if (req.signal.aborted) result.error = "Stopped: the task ran out of time or was cancelled.";
      else if (status === 429 || /rate.?limit|429/i.test(message)) {
        result.error = "Rate limited by the API (429).";
        result.rateLimited = true;
      } else if (/budget/i.test(message)) result.error = "Hit the task's budget before finishing.";
      else if (!finished) result.error = `The agent crashed: ${redact(message).slice(0, 240)}`;
      else result.error ??= redact(message).slice(0, 240);
    } finally {
      req.signal.removeEventListener("abort", onAbort);
      local.abort();
      if (interrupt) await interrupt;
    }

    // The session's own totals are authoritative; the last usage event is the fallback.
    if (sessionId) {
      try {
        usage = (await this.client.beta.sessions.retrieve(sessionId)).usage ?? usage;
      } catch {}
    }
    if (usage) applyUsage(result, usage, model);

    result.text = lastText;
    if (req.outputSchema) {
      result.structured = lastJsonObject(lastText);
      if (result.ok && result.structured === null) {
        result.ok = false;
        result.error = "Couldn't produce a valid structured answer.";
      }
    }

    // Bring the cloud's commits into the local worktree.
    if (writes && repo && sessionId) {
      const fetched = await run(["git", "fetch", "origin", repo.branch], req.cwd, { timeoutMs: GIT_TIMEOUT_MS });
      const merged = fetched.ok ? await git(req.cwd, "merge", "--ff-only", `origin/${repo.branch}`) : fetched;
      if (!merged.ok && result.ok) {
        result.ok = false;
        result.error = "The cloud session's changes couldn't be pulled cleanly.";
      }
    }
    return result;
  }

  /** One cloud environment per engine, with networking limited to GitHub and package registries. */
  private ensureEnvironment(): Promise<string> {
    this.environment ??= Promise.resolve(
      this.client.beta.environments.create({
        name: `nightcrew-${Date.now().toString(36)}`,
        description: "NightCrew cloud sandbox",
        config: {
          type: "cloud",
          // Never omit this: an environment without it gets unrestricted networking.
          networking: {
            type: "limited",
            allowed_hosts: ALLOWED_HOSTS,
            allow_package_managers: true,
            allow_mcp_servers: false,
          },
        },
      }),
    )
      .then((env) => env.id)
      .catch((e) => {
        this.environment = null;
        throw e;
      });
    return this.environment;
  }

  /** One agent per model and kind of phase, reused across tasks. */
  private ensureAgent(model: string, kind: PhaseKind, req: PhaseRequest): Promise<string> {
    const disabled = [...new Set(req.disallowedTools ?? [])].filter((t) => TOOLSET_NAME[t]).sort();
    const key = `${model}|${kind}|${disabled.join(",")}`;
    let agent = this.agents.get(key);
    if (!agent) {
      agent = Promise.resolve(
        this.client.beta.agents.create({
          name: `NightCrew ${kind}`,
          model,
          system: AGENT_SYSTEM,
          tools: [toolset(kind, disabled)],
          metadata: { nightcrew: kind },
        }),
      )
        .then((a) => a.id)
        .catch((e) => {
          this.agents.delete(key);
          throw e;
        });
      this.agents.set(key, agent);
    }
    return agent;
  }

  /**
   * Answer tool calls the cloud's auto policy couldn't decide on, with the same
   * guard the local engine uses. Nobody is around to answer them otherwise.
   */
  private async confirm(
    sessionId: string,
    ids: string[],
    toolUses: Map<string, { tool: string; input: Record<string, unknown> }>,
    req: PhaseRequest,
    repo: { mountPath: string; branch: string } | null,
    onEvent: (e: EngineEvent) => void,
  ) {
    const events: BetaManagedAgentsUserToolConfirmationEventParams[] = ids.map((id) => {
      const use = toolUses.get(id);
      if (!use)
        return { type: "user.tool_confirmation", tool_use_id: id, result: "deny", deny_message: "Not allowed." };
      const mount = repo?.mountPath ?? "/workspace";
      const text = describeTool(use.tool, use.input, mount);
      const decision = allowedPush(use, req, repo)
        ? ({ allow: true } as const)
        : checkGuard(req, use.tool, toLocalPaths(use.input, mount, req.guard.worktree));
      if (decision.allow) {
        onEvent({ kind: "tool", tool: use.tool, input: use.input, text });
        return { type: "user.tool_confirmation", tool_use_id: id, result: "allow" };
      }
      onEvent({ kind: "denied", tool: use.tool, text: `Blocked ${text}: ${decision.reason}` });
      return { type: "user.tool_confirmation", tool_use_id: id, result: "deny", deny_message: decision.reason };
    });
    if (events.length) await this.client.beta.sessions.events.send(sessionId, { events });
  }
}

function toolset(kind: PhaseKind, disabled: string[]): BetaManagedAgentsAgentToolset20260401Params {
  if (kind === "no-tools") return { type: "agent_toolset_20260401", default_config: { enabled: false } };
  const off = new Set(disabled.map((t) => TOOLSET_NAME[t]));
  if (kind === "read-only") {
    off.add("write");
    off.add("edit");
  }
  const configs: BetaManagedAgentsAgentToolConfigParams[] = [...off]
    .filter((name) => name !== undefined)
    .map((name) => ({ name, enabled: false }) as BetaManagedAgentsAgentToolConfigParams);
  return {
    type: "agent_toolset_20260401",
    // Permission policy: `auto`. The run is unattended, so `always_ask` would
    // stall every tool call on a confirmation round trip (and forever if this
    // process goes away), while `always_allow` runs anything the model types.
    // `auto` has the server allow routine calls, deny high-risk ones on its
    // own, and pause only on calls it can't judge, which `confirm` answers with
    // the same guard the local engine applies. Nothing ever waits on a person.
    default_config: { enabled: true, permission_policy: { type: "auto" } },
    ...(configs.length ? { configs } : {}),
  };
}

function buildPrompt(req: PhaseRequest, repo: { mountPath: string; branch: string } | null, writes: boolean): string {
  const rules: string[] = [];
  if (repo) {
    rules.push(`- The repository is mounted at \`${repo.mountPath}\`, on branch \`${repo.branch}\`. Work there.`);
    if (writes) {
      rules.push(
        `- When you've finished making changes, commit them and run \`git push origin HEAD:${repo.branch}\` as its own command.`,
        `- Never push any other branch, never force-push, and never rewrite history.`,
      );
      if (req.guard.scope.length)
        rules.push(
          `- Only change files matching these globs (relative to the repo root): ${req.guard.scope.join(", ")}.`,
        );
    } else {
      rules.push("- This phase is read-only: don't change, commit or push anything.");
    }
    rules.push("- Never touch `.github/workflows/` or any `.env` file, and never print secrets.");
  }
  if (req.outputSchema) {
    rules.push(
      `- End your final reply with ONLY a JSON object matching this JSON Schema, with nothing after it:\n\n\`\`\`json\n${JSON.stringify(req.outputSchema, null, 2)}\n\`\`\``,
    );
  }
  const system = withRepoInstructions(req.systemPrompt, req.cwd);
  return [system, req.prompt, rules.length ? `## Working in the cloud sandbox\n\n${rules.join("\n")}` : ""]
    .filter(Boolean)
    .join("\n\n---\n\n");
}

/** The one push a write phase may make: its own branch, from HEAD. */
function allowedPush(
  use: { tool: string; input: Record<string, unknown> },
  req: PhaseRequest,
  repo: { branch: string } | null,
): boolean {
  if (use.tool !== "Bash" || req.guard.readOnly || !repo) return false;
  const cmd = String(use.input.command ?? "").trim();
  const branch = repo.branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^git\\s+push\\s+origin\\s+HEAD:(refs/heads/)?${branch}$`).test(cmd);
}

/** Sandbox paths, rewritten to the worktree so the guard can judge them. */
function toLocalPaths(input: Record<string, unknown>, mount: string, worktree: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  for (const key of ["file_path", "notebook_path", "path"]) {
    const v = out[key];
    if (typeof v === "string" && (v === mount || v.startsWith(`${mount}/`)))
      out[key] = worktree + v.slice(mount.length);
  }
  return out;
}

function applyUsage(
  result: PhaseResult,
  u: BetaManagedAgentsSessionUsage | BetaManagedAgentsSessionUsageSnapshot,
  model: string,
) {
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite =
    (u.cache_creation?.ephemeral_5m_input_tokens ?? 0) + (u.cache_creation?.ephemeral_1h_input_tokens ?? 0);
  // list_cost is whole US cents, as a string.
  const cents = u.list_cost?.currency === "USD" ? Number(u.list_cost.amount) : Number.NaN;
  result.costUsd = Number.isFinite(cents) ? cents / 100 : 0;
  result.tokensIn = input + cacheRead + cacheWrite;
  result.tokensOut = output;
  result.usage = { [model]: { input, output, thinking: 0, cacheRead, cacheWrite, costUsd: result.costUsd } };
}

function describeSessionError(err: BetaManagedAgentsSessionErrorEvent["error"] | null, result: PhaseResult): string {
  if (!err) return "The agent stopped with an error.";
  switch (err.type) {
    case "model_rate_limited_error":
      result.rateLimited = true;
      return "Rate limited by the API (429).";
    case "billing_error":
      return `Billing problem: ${err.message}`.slice(0, 240);
    case "repository_authentication_error":
    case "repository_forbidden_error":
    case "repository_not_found_error":
    case "repository_checkout_error":
    case "repository_clone_error":
      return `The cloud session couldn't check out the repo: ${redact(err.message)}`.slice(0, 240);
    default:
      return redact(err.message).trim().slice(0, 240) || "The agent stopped with an error.";
  }
}

function fail(result: PhaseResult, error: string): PhaseResult {
  result.error = error;
  return result;
}

/**
 * The GitHub HTTPS URL for the repo's origin, or null if it isn't on GitHub.
 * Falls back to the raw configured URL when `get-url` shows a local rewrite
 * (url.<base>.insteadOf).
 */
export async function githubRepoUrl(cwd: string): Promise<string | null> {
  const shown = toGithubHttps((await git(cwd, "remote", "get-url", "origin")).stdout.trim());
  if (shown) return shown;
  return toGithubHttps((await git(cwd, "config", "--get", "remote.origin.url")).stdout.trim());
}

/** `git@github.com:o/r.git`, `ssh://git@github.com/o/r`, `https://github.com/o/r.git` → `https://github.com/o/r`. */
export function toGithubHttps(remote: string): string | null {
  const m =
    remote.match(/^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/) ??
    remote.match(/^(?:https?|git):\/\/(?:[^@/\s]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

/** The last top-level JSON object in a reply, fenced or not. */
export function lastJsonObject(text: string): unknown {
  let found: unknown = null;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    const end = matchingBrace(text, i);
    if (end < 0) continue;
    try {
      found = JSON.parse(text.slice(i, end + 1));
      i = end;
    } catch {}
  }
  return found;
}

function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

/** Iterate until the source ends or the signal fires, whichever comes first. */
async function* untilAborted<T>(source: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T> {
  const it = source[Symbol.asyncIterator]();
  const aborted = new Promise<"aborted">((resolve) => {
    if (signal.aborted) resolve("aborted");
    else signal.addEventListener("abort", () => resolve("aborted"), { once: true });
  });
  try {
    while (true) {
      const next = await Promise.race([it.next(), aborted]);
      if (next === "aborted" || next.done) return;
      yield next.value;
    }
  } finally {
    void Promise.resolve(it.return?.()).catch(() => {});
  }
}

function lastLine(s: string): string {
  return redact(s.trim().split("\n").pop() ?? "").slice(0, 200) || "git push failed";
}

/** Strip credentials from URLs in messages. */
function redact(s: string): string {
  return s.replace(/(\/\/)[^@/\s]+@/g, "$1");
}
