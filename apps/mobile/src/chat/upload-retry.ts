// An attachment upload can lose its session mid-flight, as when the phone
// moves from a Relay to the LAN. The retry must read the session anew: the
// one the upload started on is closed by then.

/**
 * Runs `send`, and once more after `delayMs` when the failure is one
 * `sessionLost` recognizes. `send` must look up the current session itself.
 */
export async function sendRetryingOnce<T>(
  send: () => Promise<T>,
  sessionLost: (error: unknown) => boolean,
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
  delayMs = 1_000,
): Promise<T> {
  try {
    return await send();
  } catch (error) {
    if (!sessionLost(error)) throw error;
    await wait(delayMs);
    return send();
  }
}
