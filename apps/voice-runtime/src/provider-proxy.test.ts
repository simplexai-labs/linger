import { once } from "node:events";
import net from "node:net";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { voiceTrackFailureCode } from "./livekit-worker.js";
import { providerAgent, providerProxy } from "./provider-proxy.js";
import { SonioxASRStream } from "./soniox.js";

describe("provider proxy settings", () => {
  it("is off without HTTPS_PROXY", () => {
    expect(providerProxy(undefined, "example.com")).toBeUndefined();
    expect(providerProxy("  ", undefined)).toBeUndefined();
  });

  it("adds dotted domains and loopback to NO_PROXY", () => {
    expect(
      providerProxy(
        " http://127.0.0.1:7890 ",
        "Soniox.com, .x.ai 10.0.0.1,*,host:8080",
      ),
    ).toEqual({
      httpsProxy: "http://127.0.0.1:7890",
      noProxy:
        "soniox.com,.soniox.com,.x.ai,10.0.0.1,*,host:8080,localhost,127.0.0.1,::1",
    });
    expect(providerProxy("http://p:1", undefined)?.noProxy).toBe(
      "localhost,127.0.0.1,::1",
    );
  });

  it("gives an agent only to wss URLs", () => {
    const proxy = providerProxy("http://127.0.0.1:7890", undefined);
    expect(providerAgent("wss://stt-rt.soniox.com/x", proxy)).toBeDefined();
    expect(providerAgent("ws://127.0.0.1:1/x", proxy)).toBeUndefined();
    expect(
      providerAgent("wss://stt-rt.soniox.com/x", undefined),
    ).toBeUndefined();
  });
});

describe("Soniox through HTTPS_PROXY", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((close) => close()));
  });

  async function listening(server: net.Server | WebSocketServer) {
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("missing listener");
    cleanup.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    return address.port;
  }

  // An HTTP CONNECT proxy that records each request line, then tunnels to a
  // plain WebSocket server (so TLS fails after the tunnel) or refuses.
  async function connectProxy(answer?: string) {
    const target = await listening(
      new WebSocketServer({ port: 0, host: "127.0.0.1" }),
    );
    const requests: string[] = [];
    const server = net.createServer((client) => {
      client.on("error", () => undefined);
      client.once("data", (head) => {
        requests.push(head.toString("latin1").split("\r\n")[0] ?? "");
        if (answer) {
          client.end(`HTTP/1.1 ${answer}\r\n\r\n`);
          return;
        }
        const upstream = net.connect(target, "127.0.0.1", () => {
          client.write("HTTP/1.1 200 Connection established\r\n\r\n");
          upstream.pipe(client).pipe(upstream);
        });
        upstream.on("error", () => client.destroy());
      });
    });
    server.listen(0, "127.0.0.1");
    const port = await listening(server);
    return { url: `http://127.0.0.1:${port}`, requests };
  }

  async function closedPort() {
    const server = net.createServer().listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as net.AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }

  const connectFailure = (
    webSocketUrl: string,
    httpsProxy: string,
    noProxy?: string,
  ) =>
    SonioxASRStream.connect(
      {
        apiKey: "test",
        model: "stt-rt-v6",
        webSocketUrl,
        proxy: providerProxy(httpsProxy, noProxy),
      },
      new AbortController().signal,
    ).then(
      async (stream) => {
        await stream.close();
        return "connected";
      },
      (error: unknown) => voiceTrackFailureCode(error),
    );

  // The reserved .invalid domain never resolves, so a direct attempt fails
  // with network_dns while a tunneled one reaches the proxy.
  const soniox = "wss://stt-rt.soniox.invalid/transcribe-websocket";

  it("tunnels the Soniox websocket through the proxy", async () => {
    const proxy = await connectProxy();
    await expect(connectFailure(soniox, proxy.url)).resolves.toBe(
      "network_tls",
    );
    expect(proxy.requests).toEqual([
      "CONNECT stt-rt.soniox.invalid:443 HTTP/1.1",
    ]);
  });

  it.each(["stt-rt.soniox.invalid", "soniox.invalid", ".soniox.invalid", "*"])(
    "connects directly when NO_PROXY is %s",
    async (noProxy) => {
      const proxy = await connectProxy();
      await expect(connectFailure(soniox, proxy.url, noProxy)).resolves.toBe(
        "network_dns",
      );
      expect(proxy.requests).toEqual([]);
    },
  );

  it("never sends a loopback or ws:// connection to the proxy", async () => {
    const proxy = await connectProxy();
    const local = await listening(
      new WebSocketServer({ port: 0, host: "127.0.0.1" }),
    );
    await expect(
      connectFailure(`ws://127.0.0.1:${local}`, proxy.url),
    ).resolves.toBe("connected");
    await expect(
      connectFailure(`wss://localhost:${await closedPort()}`, proxy.url),
    ).resolves.toBe("network_refused");
    expect(proxy.requests).toEqual([]);
  });

  it("reports a proxy that is not listening as network_refused", async () => {
    await expect(
      connectFailure(soniox, `http://127.0.0.1:${await closedPort()}`),
    ).resolves.toBe("network_refused");
  });

  it.each(["407 Proxy Authentication Required", "502 Bad Gateway"])(
    "reports a proxy answering %s as network_proxy",
    async (answer) => {
      const proxy = await connectProxy(answer);
      await expect(connectFailure(soniox, proxy.url)).resolves.toBe(
        "network_proxy",
      );
      expect(proxy.requests).toHaveLength(1);
    },
  );

  it("connects directly when the proxy is not an HTTP proxy", async () => {
    const proxy = await connectProxy();
    const socks = proxy.url.replace("http:", "socks5:");
    await expect(connectFailure(soniox, socks)).resolves.toBe("network_dns");
    expect(proxy.requests).toEqual([]);
  });
});
