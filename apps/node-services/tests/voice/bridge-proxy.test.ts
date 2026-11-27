import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { startHttpHost, type HttpHost } from "../../src/http-host.js";
import {
  proxyVoiceBridge,
  VOICE_BRIDGE_PATH,
} from "../../src/voice/bridge-proxy.js";

const credential = "node-services-internal-credential";
const bridgeToken = "per-process-bridge-token";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

/** A stand-in Bridge worker that echoes each message with its kind. */
async function fakeBridge() {
  const headers: IncomingHttpHeaders[] = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  server.on("connection", (socket, request) => {
    headers.push(request.headers);
    socket.on("message", (data, isBinary) =>
      socket.send(data, { binary: isBinary }),
    );
  });
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  );
  return { port: (server.address() as AddressInfo).port, headers };
}

async function proxyHost(
  target: () => { port: number; token: string } | undefined,
) {
  const host: HttpHost = await startHttpHost({ host: "127.0.0.1", port: 0 });
  const sockets = new Set<{ terminate(): void }>();
  host.mountUpgrade(
    VOICE_BRIDGE_PATH,
    proxyVoiceBridge({
      credential,
      target,
      logger: { log: vi.fn(), child: vi.fn() },
      sockets,
    }),
  );
  host.finishStartup();
  closers.push(async () => {
    for (const socket of sockets) socket.terminate();
    host.server.closeAllConnections();
    await host.close();
  });
  return host;
}

function open(
  host: HttpHost,
  headers: Record<string, string>,
  path = VOICE_BRIDGE_PATH,
) {
  const socket = new WebSocket(`ws://127.0.0.1:${host.port}${path}`, {
    headers,
  });
  return new Promise<WebSocket>((resolve, reject) => {
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

describe("Voice Bridge proxy", () => {
  it("opens only with the node-services credential", async () => {
    const bridge = await fakeBridge();
    const host = await proxyHost(() => ({
      port: bridge.port,
      token: bridgeToken,
    }));
    await expect(open(host, {})).rejects.toThrow(/401/);
    await expect(open(host, { authorization: "Bearer wrong" })).rejects.toThrow(
      /401/,
    );
    expect(bridge.headers).toHaveLength(0);
  });

  it("answers other upgrade paths 404 and a missing worker 503", async () => {
    const host = await proxyHost(() => undefined);
    const authorization = `Bearer ${credential}`;
    await expect(
      open(host, { authorization }, "/v1/elsewhere"),
    ).rejects.toThrow(/404/);
    await expect(open(host, { authorization })).rejects.toThrow(/503/);
  });

  it("relays text and binary messages to the worker with its own token", async () => {
    const bridge = await fakeBridge();
    const host = await proxyHost(() => ({
      port: bridge.port,
      token: bridgeToken,
    }));
    const phone = await open(host, {
      authorization: `Bearer ${credential}`,
      "x-linger-phone-id": "phone_1",
    });
    const received: Array<{ text: string; binary: boolean }> = [];
    phone.on("message", (data, isBinary) =>
      received.push({
        text: (data as Buffer).toString("utf8"),
        binary: isBinary,
      }),
    );
    phone.send(JSON.stringify({ type: "start" }));
    phone.send(Buffer.from("pcm"));
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received).toEqual([
      { text: '{"type":"start"}', binary: false },
      { text: "pcm", binary: true },
    ]);
    expect(bridge.headers[0]).toMatchObject({
      authorization: `Bearer ${bridgeToken}`,
      "x-linger-phone-id": "phone_1",
    });
    phone.close(1000);
  });
});
