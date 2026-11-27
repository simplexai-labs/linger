import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { VoiceBridge, type BridgeOptions } from "./bridge.js";

export const voiceBridgePath = "/v1/voice-bridge";
const phoneIdPattern = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Serves the Voice Bridge socket and a health answer on one loopback port.
 * Only node-services, which proxies the Mobile Gateway's socket, holds the
 * per-process token.
 */
export async function startBridgeServer(
  options: BridgeOptions & { readonly port: number; readonly token: string },
) {
  const bridge = new VoiceBridge(options);
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    perMessageDeflate: false,
  });
  const server = createServer((request, response) => {
    response.writeHead(request.method === "GET" ? 200 : 405).end();
  });
  server.on(
    "upgrade",
    (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = new URL(request.url ?? "/", "http://bridge.local").pathname;
      if (path !== voiceBridgePath) {
        reject(socket, 404, "Not Found");
        return;
      }
      if (!bearerMatches(request.headers.authorization, options.token)) {
        reject(socket, 401, "Unauthorized");
        return;
      }
      const phoneId = request.headers["x-linger-phone-id"];
      if (typeof phoneId !== "string" || !phoneIdPattern.test(phoneId)) {
        reject(socket, 400, "Bad Request");
        return;
      }
      sockets.handleUpgrade(request, socket, head, (webSocket) =>
        bridge.accept(webSocket, phoneId),
      );
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    port: (server.address() as AddressInfo).port,
    bridge,
    async close() {
      server.close();
      await bridge.close();
      for (const client of sockets.clients) client.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      server.closeAllConnections();
    },
  };
}

function bearerMatches(header: string | undefined, token: string) {
  const match = /^Bearer (\S+)$/i.exec(header ?? "");
  if (!match?.[1]) return false;
  const digest = (value: string) =>
    createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(match[1]), digest(token));
}

function reject(socket: Duplex, status: number, reason: string) {
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}
