import { setTimeout as delay } from "node:timers/promises";

import { SYSTEM_PROXY_VARIABLE } from "@linger/local-installation/service-proxy";

// The voice websocket the services open; a PAC script is evaluated for it.
const SONIOX_URL = "wss://stt-rt.soniox.com/transcribe-websocket";
// A PAC or WPAD lookup can take seconds; startup never waits longer.
const RESOLVE_TIMEOUT_MS = 1_500;

/**
 * The proxy URL for Chromium's first choice in a resolveProxy answer such as
 * "PROXY 127.0.0.1:7890; DIRECT". DIRECT and SOCKS give none: the services'
 * proxy support tunnels through HTTP proxies only.
 */
export function proxyUrlFromResolution(resolution: string): string | undefined {
  const [scheme, address] = (resolution.split(";")[0] ?? "")
    .trim()
    .split(/\s+/);
  if (!address) return undefined;
  if (scheme === "PROXY") return `http://${address}`;
  if (scheme === "HTTPS") return `https://${address}`;
  return undefined;
}

export interface SystemProxy {
  /** Variables for the installer that starts the services. */
  readonly env: Record<string, string>;
  /** For the log only; never the address. */
  readonly source: "environment" | "system" | "none" | "unavailable";
}

/**
 * The system proxy for the installer, as `LINGER_SYSTEM_HTTPS_PROXY`, which
 * passes it only to TeamHub and node-services. A proxy the person set in the
 * app's environment wins and is inherited as it is.
 */
export async function systemProxy(
  env: NodeJS.ProcessEnv,
  resolveProxy: ((url: string) => Promise<string>) | undefined,
  timeoutMs = RESOLVE_TIMEOUT_MS,
): Promise<SystemProxy> {
  if (env.HTTPS_PROXY?.trim() || env.https_proxy?.trim())
    return { env: {}, source: "environment" };
  if (!resolveProxy) return { env: {}, source: "none" };
  const timeout = new AbortController();
  try {
    const resolution = await Promise.race([
      resolveProxy(SONIOX_URL),
      delay(timeoutMs, undefined, { ref: false, signal: timeout.signal }),
    ]);
    if (resolution === undefined) return { env: {}, source: "unavailable" };
    const proxy = proxyUrlFromResolution(resolution);
    return proxy
      ? { env: { [SYSTEM_PROXY_VARIABLE]: proxy }, source: "system" }
      : { env: {}, source: "none" };
  } catch {
    return { env: {}, source: "unavailable" };
  } finally {
    timeout.abort();
  }
}
