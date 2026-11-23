import https from "node:https";
import { isIP } from "node:net";

/**
 * The HTTP CONNECT proxy that the provider websockets (Soniox, xAI) tunnel
 * through. LiveKit and TeamHub connections never use it.
 */
export interface ProviderProxy {
  httpsProxy: string;
  noProxy: string;
}

// The worker's own LiveKit and TeamHub peers, which a proxy must never carry.
const loopback = ["localhost", "127.0.0.1", "::1"];

/**
 * Node's NO_PROXY treats only `.example.com` as a domain suffix, while Go and
 * curl (TeamHub, the user's terminal) also treat `example.com` as one. Each
 * bare domain gets its dotted form so one NO_PROXY means the same everywhere.
 */
export function providerProxy(
  httpsProxy: string | undefined,
  noProxy: string | undefined,
): ProviderProxy | undefined {
  const proxy = httpsProxy?.trim();
  if (!proxy) return undefined;
  const entries = (noProxy ?? "")
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const domains = entries.flatMap((entry) =>
    entry === "*" ||
    entry.startsWith(".") ||
    entry.includes(":") ||
    isIP(entry) !== 0
      ? [entry]
      : [entry, `.${entry}`],
  );
  return {
    httpsProxy: proxy,
    noProxy: [...new Set([...domains, ...loopback])].join(","),
  };
}

/**
 * The agent for a provider websocket, or undefined to connect directly as
 * before. Only `wss:` can tunnel; Node rejects an https agent on `ws:`.
 * An unsupported proxy (socks5://, no scheme) is ignored by Node: direct.
 */
export function providerAgent(
  url: string | URL,
  proxy: ProviderProxy | undefined,
): https.Agent | undefined {
  if (!proxy || new URL(url).protocol !== "wss:") return undefined;
  return new https.Agent({
    proxyEnv: { HTTPS_PROXY: proxy.httpsProxy, NO_PROXY: proxy.noProxy },
  });
}
