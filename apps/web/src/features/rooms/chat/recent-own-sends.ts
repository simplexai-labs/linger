/**
 * When this browser started showing each Message it just sent, by Message id.
 * The committed row continues the sending row's entrance from there instead
 * of jumping to its settled size.
 */
// Matches --chat-pop-duration.
export const OWN_ENTRANCE_MS = 450;

const startedAt = new Map<string, number>();

export function rememberOwnSend(messageId: string, sentAt: number) {
  // An entry only matters while its entrance can still continue, so drop
  // expired ones as newer sends arrive to keep the map bounded.
  for (const [id, started] of startedAt) {
    if (sentAt - started < OWN_ENTRANCE_MS) break;
    startedAt.delete(id);
  }
  startedAt.set(messageId, sentAt);
}

export function ownSendStartedAt(messageId: string): number | undefined {
  return startedAt.get(messageId);
}
