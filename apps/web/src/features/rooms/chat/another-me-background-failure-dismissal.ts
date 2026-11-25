/**
 * Session-scoped in-memory dismissal of an Another Me background-failure
 * notice per Room. Dismissing hides the banner for the active failure reason
 * during the current session (including across Room switches), reappearing if
 * the reason changes, if TeamHub clears the streak (observed by RoomShell even
 * while viewing another Room), on sign-out, or on reload.
 */

const memory = new Map<string, string>();
const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeDismissedBackgroundFailures(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function keyFor(tenantId: string, roomId: string): string {
  return `${tenantId}:${roomId}`;
}

export function readDismissedBackgroundFailure(
  tenantId: string,
  roomId: string,
): string | undefined {
  return memory.get(keyFor(tenantId, roomId));
}

export function dismissBackgroundFailure(
  tenantId: string,
  roomId: string,
  reason: string,
): void {
  const trimmed = reason.trim();
  if (!trimmed) return;
  memory.set(keyFor(tenantId, roomId), trimmed);
  notifyListeners();
}

export function clearDismissedBackgroundFailure(
  tenantId: string,
  roomId: string,
): void {
  if (memory.delete(keyFor(tenantId, roomId))) {
    notifyListeners();
  }
}

export function clearAllDismissedBackgroundFailures(): void {
  if (memory.size === 0) return;
  memory.clear();
  notifyListeners();
}
