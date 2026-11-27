import { randomBytes } from "node:crypto";
import path from "node:path";
import { parseEnv } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { atomicPrivate, readPrivate } from "./instance.js";
import { freePort, portFree } from "./ports.js";
import {
  inspectNativeListeners,
  inspectNativeProcess,
  SERVICE_RESTART_POLICY,
  startNativeProcess,
} from "./native-process.js";

// The LiveKit server Native voice runs, as docker-compose.yml runs it for
// Docker: the voice workers and the browser meet there. Signalling listens on
// loopback only over HTTP/WebSocket (`httpPort`) and media uses UDP on
// `rtcPort` with ICE/TCP disabled so no wildcard TCP listener opens. On macOS
// and Linux, media UDP also binds loopback only; on Windows, libwebrtc clients
// and @livekit/rtc-node workers bind non-loopback interface sockets whenever
// one exists and Windows blocks cross-scope UDP between non-loopback sockets
// and 127.0.0.1, so LiveKit binds and advertises local interfaces alongside
// loopback with `use_ice_lite: true` (which skips LiveKit's auto-injected
// public STUN servers when `node_ip` is unset). Single-port UDPMux snapshots
// local interfaces at startup, so network changes on Windows require a LiveKit
// restart.
export interface LiveKitSettings {
  httpPort: number;
  rtcPort: number;
  apiKey: string;
  apiSecret: string;
}
const settingsFile = (root: string) => path.join(root, "livekit.env");

function parseSettings(text: string): LiveKitSettings | undefined {
  const values = parseEnv(text);
  const port = (value: string | undefined) => {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 1024 && number <= 65535
      ? number
      : undefined;
  };
  const httpPort = port(values.LIVEKIT_HTTP_PORT);
  const rtcPort = port(values.LIVEKIT_RTC_PORT);
  const apiKey = values.LIVEKIT_API_KEY;
  const apiSecret = values.LIVEKIT_API_SECRET;
  if (
    !httpPort ||
    !rtcPort ||
    !apiKey ||
    !/^[A-Za-z0-9]{8,64}$/.test(apiKey) ||
    !apiSecret ||
    !/^[A-Za-z0-9]{32,128}$/.test(apiSecret)
  )
    return undefined;
  return { httpPort, rtcPort, apiKey, apiSecret };
}
/** The instance's LiveKit ports and keys, when it has them. */
export async function readLiveKitSettings(
  root: string,
): Promise<LiveKitSettings | undefined> {
  const text = await readPrivate(settingsFile(root));
  return text === undefined ? undefined : parseSettings(text);
}
/**
 * The instance's LiveKit ports and keys, made once and kept in the
 * owner-only livekit.env so services and LiveKit agree across restarts.
 * `reserved` holds the ports other instances and services use. While
 * LiveKit is stopped, a port another program took since moves to a free one,
 * reported through `onMoved`.
 */
export async function prepareLiveKitSettings(
  root: string,
  reserved: Set<number>,
  onMoved?: (message: string) => void,
  platform: NodeJS.Platform = process.platform,
): Promise<LiveKitSettings> {
  const existing = await readLiveKitSettings(root);
  const rtcAllInterfaces = platform === "win32";
  let settings: LiveKitSettings;
  if (!existing)
    settings = {
      httpPort: await freePort(reserved),
      rtcPort: await freePort(reserved, {
        protocol: "udp",
        allInterfaces: rtcAllInterfaces,
      }),
      // LiveKit signs access tokens with the secret; it needs 32+ characters.
      apiKey: `API${randomBytes(6).toString("hex")}`,
      apiSecret: randomBytes(32).toString("hex"),
    };
  else if ((await inspectNativeProcess(root, "livekit")).running)
    return existing;
  else {
    settings = { ...existing };
    for (const [name, protocol, allInterfaces] of [
      ["httpPort", "tcp", false],
      ["rtcPort", "udp", rtcAllInterfaces],
    ] as const) {
      if (await portFree(existing[name], protocol, { allInterfaces })) continue;
      settings[name] = await freePort(reserved, { protocol, allInterfaces });
      onMoved?.(
        `Port ${existing[name]} is in use by another program; Linger's livekit uses port ${settings[name]} instead.\n`,
      );
    }
    if (
      settings.httpPort === existing.httpPort &&
      settings.rtcPort === existing.rtcPort
    )
      return existing;
  }
  await atomicPrivate(
    settingsFile(root),
    [
      `LIVEKIT_HTTP_PORT=${settings.httpPort}`,
      `LIVEKIT_RTC_PORT=${settings.rtcPort}`,
      `LIVEKIT_API_KEY=${settings.apiKey}`,
      `LIVEKIT_API_SECRET=${settings.apiSecret}`,
    ].join("\n") + "\n",
  );
  return settings;
}
/** The names TeamHub, node-services and the voice workers read, as in Docker. */
export function liveKitEnvironment(settings: LiveKitSettings) {
  return {
    LIVEKIT_URL: `ws://127.0.0.1:${settings.httpPort}`,
    LIVEKIT_API_URL: `http://127.0.0.1:${settings.httpPort}`,
    LIVEKIT_API_KEY: settings.apiKey,
    LIVEKIT_API_SECRET: settings.apiSecret,
  };
}
/**
 * The LiveKit configuration of docker-compose.yml for this instance's ports, as one line of
 * YAML (JSON) for --config-body: the command line records the ports, so a
 * change restarts LiveKit. No webhook, as in Docker; keys come from the
 * environment.
 */
export function liveKitConfig(
  settings: LiveKitSettings,
  platform: NodeJS.Platform = process.platform,
): string {
  const loopbackOnlyRtc = platform !== "win32";
  return JSON.stringify({
    port: settings.httpPort,
    bind_addresses: ["127.0.0.1"],
    rtc: {
      tcp_port: 0,
      udp_port: settings.rtcPort,
      use_external_ip: false,
      enable_loopback_candidate: true,
      ...(loopbackOnlyRtc
        ? { node_ip: "127.0.0.1", ips: { includes: ["127.0.0.1/32"] } }
        : { use_ice_lite: true }),
    },
    logging: { level: "info" },
  });
}
/** Whether LiveKit answers its health check (GET / is "OK"). */
export async function liveKitReady(
  root: string,
  settings: LiveKitSettings,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const [state] = await inspectNativeListeners(root, [
      { name: "livekit", port: settings.httpPort },
    ]);
    // Another process on the port would answer for a LiveKit that cannot
    // listen there.
    if (!state?.running || state.foreign !== undefined) return false;
    const response = await fetch(`http://127.0.0.1:${settings.httpPort}/`, {
      redirect: "error",
      signal: AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(2_000),
      ]),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}
/** Starts (or keeps) the instance's LiveKit and waits until it is healthy. */
export async function startNativeLiveKit(options: {
  root: string;
  executable: string;
  settings: LiveKitSettings;
  signal: AbortSignal;
  timeoutMs?: number;
}) {
  const { settings } = options;
  await startNativeProcess({
    root: options.root,
    name: "livekit",
    executable: options.executable,
    args: ["--config-body", liveKitConfig(settings)],
    cwd: path.join(options.root, "native"),
    // Only what a program needs to run, and the keys, never in its arguments.
    env: {
      PATH: process.env.PATH,
      ...(process.platform === "win32"
        ? { SystemRoot: process.env.SystemRoot }
        : {}),
      LIVEKIT_KEYS: `${settings.apiKey}: ${settings.apiSecret}`,
    },
    signal: options.signal,
    redactions: [settings.apiSecret],
    restartOnExit: SERVICE_RESTART_POLICY,
    restartOnConfigurationChange: true,
  });
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  for (;;) {
    if (await liveKitReady(options.root, settings, options.signal)) return;
    if (!(await inspectNativeProcess(options.root, "livekit")).running)
      throw new Error(
        `Native LiveKit stopped during startup. Inspect ${path.join(options.root, "native/logs/livekit.log")}.`,
      );
    if (Date.now() >= deadline)
      throw new Error(
        `Native LiveKit did not become ready. Inspect ${path.join(options.root, "native/logs/livekit.log")}.`,
      );
    await delay(250, undefined, { signal: options.signal });
  }
}
