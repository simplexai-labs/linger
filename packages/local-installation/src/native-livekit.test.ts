import { createSocket } from "node:dgram";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  liveKitConfig,
  liveKitEnvironment,
  prepareLiveKitSettings,
  readLiveKitSettings,
  startNativeLiveKit,
} from "./native-livekit.js";
import {
  inspectNativeProcess,
  SERVICE_RESTART_POLICY,
  startNativeProcess,
  stopNativeProcess,
} from "./native-process.js";

vi.mock("./native-process.js", async (original) => {
  const actual = await original<typeof import("./native-process.js")>();
  return {
    ...actual,
    startNativeProcess: vi.fn(actual.startNativeProcess),
  };
});

const roots: string[] = [];
afterEach(async () => {
  vi.mocked(startNativeProcess).mockClear();
  for (const root of roots.splice(0)) {
    await stopNativeProcess(root, "livekit").catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
async function temp() {
  const root = await mkdtemp(path.join(tmpdir(), "native-livekit-"));
  roots.push(root);
  return root;
}

test("an instance keeps its LiveKit ports and keys in an owner-only file", async () => {
  const root = await temp();
  const reserved = new Set([1]);
  const settings = await prepareLiveKitSettings(root, reserved);
  expect(settings.httpPort).not.toBe(settings.rtcPort);
  expect(reserved).toEqual(new Set([1, settings.httpPort, settings.rtcPort]));
  expect(settings.apiSecret).toMatch(/^[a-f0-9]{64}$/);
  if (process.platform !== "win32")
    expect((await stat(path.join(root, "livekit.env"))).mode & 0o777).toBe(
      0o600,
    );
  expect(await prepareLiveKitSettings(root, new Set())).toEqual(settings);
  expect(await readLiveKitSettings(root)).toEqual(settings);
  // A damaged file is made again rather than half used.
  await writeFile(path.join(root, "livekit.env"), "LIVEKIT_HTTP_PORT=80\n");
  expect(await readLiveKitSettings(root)).toBeUndefined();
  expect(await prepareLiveKitSettings(root, new Set())).not.toEqual(settings);
});

test("LiveKit listens on loopback only on POSIX, with Docker's names for its address", () => {
  const settings = {
    httpPort: 30000,
    rtcPort: 30001,
    apiKey: "APIabcdef123456",
    apiSecret: "s".repeat(64),
  };
  expect(liveKitEnvironment(settings)).toEqual({
    LIVEKIT_URL: "ws://127.0.0.1:30000",
    LIVEKIT_API_URL: "http://127.0.0.1:30000",
    LIVEKIT_API_KEY: settings.apiKey,
    LIVEKIT_API_SECRET: settings.apiSecret,
  });
  for (const platform of ["darwin", "linux"] as const) {
    const config = liveKitConfig(settings, platform);
    expect(JSON.parse(config)).toEqual({
      port: 30000,
      bind_addresses: ["127.0.0.1"],
      // ICE/TCP would listen on every interface.
      rtc: {
        tcp_port: 0,
        udp_port: 30001,
        use_external_ip: false,
        node_ip: "127.0.0.1",
        enable_loopback_candidate: true,
        ips: { includes: ["127.0.0.1/32"] },
      },
      logging: { level: "info" },
    });
    expect(config).not.toContain(settings.apiSecret);
  }
});

test("LiveKit keeps signalling on loopback and advertises local interfaces with ICE-Lite on Windows", () => {
  const settings = {
    httpPort: 30000,
    rtcPort: 30001,
    apiKey: "APIabcdef123456",
    apiSecret: "s".repeat(64),
  };
  const config = liveKitConfig(settings, "win32");
  expect(JSON.parse(config)).toEqual({
    port: 30000,
    bind_addresses: ["127.0.0.1"],
    rtc: {
      tcp_port: 0,
      udp_port: 30001,
      use_external_ip: false,
      enable_loopback_candidate: true,
      use_ice_lite: true,
    },
    logging: { level: "info" },
  });
  expect(config).not.toContain(settings.apiSecret);
});

test("prepareLiveKitSettings moves a saved rtcPort taken on a non-loopback interface on Windows", async (context) => {
  let socket: ReturnType<typeof createSocket> | undefined;
  let takenPort: number | undefined;
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4" || !entry.address) continue;
      const candidate = createSocket("udp4");
      const bound = await new Promise<boolean>((resolve) => {
        candidate.once("error", () => {
          try {
            candidate.close();
          } catch {
            // Already closed.
          }
          resolve(false);
        });
        candidate.bind(0, entry.address, () => resolve(true));
      });
      if (!bound) continue;
      socket = candidate;
      takenPort = candidate.address().port;
      break;
    }
    if (takenPort !== undefined) break;
  }
  if (!socket || takenPort === undefined)
    return context.skip(
      "This computer has no bindable non-loopback IPv4 UDP address.",
    );
  try {
    const root = await temp();
    const initial = await prepareLiveKitSettings(
      root,
      new Set(),
      undefined,
      "darwin",
    );
    await writeFile(
      path.join(root, "livekit.env"),
      [
        `LIVEKIT_HTTP_PORT=${initial.httpPort}`,
        `LIVEKIT_RTC_PORT=${takenPort}`,
        `LIVEKIT_API_KEY=${initial.apiKey}`,
        `LIVEKIT_API_SECRET=${initial.apiSecret}`,
      ].join("\n") + "\n",
    );

    const posixMoved: string[] = [];
    const posixSettings = await prepareLiveKitSettings(
      root,
      new Set(),
      (message) => posixMoved.push(message),
      "darwin",
    );
    expect(posixSettings.rtcPort).toBe(takenPort);
    expect(posixMoved).toEqual([]);

    const winMoved: string[] = [];
    const winSettings = await prepareLiveKitSettings(
      root,
      new Set(),
      (message) => winMoved.push(message),
      "win32",
    );
    expect(winSettings.rtcPort).not.toBe(takenPort);
    expect(winMoved).toHaveLength(1);
    expect(winMoved[0]).toContain(`Port ${takenPort}`);
    expect((await readLiveKitSettings(root))?.rtcPort).toBe(
      winSettings.rtcPort,
    );
  } finally {
    await new Promise<void>((resolve) => socket.close(() => resolve()));
  }
});

test("startNativeLiveKit supervises exits with SERVICE_RESTART_POLICY", async () => {
  const root = await temp();
  const settings = await prepareLiveKitSettings(root, new Set());
  vi.mocked(startNativeProcess).mockRejectedValueOnce(
    new Error("stop-after-start"),
  );
  await expect(
    startNativeLiveKit({
      root,
      executable: path.join(root, "livekit-server"),
      settings,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("stop-after-start");
  expect(startNativeProcess).toHaveBeenCalledWith(
    expect.objectContaining({
      name: "livekit",
      restartOnExit: SERVICE_RESTART_POLICY,
      restartOnConfigurationChange: true,
    }),
  );
});

test.skipIf(process.platform === "win32")(
  "starts LiveKit, waits for its health check and never logs the secret",
  async () => {
    const root = await temp();
    const settings = await prepareLiveKitSettings(root, new Set());
    // A stand-in server: answers GET / with OK on the configured port and
    // prints the keys it was given.
    const server = path.join(root, "livekit-server");
    const code = `const port=JSON.parse(process.argv[1]).port;console.log(process.env.LIVEKIT_KEYS);require('node:http').createServer((q,s)=>s.end('OK')).listen(port,'127.0.0.1')`;
    await writeFile(
      server,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)} "$2"\n`,
      { mode: 0o755 },
    );
    await startNativeLiveKit({
      root,
      executable: server,
      settings,
      signal: new AbortController().signal,
    });
    expect(startNativeProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "livekit",
        restartOnExit: SERVICE_RESTART_POLICY,
      }),
    );
    expect((await inspectNativeProcess(root, "livekit")).running).toBe(true);
    const log = await readFile(
      path.join(root, "native/logs/livekit.log"),
      "utf8",
    );
    expect(log).toContain(settings.apiKey);
    expect(log).not.toContain(settings.apiSecret);
    await stopNativeProcess(root, "livekit");
    expect((await inspectNativeProcess(root, "livekit")).running).toBe(false);
  },
  15_000,
);
