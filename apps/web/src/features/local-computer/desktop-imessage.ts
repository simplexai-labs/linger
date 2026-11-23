import { useCallback, useEffect, useState } from "react";

// The iMessage part of the desktop shell API (`window.lingerDesktop.imessage`),
// present only in the macOS desktop app.
export interface DesktopIMessageStatus {
  readonly enabled: boolean;
  readonly handles: readonly string[];
  readonly runtime: "missing" | "installing" | "ready" | "failed";
  readonly runtimeError?:
    | "download_failed"
    | "checksum_mismatch"
    | "extract_failed"
    | "executable_missing";
  readonly fullDisk: "granted" | "denied" | "unknown" | "messagesNotSetUp";
  readonly messagesAutomation: "granted" | "denied" | "unknown";
  readonly iMessageSignedIn: "yes" | "no" | "unknown";
  readonly ready: boolean;
  readonly bridge:
    | "stopped"
    | "starting"
    | "running"
    | "signed_out"
    | "no_another_me"
    | "other_account"
    | "error";
}

export interface DesktopIMessagePatch {
  readonly enabled?: boolean;
  readonly handles?: readonly string[];
}

export type DesktopIMessageSetResult =
  | { readonly ok: true; readonly status: DesktopIMessageStatus }
  | {
      readonly ok: false;
      readonly code: "invalid_handle" | "too_many_handles";
      readonly message: string;
    };

// Why the last change or action did not go through, worded by the page.
export type DesktopIMessageError =
  | "invalid_handle"
  | "too_many_handles"
  | "failed";

export type DesktopIMessageAction =
  | "request_automation"
  | "open_full_disk_settings"
  | "open_automation_settings"
  | "retry_install";

export interface DesktopIMessageApi {
  getStatus(): Promise<DesktopIMessageStatus>;
  onStatus(callback: (status: DesktopIMessageStatus) => void): () => void;
  set(patch: DesktopIMessagePatch): Promise<DesktopIMessageSetResult>;
  act(action: DesktopIMessageAction): Promise<DesktopIMessageStatus>;
}

function desktopIMessageApi(): DesktopIMessageApi | undefined {
  return typeof window === "undefined"
    ? undefined
    : (window as { lingerDesktop?: { imessage?: DesktopIMessageApi } })
        .lingerDesktop?.imessage;
}

export interface DesktopIMessage {
  readonly status: DesktopIMessageStatus | undefined;
  readonly error: DesktopIMessageError | undefined;
  readonly pending: boolean;
  set(patch: DesktopIMessagePatch): Promise<boolean>;
  act(action: DesktopIMessageAction): void;
}

// iMessage on this Mac, or undefined in a browser and off macOS. The main
// process checks again on every status read, so the status refreshes on
// mount and whenever the window regains focus (after System Settings).
export function useDesktopIMessage(): DesktopIMessage | undefined {
  const [api] = useState(desktopIMessageApi);
  const [status, setStatus] = useState<DesktopIMessageStatus>();
  const [error, setError] = useState<DesktopIMessageError>();
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!api) return;
    let active = true;
    const refresh = (): void => {
      void api
        .getStatus()
        .then((next) => {
          if (active) setStatus(next);
        })
        .catch(() => undefined);
    };
    refresh();
    const off = api.onStatus((next) => setStatus(next));
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      off();
      window.removeEventListener("focus", refresh);
    };
  }, [api]);

  const set = useCallback(
    async (patch: DesktopIMessagePatch): Promise<boolean> => {
      if (!api) return false;
      setPending(true);
      setError(undefined);
      try {
        const result = await api.set(patch);
        if (!result.ok) {
          setError(result.code);
          return false;
        }
        setStatus(result.status);
        return true;
      } catch {
        setError("failed");
        return false;
      } finally {
        setPending(false);
      }
    },
    [api],
  );

  const act = useCallback(
    (action: DesktopIMessageAction) => {
      if (!api) return;
      setError(undefined);
      api
        .act(action)
        .then(setStatus)
        .catch(() => setError("failed"));
    },
    [api],
  );

  return api ? { status, error, pending, set, act } : undefined;
}
