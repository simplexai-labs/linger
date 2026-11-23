// The Desktop passes the system proxy it resolved for Soniox under this name,
// not as HTTPS_PROXY, so that only TeamHub and node-services get it: every
// https call TeamHub makes to the outside (voice keys and file transcription,
// Composio, web search, connected-app file transfers) and the voice workers'
// Soniox and xAI websockets. The installer's own downloads, pnpm, the local
// models, LiveKit and the web server keep connecting as they did.
export const SYSTEM_PROXY_VARIABLE = "LINGER_SYSTEM_HTTPS_PROXY";

// Services reach each other over loopback, which a proxy must never carry.
const LOOPBACK = ["localhost", "127.0.0.1", "::1"];

/**
 * The variables TeamHub and node-services add to `env` for the system proxy:
 * none when the person set HTTPS_PROXY themselves (the services already
 * inherit it) or the Desktop found no system proxy. NO_PROXY keeps the
 * person's entries, under the name they used, and adds loopback.
 */
export function systemProxyEnvironment(
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  // Read by its literal name: the env inventory check finds only literal reads.
  const proxy = env.LINGER_SYSTEM_HTTPS_PROXY?.trim();
  if (!proxy || env.HTTPS_PROXY?.trim() || env.https_proxy?.trim()) return {};
  // Windows treats the two spellings as one variable; never set both.
  const noProxyName =
    env.NO_PROXY === undefined && env.no_proxy !== undefined
      ? "no_proxy"
      : "NO_PROXY";
  const entries = (env[noProxyName] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return {
    HTTPS_PROXY: proxy,
    [noProxyName]: [...new Set([...entries, ...LOOPBACK])].join(","),
  };
}
