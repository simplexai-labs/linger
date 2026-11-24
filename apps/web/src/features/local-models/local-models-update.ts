import { useEffect, useState } from "react";

export interface DesktopLocalModelsEngineInfo {
  readonly currentVersion: string;
  readonly source: "bundled" | "updated";
  readonly sourceCommit: string;
  readonly autoCheck: boolean;
}

export type DesktopLocalModelsUpdateState =
  | (DesktopLocalModelsEngineInfo & {
      readonly kind: "idle";
      readonly checkedAt?: string;
    })
  | (DesktopLocalModelsEngineInfo & { readonly kind: "checking" })
  | (DesktopLocalModelsEngineInfo & {
      readonly kind: "available";
      readonly version: string;
      readonly summary?: string;
      readonly hasNotes: boolean;
      readonly bytes: number;
    })
  | (DesktopLocalModelsEngineInfo & {
      readonly kind: "requires_app_update";
      readonly version: string;
      readonly minLingerVersion: string;
    })
  | (DesktopLocalModelsEngineInfo & {
      readonly kind: "downloading";
      readonly version: string;
      readonly completed: number;
      readonly total?: number;
    })
  | (DesktopLocalModelsEngineInfo & {
      readonly kind: "verifying" | "waiting" | "applying";
      readonly version: string;
    })
  | (DesktopLocalModelsEngineInfo & {
      readonly kind: "failed";
      readonly error: string;
    });

interface DesktopLocalModelsUpdateApi {
  getState(): Promise<DesktopLocalModelsUpdateState | null>;
  onState(
    callback: (state: DesktopLocalModelsUpdateState | null) => void,
  ): () => void;
  check(): Promise<void>;
  install(): Promise<void>;
  setAutoCheck(enabled: boolean): Promise<void>;
  openNotes(): Promise<void>;
}

export interface LocalModelsUpdate {
  readonly state: DesktopLocalModelsUpdateState | null | undefined;
  readonly updatedVersion: string | null;
  check(): void;
  install(): void;
  setAutoCheck(enabled: boolean): void;
  openNotes(): void;
}

function localModelsUpdateApi(): DesktopLocalModelsUpdateApi | undefined {
  return typeof window === "undefined"
    ? undefined
    : (
        window as {
          lingerDesktop?: {
            localModelsUpdate?: DesktopLocalModelsUpdateApi;
          };
        }
      ).lingerDesktop?.localModelsUpdate;
}

/**
 * Signed localmodels engine update bridge for this desktop computer, or
 * undefined in a browser or older desktop build.
 */
export function useLocalModelsUpdate(
  enabled = true,
  onApplied?: (version: string) => void,
): LocalModelsUpdate | undefined {
  const [api] = useState(localModelsUpdateApi);
  const [snapshot, setSnapshot] = useState<{
    state: DesktopLocalModelsUpdateState | null | undefined;
    updatedVersion: string | null;
  }>({ state: undefined, updatedVersion: null });

  useEffect(() => {
    if (!api || !enabled) return;
    let active = true;
    let previous: DesktopLocalModelsUpdateState | null | undefined;
    const applyNext = (next: DesktopLocalModelsUpdateState | null) => {
      const applied =
        previous?.kind === "applying" &&
        next?.kind === "idle" &&
        next.currentVersion !== previous.currentVersion
          ? next.currentVersion
          : null;
      previous = next;
      setSnapshot((current) => ({
        state: next,
        updatedVersion:
          applied ?? (next?.kind === "idle" ? current.updatedVersion : null),
      }));
      if (applied) onApplied?.(applied);
    };
    void api
      .getState()
      .then((next) => {
        if (active) applyNext(next);
      })
      .catch(() => undefined);
    const off = api.onState((next) => applyNext(next));
    return () => {
      active = false;
      off();
    };
  }, [api, enabled, onApplied]);

  if (!api || !enabled) return undefined;
  return {
    state: snapshot.state,
    updatedVersion: snapshot.updatedVersion,
    check: () => void api.check().catch(() => undefined),
    install: () => void api.install().catch(() => undefined),
    setAutoCheck: (next) => void api.setAutoCheck(next).catch(() => undefined),
    openNotes: () => void api.openNotes().catch(() => undefined),
  };
}

export function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
