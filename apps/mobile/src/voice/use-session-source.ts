// Voice outlives a single session: when the connection manager reconnects,
// the Bridge stream and the events stream resume on the next session. This
// hook hands them the open session, or waits for the next one.
import { useCallback, useEffect, useRef } from "react";

import { useComputer } from "../computer/computer-context";
import type { PhoneSession } from "../session/session";

export type SessionSource = (signal: AbortSignal) => Promise<PhoneSession>;

export function useSessionSource(): SessionSource {
  const { session, active } = useComputer();
  // A voice task belongs to the computer it started with; after a switch,
  // another computer's session must never carry its audio or credential.
  const hostId = useRef(active?.hostId);
  const mine = active?.hostId === hostId.current ? session : undefined;
  const current = useRef(mine);
  const waiters = useRef(new Set<(session: PhoneSession) => void>());

  useEffect(() => {
    current.current = mine;
    const session = mine;
    if (!session || session.closed) return;
    const waiting = [...waiters.current];
    waiters.current.clear();
    for (const wake of waiting) wake(session);
  }, [mine]);

  return useCallback(
    (signal) =>
      new Promise<PhoneSession>((resolve, reject) => {
        const open = current.current;
        if (open && !open.closed) {
          resolve(open);
          return;
        }
        const onAbort = () => {
          waiters.current.delete(wake);
          reject(new Error("aborted"));
        };
        const wake = (next: PhoneSession) => {
          signal.removeEventListener("abort", onAbort);
          resolve(next);
        };
        if (signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        waiters.current.add(wake);
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    [],
  );
}
