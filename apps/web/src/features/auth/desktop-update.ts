import { useEffect, useState } from "react";

// The desktop app's updater (`window.lingerDesktop.update`), in the states
// its tray shows.
export type DesktopUpdateScope = "web" | "backend" | "shell";

export type DesktopUpdateState =
  | { readonly kind: "idle" }
  | { readonly kind: "checking" }
  | {
      readonly kind:
        | "downloading"
        | "ready"
        | "waiting"
        | "installing"
        | "available";
      readonly version: string;
      readonly scope?: DesktopUpdateScope;
    }
  | { readonly kind: "failed"; readonly error: string };

interface DesktopUpdateApi {
  getState(): Promise<DesktopUpdateState>;
  getInfo?(): Promise<{ readonly appVersion?: string }>;
  onState(callback: (state: DesktopUpdateState) => void): () => void;
  install(): Promise<void>;
  check(): Promise<void>;
}

interface DesktopShellApi {
  readonly version?: string;
  readonly update?: DesktopUpdateApi;
}

export interface DesktopUpdate {
  // The running desktop app's version.
  readonly version: string;
  // Undefined until the desktop answers, and in builds without an updater
  // bridge.
  readonly state: DesktopUpdateState | undefined;
  // Restart to Update, or open the download page when this installation
  // cannot apply the update itself.
  install(): void;
  check(): void;
}

function desktopShellApi(): DesktopShellApi | undefined {
  return typeof window === "undefined"
    ? undefined
    : (window as { lingerDesktop?: DesktopShellApi }).lingerDesktop;
}

/**
 * The desktop app's version and update, or undefined in a browser. The
 * desktop's updater decides everything; the page only shows its state and
 * forwards the person's choice.
 */
export function useDesktopUpdate(): DesktopUpdate | undefined {
  const [shell] = useState(desktopShellApi);
  const [state, setState] = useState<DesktopUpdateState>();
  const [appVersion, setAppVersion] = useState<string>();
  const api = shell?.update;

  useEffect(() => {
    if (!api) return;
    let active = true;
    const refreshVersion = () => {
      void api
        .getInfo?.()
        .then((info) => {
          if (active && info?.appVersion) setAppVersion(info.appVersion);
        })
        .catch(() => undefined);
    };
    void api
      .getState()
      .then((next) => {
        if (active) setState(next);
      })
      .catch(() => undefined);
    refreshVersion();
    const off = api.onState((next) => {
      setState(next);
      if (next.kind === "idle") refreshVersion();
    });
    return () => {
      active = false;
      off();
    };
  }, [api]);

  if (!shell?.version) return undefined;
  return {
    version: appVersion ?? shell.version,
    state,
    // A failure arrives as the next state, which the menu shows.
    install: () => void api?.install().catch(() => undefined),
    check: () => void api?.check().catch(() => undefined),
  };
}
