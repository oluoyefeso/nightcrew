// Talking to a compatible endpoint: list its models and run one synthetic tool
// exchange. Every request is bounded in time and size, never follows redirects,
// never retries, and every error is a fixed sentence. Nothing here reads the
// repository or runs a command: the probe file exists only in memory.

import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectionCheck, ConnectionUsage } from "@nightcrew/core";
import { guardToolCall } from "@nightcrew/core/guard";

const MAX_MODEL_ID = 200;
const MAX_MODELS = 1000;
const MODELS_LIMIT_BYTES = 1024 * 1024;
const CHECK_LIMIT_BYTES = 64 * 1024;
const DISCOVER_TIMEOUT_MS = 15_000;
const CHECK_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;
const PROBE_FILE = "probe.txt";

type Failure =
  | "invalid-url"
  | "invalid-model"
  | "invalid-key"
  | "cancelled"
  | "timeout"
  | "network"
  | "rejected"
  | "credentials"
  | "credits"
  | "rate-limit"
  | "not-found"
  | "unsupported-tools"
  | "too-large"
  | "malformed"
  | "no-tool-call"
  | "bad-tool-call"
  | "repeated-tool-call"
  | "guard"
  | "wrong-answer";

const MESSAGES: Record<Failure, string> = {
  "invalid-url":
    "The endpoint address is not valid. Use https, or http on localhost, without credentials, query or fragment.",
  "invalid-model": "The model name is not valid.",
  "invalid-key": "The API key is not valid.",
  cancelled: "The request was cancelled.",
  timeout: "The endpoint did not answer in time.",
  network: "The endpoint could not be reached, or tried to redirect.",
  rejected: "The endpoint refused the request.",
  credentials: "The endpoint refused access. Check the credential and its permissions.",
  credits:
    "The endpoint refused the request budget (402). Check available credits, key limits and requested output tokens; concurrent requests can also reserve credit.",
  "rate-limit": "The endpoint reported a rate or quota limit. Check the provider limit before trying again.",
  "not-found": "The endpoint could not find the API route or selected model. Check the base URL and model ID.",
  "unsupported-tools":
    "The endpoint reports that this model does not support tool calls. Choose a model with tool support.",
  "too-large": "The endpoint response was too large.",
  malformed: "The endpoint response was not in the expected format.",
  "no-tool-call": "The model answered without using the synthetic tool.",
  "bad-tool-call": "The model made a tool call the check does not allow.",
  "repeated-tool-call": "The model asked for the tool again after it was answered.",
  guard: "The NightCrew guard refused the synthetic tool call.",
  "wrong-answer": "The model did not return the synthetic tool result.",
};

export class ConnectionError extends Error {
  readonly code: Failure;
  constructor(code: Failure) {
    super(MESSAGES[code]);
    this.name = "ConnectionError";
    this.code = code;
  }
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/** A canonical base URL without trailing slash. Throws only fixed messages. */
export function normalizeConnectionUrl(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) throw new ConnectionError("invalid-url");
  if (value.includes("?") || value.includes("#") || /[\s\\]/.test(value.trim()) || /\p{Cc}/u.test(value)) {
    throw new ConnectionError("invalid-url");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ConnectionError("invalid-url");
  }
  if (url.username || url.password || url.search || url.hash) throw new ConnectionError("invalid-url");
  const secure = url.protocol === "https:";
  if (!secure && !(url.protocol === "http:" && isLoopback(url.hostname))) throw new ConnectionError("invalid-url");
  if (!url.hostname) throw new ConnectionError("invalid-url");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function validModel(model: string): boolean {
  return typeof model === "string" && model.trim().length > 0 && model.length <= MAX_MODEL_ID && !/\p{Cc}/u.test(model);
}

function validKey(key: string | undefined): string | undefined {
  if (key === undefined || key === "") return undefined;
  if (typeof key !== "string" || /\p{Cc}/u.test(key)) throw new ConnectionError("invalid-key");
  return key;
}

function clampTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), 1), MAX_TIMEOUT_MS);
}

/** One deadline and one cancel signal shared by every request of an operation. */
class Scope {
  readonly controller = new AbortController();
  private reason: "timeout" | "cancelled" | null = null;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly gone: Promise<never>;
  private readonly onAbort = () => this.abort("cancelled");

  constructor(
    timeoutMs: number,
    private readonly outer?: AbortSignal,
  ) {
    this.gone = new Promise<never>((_, reject) => {
      this.controller.signal.addEventListener("abort", () => reject(new ConnectionError(this.reason ?? "cancelled")), {
        once: true,
      });
    });
    this.gone.catch(() => {});
    this.timer = setTimeout(() => this.abort("timeout"), timeoutMs);
    if (outer?.aborted) this.abort("cancelled");
    else outer?.addEventListener("abort", this.onAbort, { once: true });
  }

  /** The failure to report: the abort reason if the scope was aborted, else the given one. */
  failure(err: unknown, fallback: Failure): ConnectionError {
    if (this.reason) return new ConnectionError(this.reason);
    return err instanceof ConnectionError ? err : new ConnectionError(fallback);
  }

  private abort(reason: "timeout" | "cancelled") {
    if (this.reason) return;
    this.reason = reason;
    this.controller.abort();
  }

  /** Settles with the work, or the moment the scope is aborted, whichever is first. */
  race<T>(work: Promise<T>): Promise<T> {
    work.catch(() => {});
    return Promise.race([work, this.gone]);
  }

  close() {
    clearTimeout(this.timer);
    this.outer?.removeEventListener("abort", this.onAbort);
  }
}

async function readLimited(res: Response, limit: number, scope: Scope): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    res.body?.cancel().catch(() => {});
    throw new ConnectionError("too-large");
  }
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await scope.race(reader.read());
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new ConnectionError("too-large");
      chunks.push(value);
    }
  } catch (err) {
    reader.cancel().catch(() => {});
    throw scope.failure(err, "network");
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ConnectionError("malformed");
  }
}

async function exchange(
  url: string,
  init: { method: "GET" | "POST"; body?: string },
  key: string | undefined,
  limit: number,
  scope: Scope,
): Promise<unknown> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (key) headers.authorization = `Bearer ${key}`;
  let res: Response;
  try {
    res = await scope.race(
      fetch(url, { method: init.method, headers, body: init.body, redirect: "error", signal: scope.controller.signal }),
    );
  } catch (err) {
    throw scope.failure(err, "network");
  }
  if (!res.ok) {
    if (res.status === 400 || res.status === 422) {
      // Recognize one bounded provider claim, but never return its text, model name or details.
      const body = await readLimited(res, Math.min(limit, CHECK_LIMIT_BYTES), scope);
      let unsupported = false;
      try {
        const value: unknown = JSON.parse(body);
        const detail = isRecord(value) && isRecord(value.error) ? value.error.message : null;
        unsupported =
          typeof detail === "string" &&
          /\bdoes not support tools\b|\btool (?:use|calling|calls) (?:is|are) not supported\b/i.test(detail);
      } catch {
        /* Unrecognized provider responses keep the fixed generic refusal. */
      }
      throw new ConnectionError(unsupported ? "unsupported-tools" : "rejected");
    }
    res.body?.cancel().catch(() => {});
    throw new ConnectionError(
      res.status === 401 || res.status === 403
        ? "credentials"
        : res.status === 402
          ? "credits"
          : res.status === 429
            ? "rate-limit"
            : res.status === 404
              ? "not-found"
              : "rejected",
    );
  }
  const text = await readLimited(res, limit, scope);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ConnectionError("malformed");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Shared bounded transport for explicit model execution. Never retries or follows redirects. */
export async function completeConnection(
  target: { baseUrl: string; apiKey?: string },
  payload: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const base = normalizeConnectionUrl(target.baseUrl);
  const key = validKey(target.apiKey);
  const body = JSON.stringify(payload);
  if (body.length > 500_000) throw new ConnectionError("too-large");
  const scope = new Scope(60_000, signal);
  try {
    return await exchange(`${base}/chat/completions`, { method: "POST", body }, key, 1024 * 1024, scope);
  } finally {
    scope.close();
  }
}

/** The model IDs an endpoint lists: unique, sorted, bounded. Throws only fixed messages. */
export async function discoverModels(
  target: { baseUrl: string; apiKey?: string },
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string[]> {
  const base = normalizeConnectionUrl(target.baseUrl);
  const key = validKey(target.apiKey);
  const scope = new Scope(clampTimeout(options.timeoutMs, DISCOVER_TIMEOUT_MS), options.signal);
  try {
    const body = await exchange(`${base}/models`, { method: "GET" }, key, MODELS_LIMIT_BYTES, scope);
    if (!isRecord(body) || !Array.isArray(body.data)) throw new ConnectionError("malformed");
    const ids = new Set<string>();
    for (const item of body.data) {
      if (!isRecord(item) || typeof item.id !== "string") throw new ConnectionError("malformed");
      if (!validModel(item.id)) throw new ConnectionError("malformed");
      ids.add(item.id);
      if (ids.size > MAX_MODELS) throw new ConnectionError("too-large");
    }
    return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  } finally {
    scope.close();
  }
}

const READ_TOOL = {
  type: "function",
  function: {
    name: "Read",
    description: "Read a file and return its contents.",
    parameters: {
      type: "object",
      properties: { file_path: { type: "string", enum: [PROBE_FILE] } },
      required: ["file_path"],
      additionalProperties: false,
    },
  },
};

interface Turn {
  message: Record<string, unknown>;
}

class Counters {
  private requests = 0;
  private withInput = 0;
  private withOutput = 0;
  private input = 0;
  private output = 0;

  beginRequest() {
    this.requests++;
  }

  record(usage: unknown) {
    if (!isRecord(usage)) return;
    const { prompt_tokens: p, completion_tokens: c } = usage;
    if (typeof p === "number" && Number.isSafeInteger(p) && p >= 0) {
      this.withInput++;
      this.input += p;
    }
    if (typeof c === "number" && Number.isSafeInteger(c) && c >= 0) {
      this.withOutput++;
      this.output += c;
    }
  }

  snapshot(): ConnectionUsage {
    const seen = this.withInput + this.withOutput;
    if (seen === 0) return { status: "unknown", inputObserved: null, outputObserved: null };
    const full = this.withInput === this.requests && this.withOutput === this.requests;
    return {
      status: full ? "reported" : "partial",
      inputObserved: this.withInput > 0 ? this.input : null,
      outputObserved: this.withOutput > 0 ? this.output : null,
    };
  }
}

function parseTurn(body: unknown, counters: Counters): Turn {
  // Invalid assistant output can still carry real provider usage.
  if (isRecord(body)) counters.record(body.usage);
  if (!isRecord(body) || !Array.isArray(body.choices) || body.choices.length === 0)
    throw new ConnectionError("malformed");
  const choice: unknown = body.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) throw new ConnectionError("malformed");
  return { message: choice.message };
}

/** Exactly one call, named Read, with exactly {file_path: "probe.txt"}. */
function validateCall(message: Record<string, unknown>): { id: string; call: Record<string, unknown> } {
  const calls = message.tool_calls;
  if (calls === undefined || calls === null || (Array.isArray(calls) && calls.length === 0)) {
    throw new ConnectionError("no-tool-call");
  }
  if (!Array.isArray(calls) || calls.length !== 1) throw new ConnectionError("bad-tool-call");
  const call: unknown = calls[0];
  if (!isRecord(call) || typeof call.id !== "string" || call.id.length === 0 || call.id.length > 200) {
    throw new ConnectionError("bad-tool-call");
  }
  if (call.type !== undefined && call.type !== "function") throw new ConnectionError("bad-tool-call");
  const fn = call.function;
  if (!isRecord(fn) || fn.name !== "Read" || typeof fn.arguments !== "string")
    throw new ConnectionError("bad-tool-call");
  let args: unknown;
  try {
    args = JSON.parse(fn.arguments);
  } catch {
    throw new ConnectionError("bad-tool-call");
  }
  if (!isRecord(args)) throw new ConnectionError("bad-tool-call");
  const keys = Object.keys(args);
  if (keys.length !== 1 || keys[0] !== "file_path" || args.file_path !== PROBE_FILE) {
    throw new ConnectionError("bad-tool-call");
  }
  return { id: call.id, call };
}

/** Defense in depth only: the guard sees a synthetic temp path and does not confine Read itself. */
function guardAllows(): boolean {
  const worktree = join(tmpdir(), "nightcrew-connection-probe");
  const decision = guardToolCall(
    "Read",
    { file_path: join(worktree, PROBE_FILE) },
    { worktree, writableDirs: [], scope: [], protectedBranches: [], readOnly: true },
  );
  return decision.allow;
}

const SUMMARY_PASSED = "The model completed one synthetic Read exchange. Coding support has not been verified.";

/**
 * One synthetic tool exchange, at most two requests. Always resolves with a
 * sanitized result; only invalid programmer input throws, with a fixed message.
 */
export async function checkConnection(
  target: { baseUrl: string; model: string; apiKey?: string },
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ConnectionCheck> {
  const base = normalizeConnectionUrl(target.baseUrl);
  if (!validModel(target.model)) throw new ConnectionError("invalid-model");
  const key = validKey(target.apiKey);
  const model = target.model;
  const started = performance.now();
  const counters = new Counters();
  let turns = 0;
  const scope = new Scope(clampTimeout(options.timeoutMs, CHECK_TIMEOUT_MS), options.signal);

  const result = (status: ConnectionCheck["status"], summary: string): ConnectionCheck => ({
    status,
    summary,
    at: new Date().toISOString(),
    model,
    turns,
    elapsedMs: Math.max(0, Math.round(performance.now() - started)),
    usage: counters.snapshot(),
  });

  const marker = `nc-${randomBytes(12).toString("hex")}`;
  const url = `${base}/chat/completions`;
  const send = async (messages: unknown[]): Promise<Turn> => {
    if (scope.controller.signal.aborted) throw scope.failure(null, "cancelled");
    const payload = JSON.stringify({
      model,
      messages,
      tools: [READ_TOOL],
      tool_choice: "auto",
      stream: false,
      max_tokens: 256,
    });
    // Count attempted requests, including those whose response never arrives.
    // Otherwise a failed second request makes the first one's usage look complete.
    counters.beginRequest();
    const body = await exchange(url, { method: "POST", body: payload }, key, CHECK_LIMIT_BYTES, scope);
    const turn = parseTurn(body, counters);
    turns++;
    return turn;
  };

  try {
    const prompt = {
      role: "user",
      content: `Use the Read tool to read ${PROBE_FILE}, then reply with its exact contents and nothing else.`,
    };
    const first = await send([prompt]);
    const { id, call } = validateCall(first.message);
    if (!guardAllows()) throw new ConnectionError("guard");
    // Replay the assistant turn as received so provider metadata (reasoning_details) survives.
    const assistant = { ...first.message, role: "assistant", tool_calls: [call] };
    const second = await send([prompt, assistant, { role: "tool", tool_call_id: id, content: marker }]);
    const again = second.message.tool_calls;
    if (again !== undefined && again !== null && !(Array.isArray(again) && again.length === 0)) {
      throw new ConnectionError("repeated-tool-call");
    }
    const content = second.message.content;
    if (typeof content !== "string" || content.trim() !== marker) throw new ConnectionError("wrong-answer");
    return result("passed", SUMMARY_PASSED);
  } catch (err) {
    const code: Failure = err instanceof ConnectionError ? err.code : "network";
    return result(code === "cancelled" ? "cancelled" : "failed", MESSAGES[code]);
  } finally {
    scope.close();
  }
}
