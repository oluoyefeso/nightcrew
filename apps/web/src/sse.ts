// A server-sent events reader on fetch, so the stream can carry the launch
// key in a header (EventSource can't send headers).

export interface SseMessage {
  event: string;
  data: string;
}

/**
 * Feed text chunks in, get whole messages out. Handles lines and messages
 * split across chunks, \n or \r\n line ends, comments and multi-line data.
 */
export function sseParser(onMessage: (m: SseMessage) => void) {
  let buf = "";
  let event = "";
  let data: string[] = [];
  return (chunk: string) => {
    buf += chunk;
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line === "") {
        if (data.length) onMessage({ event: event || "message", data: data.join("\n") });
        event = "";
        data = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
  };
}

/**
 * Read one SSE response to its end. Resolves with the HTTP status when the
 * server refused (non-2xx), or 200 once a stream that opened has closed.
 */
export async function readSse(
  url: string,
  init: RequestInit,
  onMessage: (m: SseMessage) => void,
  onOpen?: () => void,
): Promise<number> {
  const res = await fetch(url, { ...init, headers: { accept: "text/event-stream", ...init.headers } });
  if (!res.ok || !res.body) return res.status;
  onOpen?.();
  const feed = sseParser(onMessage);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    feed(decoder.decode(value, { stream: true }));
  }
  return 200;
}
