import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { JsonLogger } from "@linger/service-kit/node";
import WebSocket, { WebSocketServer } from "ws";
import type { UpgradeHandler } from "../http-host.js";
import { hasBearerToken } from "../service-bearer-auth.js";

export const VOICE_BRIDGE_PATH = "/v1/voice-bridge";
/** The Bridge refuses larger messages; one phone audio message is 4.8 KB. */
const MAX_MESSAGE_BYTES = 64 * 1024;
const BRIDGE_CONNECT_TIMEOUT_MS = 5_000;

/**
 * Relays the Mobile Gateway's Voice Bridge socket to the Bridge worker, one
 * message for one message, keeping binary and text apart. Only TeamHub's
 * node-services credential opens it; the worker sees only this process's
 * per-run token and the phone the Gateway named.
 */
export function proxyVoiceBridge(options: {
  readonly credential: string | undefined;
  readonly target: () => { port: number; token: string } | undefined;
  readonly logger: JsonLogger;
  /** Open relayed sockets, so the role can end them when it stops. */
  readonly sockets: Set<{ terminate(): void }>;
}): UpgradeHandler {
  const server = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
  });
  return (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (
      !options.credential ||
      !hasBearerToken(request.headers.authorization, options.credential)
    ) {
      reject(socket, 401, "Unauthorized", "WWW-Authenticate: Bearer\r\n");
      return;
    }
    const target = options.target();
    if (!target) {
      reject(socket, 503, "Service Unavailable");
      return;
    }
    const phoneId = request.headers["x-linger-phone-id"];
    const upstream = new WebSocket(
      `ws://127.0.0.1:${target.port}${VOICE_BRIDGE_PATH}`,
      {
        headers: {
          authorization: `Bearer ${target.token}`,
          ...(typeof phoneId === "string"
            ? { "x-linger-phone-id": phoneId }
            : {}),
        },
        handshakeTimeout: BRIDGE_CONNECT_TIMEOUT_MS,
        maxPayload: MAX_MESSAGE_BYTES,
        perMessageDeflate: false,
      },
    );
    let opened = false;
    upstream.once("unexpected-response", (_request, response) => {
      const status = response.statusCode ?? 502;
      response.resume();
      upstream.terminate();
      reject(socket, status === 400 ? 400 : 502, "Bad Gateway");
    });
    upstream.once("error", (error) => {
      if (opened) return;
      options.logger.log("warn", "voice.bridge_unreachable", { error });
      reject(socket, 502, "Bad Gateway");
    });
    upstream.once("open", () => {
      opened = true;
      if (socket.destroyed) {
        upstream.close(1001, "phone left");
        return;
      }
      server.handleUpgrade(request, socket, head, (downstream) =>
        relay(downstream, upstream, options.sockets),
      );
    });
  };
}

function relay(
  downstream: WebSocket,
  upstream: WebSocket,
  sockets: Set<{ terminate(): void }>,
) {
  const pair = {
    terminate() {
      downstream.terminate();
      upstream.terminate();
    },
  };
  sockets.add(pair);
  const forward = (from: WebSocket, to: WebSocket) => {
    from.on("message", (data, isBinary) => {
      if (to.readyState === WebSocket.OPEN) to.send(data, { binary: isBinary });
    });
    from.once("close", (code) => {
      sockets.delete(pair);
      if (to.readyState === WebSocket.OPEN) to.close(sendableCode(code));
    });
    from.on("error", () => from.terminate());
  };
  forward(downstream, upstream);
  forward(upstream, downstream);
}

/** Codes such as 1005 and 1006 describe a missing close frame. */
function sendableCode(code: number) {
  return (code >= 1000 && code <= 1003) ||
    (code >= 1007 && code <= 1014) ||
    (code >= 3000 && code <= 4999)
    ? code
    : 1000;
}

function reject(socket: Duplex, status: number, reason: string, extra = "") {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n${extra}\r\n`,
  );
}
