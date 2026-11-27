import { teamHubBaseUrl } from "./teamhub-base-url.js";

export interface WaitForTeamHubHealthOptions {
  fetcher?: typeof fetch;
  retryDelayMs?: number;
  requestTimeoutMs?: number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

/** Returns TeamHub's `/healthz` URL derived from `TEAMHUB_BASE_URL`. */
export function readTeamHubHealthUrl(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const baseUrl = teamHubBaseUrl(environment);
  return new URL("healthz", `${baseUrl.replace(/\/$/, "")}/`).toString();
}

/** Polls TeamHub's `/healthz` endpoint until it returns HTTP 2xx or `signal` aborts. */
export async function waitForTeamHubHealth(
  healthUrl: string,
  signal: AbortSignal,
  options: WaitForTeamHubHealthOptions = {},
): Promise<void> {
  const fetcher = options.fetcher ?? fetch;
  const retryDelayMs = options.retryDelayMs ?? 500;
  const requestTimeoutMs = options.requestTimeoutMs ?? 1_000;
  const sleep = options.sleep ?? delay;

  while (!signal.aborted) {
    try {
      const response = await fetcher(healthUrl, {
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(requestTimeoutMs),
        ]),
      });
      await response.body?.cancel().catch(() => undefined);
      if (response.ok) return;
    } catch {
      // TeamHub is still starting or reloading.
    }

    await sleep(retryDelayMs, signal);
  }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    const onAbort = (): void => finish();

    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }

    signal.addEventListener("abort", onAbort, { once: true });
  });
}
