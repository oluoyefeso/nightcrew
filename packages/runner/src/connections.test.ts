import { afterEach, describe, expect, test } from "bun:test";
import { checkConnection, discoverModels, normalizeConnectionUrl } from "./connections";

type Handler = (req: Request, n: number) => Response | Promise<Response>;

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

function serve(handler: Handler) {
  let n = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => handler(req, ++n) });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}/v1`, count: () => n };
}

const json = (body: unknown, init?: ResponseInit) => Response.json(body, init);
const SECRET = "sk-test-secret-value";

function toolCall(args: unknown, name = "Read", id = "call_1") {
  return {
    id,
    type: "function",
    function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
  };
}
const reply = (message: Record<string, unknown>, usage?: Record<string, unknown>) =>
  json({ choices: [{ message: { role: "assistant", ...message } }], ...(usage ? { usage } : {}) });

/** A well-behaved model: asks for probe.txt, then echoes the tool result. */
function wellBehaved(usage?: Record<string, unknown>): Handler {
  return async (req, n) => {
    const body = (await req.json()) as { messages: { role: string; content?: string }[] };
    if (n === 1) {
      return reply(
        { content: null, tool_calls: [toolCall({ file_path: "probe.txt" })], reasoning_details: [{ text: "think" }] },
        usage,
      );
    }
    const tool = body.messages.find((m) => m.role === "tool");
    return reply({ content: tool?.content }, usage);
  };
}

describe("normalizeConnectionUrl", () => {
  test("accepts https and loopback http, normalizes trailing slash", () => {
    expect(normalizeConnectionUrl("https://api.example.com/v1/")).toBe("https://api.example.com/v1");
    expect(normalizeConnectionUrl("https://api.example.com")).toBe("https://api.example.com");
    expect(normalizeConnectionUrl("http://localhost:8080/v1")).toBe("http://localhost:8080/v1");
    expect(normalizeConnectionUrl("http://127.0.0.1:1/v1/")).toBe("http://127.0.0.1:1/v1");
    expect(normalizeConnectionUrl("http://[::1]:1234/v1")).toBe("http://[::1]:1234/v1");
  });

  test("rejects everything else with a fixed message that never echoes the input", () => {
    const bad = [
      "http://api.example.com/v1",
      "ftp://api.example.com",
      "https://user:pw-secret@api.example.com",
      "https://user@api.example.com",
      "https://api.example.com/v1?key=secret",
      "https://api.example.com/v1?",
      "https://api.example.com/v1#frag",
      "not a url secret",
      "",
      "file:///etc/passwd",
    ];
    const messages = new Set<string>();
    for (const value of bad) {
      let message = "";
      try {
        normalizeConnectionUrl(value);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain("secret");
      expect(message).not.toContain("example");
      messages.add(message);
    }
    expect(messages.size).toBe(1);
  });
});

describe("discoverModels", () => {
  test("returns unique sorted ids and sends the key only as a bearer header", async () => {
    let auth = "";
    let path = "";
    const s = serve((req) => {
      auth = req.headers.get("authorization") ?? "";
      path = new URL(req.url).pathname;
      return json({ data: [{ id: "b" }, { id: "a" }, { id: "b" }, { id: "c", extra: 1 }] });
    });
    expect(await discoverModels({ baseUrl: s.url, apiKey: SECRET })).toEqual(["a", "b", "c"]);
    expect(auth).toBe(`Bearer ${SECRET}`);
    expect(path).toBe("/v1/models");
  });

  test("rejects malformed lists", async () => {
    const bodies: unknown[] = [
      [],
      { data: "x" },
      { data: [{}] },
      { data: [{ id: "" }] },
      { data: [{ id: 5 }] },
      { data: [{ id: "x".repeat(201) }] },
      { data: [null] },
    ];
    for (const body of bodies) {
      const s = serve(() => json(body));
      await expect(discoverModels({ baseUrl: s.url })).rejects.toThrow("not in the expected format");
    }
    const s = serve(() => new Response("not json"));
    await expect(discoverModels({ baseUrl: s.url })).rejects.toThrow("not in the expected format");
  });

  test("accepts 200-char ids and 1000 ids, rejects 1001", async () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${String(i).padStart(4, "0")}` }));
    const ok = serve(() => json({ data: [...ids(999), { id: "y".repeat(200) }] }));
    expect((await discoverModels({ baseUrl: ok.url })).length).toBe(1000);
    const many = serve(() => json({ data: ids(1001) }));
    await expect(discoverModels({ baseUrl: many.url })).rejects.toThrow("too large");
  });

  test("enforces the response size limit, declared or streamed", async () => {
    const big = serve(() => new Response(`{"data":[],"pad":"${"x".repeat(1024 * 1024)}"}`));
    await expect(discoverModels({ baseUrl: big.url })).rejects.toThrow("too large");
    const chunked = serve(
      () =>
        new Response(
          new ReadableStream({
            pull(c) {
              c.enqueue(new Uint8Array(64 * 1024));
            },
          }),
        ),
    );
    await expect(discoverModels({ baseUrl: chunked.url })).rejects.toThrow("too large");
  });

  test("errors never include provider text or the key", async () => {
    const s = serve(
      () => new Response(`boom ${SECRET} provider-detail`, { status: 500, headers: { "x-leak": SECRET } }),
    );
    const err = await discoverModels({ baseUrl: s.url, apiKey: SECRET }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const text = `${(err as Error).message} ${(err as Error).stack ?? ""}`;
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("provider-detail");
    expect(text).not.toContain("127.0.0.1");
  });

  test("does not follow redirects", async () => {
    const target = serve(() => json({ data: [{ id: "x" }] }));
    const s = serve(() => new Response(null, { status: 302, headers: { location: `${target.url}/models` } }));
    await expect(discoverModels({ baseUrl: s.url, apiKey: SECRET })).rejects.toThrow("redirect");
    expect(target.count()).toBe(0);
  });

  test("times out and cancels", async () => {
    const hang = serve(() => new Promise<Response>(() => {}));
    await expect(discoverModels({ baseUrl: hang.url }, { timeoutMs: 50 })).rejects.toThrow("in time");
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 30);
    await expect(discoverModels({ baseUrl: hang.url }, { signal: ctrl.signal })).rejects.toThrow("cancelled");
    const pre = AbortSignal.abort();
    await expect(discoverModels({ baseUrl: hang.url }, { signal: pre })).rejects.toThrow("cancelled");
  });

  test("rejects an invalid endpoint before any request", async () => {
    await expect(discoverModels({ baseUrl: "http://example.com" })).rejects.toThrow("not valid");
  });
});

describe("checkConnection", () => {
  test("passes a full round trip with exactly two requests and reports usage", async () => {
    const seen: Record<string, unknown>[] = [];
    let auth = "";
    const inner = wellBehaved({ prompt_tokens: 10, completion_tokens: 3 });
    const s = serve(async (req, n) => {
      auth = req.headers.get("authorization") ?? "";
      seen.push((await req.clone().json()) as Record<string, unknown>);
      return inner(req, n);
    });
    const check = await checkConnection({ baseUrl: s.url, model: "m1", apiKey: SECRET });
    expect(check.status).toBe("passed");
    expect(check.model).toBe("m1");
    expect(check.turns).toBe(2);
    expect(check.usage).toEqual({ status: "reported", inputObserved: 20, outputObserved: 6 });
    expect(s.count()).toBe(2);
    expect(auth).toBe(`Bearer ${SECRET}`);
    expect(check.summary).not.toMatch(/coding (is|ability) (supported|proven)/i);

    const [one, two] = seen as {
      stream: boolean;
      max_tokens: number;
      tools: unknown[];
      messages: Record<string, unknown>[];
    }[];
    if (!one || !two) throw new Error("Expected two requests");
    expect(one.stream).toBe(false);
    expect(one.max_tokens).toBe(256);
    expect(one.tools.length).toBe(1);
    expect(JSON.stringify(one.tools[0])).toContain('"additionalProperties":false');
    const marker = (two.messages[2] as { content: string }).content;
    expect(marker.length).toBeGreaterThan(8);
    expect(JSON.stringify(one)).not.toContain(marker);
    // Provider metadata is replayed.
    expect(two.messages[1]?.reasoning_details).toEqual([{ text: "think" }]);
    expect(two.messages[2]?.tool_call_id).toBe("call_1");
    // Nothing sensitive is in the result.
    const out = JSON.stringify(check);
    expect(out).not.toContain(marker);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("probe.txt");
  });

  test("validates input", async () => {
    await expect(checkConnection({ baseUrl: "http://example.com", model: "m" })).rejects.toThrow("not valid");
    for (const model of ["", "   ", "x".repeat(201), "a\nb"]) {
      await expect(checkConnection({ baseUrl: "http://127.0.0.1:1", model })).rejects.toThrow("model name");
    }
  });

  const callCases: [string, Record<string, unknown>, string][] = [
    ["a different tool", { tool_calls: [toolCall({ file_path: "probe.txt" }, "Bash")] }, "does not allow"],
    ["an escaping path", { tool_calls: [toolCall({ file_path: "../../etc/passwd" })] }, "does not allow"],
    ["an absolute path", { tool_calls: [toolCall({ file_path: "/etc/passwd" })] }, "does not allow"],
    ["extra keys", { tool_calls: [toolCall({ file_path: "probe.txt", offset: 1 })] }, "does not allow"],
    ["non-object args", { tool_calls: [toolCall("[1]")] }, "does not allow"],
    ["invalid json args", { tool_calls: [toolCall("{nope")] }, "does not allow"],
    [
      "parallel calls",
      {
        tool_calls: [
          toolCall({ file_path: "probe.txt" }, "Read", "a"),
          toolCall({ file_path: "probe.txt" }, "Read", "b"),
        ],
      },
      "does not allow",
    ],
  ];
  for (const [name, message, text] of callCases) {
    test(`denies ${name} without a second request`, async () => {
      const s = serve(() => reply({ content: null, ...message }));
      const check = await checkConnection({ baseUrl: s.url, model: "m" });
      expect(check.status).toBe("failed");
      expect(check.summary).toContain(text);
      expect(check.turns).toBe(1);
      expect(s.count()).toBe(1);
    });
  }

  test("fails when the model stops before calling the tool", async () => {
    const s = serve(() => reply({ content: "I cannot read files." }));
    const check = await checkConnection({ baseUrl: s.url, model: "m" });
    expect(check.status).toBe("failed");
    expect(check.summary).toContain("without using the synthetic tool");
    expect(check.summary).not.toContain("cannot read");
    expect(s.count()).toBe(1);
  });

  test("denies a repeated call and never makes a third request", async () => {
    const s = serve(() => reply({ content: null, tool_calls: [toolCall({ file_path: "probe.txt" })] }));
    const check = await checkConnection({ baseUrl: s.url, model: "m" });
    expect(check.status).toBe("failed");
    expect(check.summary).toContain("again");
    expect(s.count()).toBe(2);
  });

  test("fails on a wrong marker without echoing it", async () => {
    const s = serve((_req, n) =>
      n === 1
        ? reply({ content: null, tool_calls: [toolCall({ file_path: "probe.txt" })] })
        : reply({ content: "guess-xyz" }),
    );
    const check = await checkConnection({ baseUrl: s.url, model: "m" });
    expect(check.status).toBe("failed");
    expect(JSON.stringify(check)).not.toContain("guess-xyz");
  });

  test("reports unknown usage without fabricating zeros", async () => {
    const s = serve(wellBehaved());
    const check = await checkConnection({ baseUrl: s.url, model: "m" });
    expect(check.status).toBe("passed");
    expect(check.usage).toEqual({ status: "unknown", inputObserved: null, outputObserved: null });
  });

  test("reports partial usage when only some counters arrive", async () => {
    const inner = wellBehaved();
    const s = serve(async (req, n) => {
      const body = (await req.json()) as { messages: { role: string; content?: string }[] };
      if (n === 1) {
        return reply({ content: null, tool_calls: [toolCall({ file_path: "probe.txt" })] }, { prompt_tokens: 7 });
      }
      return reply(
        { content: body.messages.find((m) => m.role === "tool")?.content },
        { prompt_tokens: 9, completion_tokens: 2 },
      );
    });
    void inner;
    const check = await checkConnection({ baseUrl: s.url, model: "m" });
    expect(check.usage).toEqual({ status: "partial", inputObserved: 16, outputObserved: 2 });
  });

  test("keeps earlier counters when a later request fails", async () => {
    const s = serve((_req, n) =>
      n === 1
        ? reply(
            { content: null, tool_calls: [toolCall({ file_path: "probe.txt" })] },
            { prompt_tokens: 5, completion_tokens: 1 },
          )
        : new Response("nope", { status: 500 }),
    );
    const check = await checkConnection({ baseUrl: s.url, model: "m" });
    expect(check.status).toBe("failed");
    expect(check.turns).toBe(1);
    expect(check.usage).toEqual({ status: "reported", inputObserved: 5, outputObserved: 1 });
  });

  test("bounds each response at 64KiB", async () => {
    const s = serve(() => reply({ content: "x".repeat(70 * 1024) }));
    const check = await checkConnection({ baseUrl: s.url, model: "m" });
    expect(check.status).toBe("failed");
    expect(check.summary).toContain("too large");
  });

  test("failure results never carry the key, provider text or URL", async () => {
    const s = serve(() => new Response(`${SECRET} provider-detail`, { status: 401 }));
    const check = await checkConnection({ baseUrl: s.url, model: "m", apiKey: SECRET });
    const out = JSON.stringify(check);
    expect(check.status).toBe("failed");
    for (const leak of [SECRET, "provider-detail", "127.0.0.1"]) expect(out).not.toContain(leak);
  });

  test("does not follow redirects", async () => {
    const target = serve(wellBehaved());
    const s = serve(() => new Response(null, { status: 307, headers: { location: `${target.url}/chat/completions` } }));
    const check = await checkConnection({ baseUrl: s.url, model: "m", apiKey: SECRET });
    expect(check.status).toBe("failed");
    expect(target.count()).toBe(0);
    expect(s.count()).toBe(1);
  });

  test("times out while waiting", async () => {
    const s = serve(() => new Promise<Response>(() => {}));
    const check = await checkConnection({ baseUrl: s.url, model: "m" }, { timeoutMs: 60 });
    expect(check.status).toBe("failed");
    expect(check.summary).toContain("in time");
  });

  test("cancels promptly while waiting for a response", async () => {
    const s = serve(() => new Promise<Response>(() => {}));
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 30);
    const t = performance.now();
    const check = await checkConnection({ baseUrl: s.url, model: "m" }, { signal: ctrl.signal });
    expect(check.status).toBe("cancelled");
    expect(performance.now() - t).toBeLessThan(2000);
  });

  test("cancels promptly while reading a stalled body", async () => {
    const s = serve(
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('{"choices":['));
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 80);
    const t = performance.now();
    const check = await checkConnection({ baseUrl: s.url, model: "m" }, { signal: ctrl.signal });
    expect(check.status).toBe("cancelled");
    expect(performance.now() - t).toBeLessThan(2000);
  });

  test("an already-aborted signal makes no request", async () => {
    const s = serve(wellBehaved());
    const check = await checkConnection({ baseUrl: s.url, model: "m" }, { signal: AbortSignal.abort() });
    expect(check.status).toBe("cancelled");
    expect(s.count()).toBe(0);
  });

  test("clamps oversized timeouts without throwing", async () => {
    const s = serve(wellBehaved());
    const check = await checkConnection({ baseUrl: s.url, model: "m" }, { timeoutMs: Number.MAX_SAFE_INTEGER });
    expect(check.status).toBe("passed");
  });
});
