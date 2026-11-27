// HTTP over a session: buffered requests for JSON and files, and an
// incremental stream for Server-Sent Events.
import { logEvent } from "../lib/app-log";
import { now, record, timed } from "../lib/timing";
import { concat } from "./noise";
import { utf8, utf8Bytes } from "./frames";
import { SessionClosed, type PhoneSession, type ResponseHead } from "./session";

export interface SessionResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, readonly string[]>>;
  readonly body: Uint8Array;
  /** Set when the body passed `maxBytes`; `body` is then empty. */
  readonly tooLarge?: boolean;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface RequestOptions {
  readonly headers?: Record<string, string>;
  readonly body?: Uint8Array | string;
  readonly signal?: AbortSignal;
  /** Stops reading past this many body bytes instead of holding them all. */
  readonly maxBytes?: number;
}

function headerMap(
  headers: Record<string, string> | undefined,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(headers ?? {}))
    out[name] = [value];
  return out;
}

/** Sends one request and buffers the whole response. */
export function sendRequest(
  session: PhoneSession,
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<SessionResponse> {
  return new Promise((resolve, reject) => {
    let head: ResponseHead | undefined;
    const chunks: Uint8Array[] = [];
    let received = 0;
    const body =
      typeof options.body === "string" ? utf8Bytes(options.body) : options.body;
    const headers = { ...options.headers };
    if (body) headers["Content-Length"] = String(body.length);
    const stream = session.openRequest(
      { method, path, headers: headerMap(headers) },
      {
        onResponse: (value) => {
          head = value;
        },
        onData: (chunk) => {
          received += chunk.length;
          if (options.maxBytes !== undefined && received > options.maxBytes) {
            options.signal?.removeEventListener("abort", onAbort);
            stream.reset();
            resolve({
              status: head?.status ?? 0,
              headers: head?.headers ?? {},
              body: new Uint8Array(0),
              tooLarge: true,
            });
            return;
          }
          chunks.push(chunk);
        },
        onEnd: () => {
          options.signal?.removeEventListener("abort", onAbort);
          if (!head) {
            reject(new SessionClosed("response without a head"));
            return;
          }
          resolve({
            status: head.status,
            headers: head.headers,
            body: concat(...chunks),
          });
        },
        onReset: (code) => {
          options.signal?.removeEventListener("abort", onAbort);
          reject(new SessionClosed(code));
        },
      },
    );
    const onAbort = () => {
      stream.reset();
      reject(new SessionClosed("aborted"));
    };
    options.signal?.addEventListener("abort", onAbort);
    void (async () => {
      try {
        if (body && body.length > 0) await stream.write(body);
        stream.end();
      } catch (error) {
        reject(error);
      }
    })();
  });
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string };
}

/** Sends a JSON request and parses a JSON response, throwing HttpError. */
export async function requestJson<T>(
  session: PhoneSession,
  method: string,
  path: string,
  options: {
    body?: unknown;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...options.headers,
  };
  let body: string | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  const started = now();
  const response = await sendRequest(session, method, path, {
    headers,
    body,
    signal: options.signal,
  });
  record("request.round_trip", now() - started);
  const text = utf8(response.body);
  if (response.status >= 400) {
    let envelope: ErrorEnvelope = {};
    try {
      envelope = JSON.parse(text) as ErrorEnvelope;
    } catch {
      // A body that is not the error envelope keeps the generic code.
    }
    // The path carries IDs, so only the method, status and code are kept.
    logEvent("warn", "request.failed", {
      method,
      status: response.status,
      code: envelope.error?.code,
    });
    throw new HttpError(
      response.status,
      envelope.error?.code ?? `HTTP_${response.status}`,
      envelope.error?.message ??
        `Request failed with status ${response.status}`,
    );
  }
  return (
    text ? timed("request.parse_json", () => JSON.parse(text)) : undefined
  ) as T;
}

export interface ServerSentEvent {
  readonly event: string;
  readonly data: string;
}

/**
 * Opens a Server-Sent Events request and calls onEvent for each event. The
 * returned function cancels it; onClose runs once when it ends for any reason.
 */
export function subscribe(
  session: PhoneSession,
  path: string,
  handlers: {
    onEvent(event: ServerSentEvent): void;
    onClose(reason: string): void;
    onStatus?(status: number): void;
  },
): () => void {
  let buffer = "";
  let closed = false;
  const close = (reason: string) => {
    if (closed) return;
    closed = true;
    handlers.onClose(reason);
  };
  const decoder = new TextDecoder();
  const stream = session.openRequest(
    { method: "GET", path, headers: { Accept: ["text/event-stream"] } },
    {
      onResponse: (head) => {
        handlers.onStatus?.(head.status);
        if (head.status !== 200) close(`HTTP_${head.status}`);
      },
      onData: (chunk) => {
        if (closed) return;
        buffer += decoder.decode(chunk, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          let event = "message";
          const data: string[] = [];
          for (const line of block.split("\n")) {
            if (line.startsWith(":")) continue;
            const colon = line.indexOf(":");
            const field = colon < 0 ? line : line.slice(0, colon);
            const value =
              colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
            if (field === "event") event = value;
            else if (field === "data") data.push(value);
          }
          if (data.length > 0)
            handlers.onEvent({ event, data: data.join("\n") });
          boundary = buffer.indexOf("\n\n");
        }
      },
      onEnd: () => close("ended"),
      onReset: (code) => close(code),
    },
  );
  stream.end();
  return () => {
    stream.reset();
    close("cancelled");
  };
}
