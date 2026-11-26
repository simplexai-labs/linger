import type { ReactNode } from "react";

import { Spinner } from "@/components/ui/spinner";
import type { LocalModelsView } from "@/features/local-models/local-models-queries";
import {
  downloadStopped,
  isModelOnComputer,
  modelStatus,
} from "@/features/local-models/local-models-rules";
import type { Message } from "@/i18n/messages";
import { RichMessage, useT } from "@/i18n/use-translation";

import { computerSetupMessages as m } from "./computer-setup.messages";
import { computersMessages } from "./computers.messages";
import { LocalRuntimeAuthenticationGuidance } from "./local-runtime-authentication-guidance";
import type { SignInComputer } from "./local-runtime-commands";

export type PiLocalModelsState =
  | {
      readonly kind: "downloading";
      readonly modelName: string;
      readonly percent?: number;
    }
  | { readonly kind: "loading"; readonly modelName: string }
  | { readonly kind: "download_stopped"; readonly modelName: string }
  | { readonly kind: "no_local_model" }
  | { readonly kind: "models_installed" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "unknown" };

/**
 * Classifies a Computer's local-models library snapshot so Pi setup guidance
 * distinguishes a missing or downloading local model from a standalone CLI
 * credential requirement, using structured model states only.
 */
export function classifyPiLocalModelsState(
  view: LocalModelsView | undefined,
): PiLocalModelsState {
  if (!view) return { kind: "unknown" };
  if (!view.available) return { kind: "unavailable" };

  const downloading = view.models.find(
    (entry) => entry.model.state === "downloading",
  );
  if (downloading) {
    const progress = downloading.model.download;
    const percent =
      progress && progress.total_bytes > 0
        ? Math.min(
            100,
            Math.max(
              0,
              Math.round((progress.done_bytes / progress.total_bytes) * 100),
            ),
          )
        : undefined;
    return {
      kind: "downloading",
      modelName: downloading.model.name,
      percent,
    };
  }

  const loading = view.models.find((entry) => entry.model.state === "loading");
  if (loading) {
    return { kind: "loading", modelName: loading.model.name };
  }

  const hasInstalled = view.models.some((entry) =>
    isModelOnComputer(entry.model, modelStatus(entry.model)),
  );
  if (hasInstalled) {
    return { kind: "models_installed" };
  }

  const stopped = view.models.find((entry) => downloadStopped(entry.model));
  if (stopped) {
    return { kind: "download_stopped", modelName: stopped.model.name };
  }

  return { kind: "no_local_model" };
}

/**
 * Dropdown status message for Pi when its Runtime reports
 * `authentication_required`, refined by the Computer's local-models library.
 */
export function piAuthRequiredStatusMessage(
  state: PiLocalModelsState,
): Message<string> {
  switch (state.kind) {
    case "downloading":
      return computersMessages.statusDownloadingModel;
    case "loading":
      return computersMessages.statusLoadingModel;
    case "no_local_model":
    case "download_stopped":
      return computersMessages.statusModelNeeded;
    case "models_installed":
    case "unavailable":
    case "unknown":
      return computersMessages.statusSignInRequired;
  }
}

export interface PiRuntimeSetupGuidanceProps {
  readonly computer?: SignInComputer;
  readonly computerName: string;
  readonly isLoadingModels?: boolean;
  readonly modelsLink: (text: string) => ReactNode;
  readonly state: PiLocalModelsState;
}

/**
 * Guidance when Pi reports `authentication_required`. When the Computer has a
 * local-models library, explains whether a local model is downloading, loading,
 * stopped, or not yet downloaded and links directly to Settings › Models,
 * keeping standalone CLI sign-in under a secondary disclosure.
 */
export function PiRuntimeSetupGuidance({
  computer,
  computerName,
  isLoadingModels = false,
  modelsLink,
  state,
}: PiRuntimeSetupGuidanceProps) {
  const t = useT();

  if (isLoadingModels) {
    return (
      <div
        className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground"
        role="status"
      >
        <Spinner size={14} />
        <span>{t(m.piCheckingSetup, { computer: computerName })}</span>
      </div>
    );
  }

  if (state.kind === "downloading") {
    return (
      <div
        className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-app-body"
        role="status"
      >
        <p className="flex items-center gap-2 font-medium text-foreground">
          <Spinner size={14} />
          {t(m.piDownloadingTitle)}
        </p>
        <p className="mt-1 text-muted-foreground">
          {state.percent !== undefined ? (
            <RichMessage
              message={m.piDownloadingBodyWithPercent}
              tags={{ link: modelsLink }}
              values={{
                computer: computerName,
                model: state.modelName,
                percent: state.percent,
              }}
            />
          ) : (
            <RichMessage
              message={m.piDownloadingBody}
              tags={{ link: modelsLink }}
              values={{ computer: computerName, model: state.modelName }}
            />
          )}
        </p>
      </div>
    );
  }

  if (state.kind === "loading") {
    return (
      <div
        className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-app-body"
        role="status"
      >
        <p className="flex items-center gap-2 font-medium text-foreground">
          <Spinner size={14} />
          {t(m.piLoadingTitle)}
        </p>
        <p className="mt-1 text-muted-foreground">
          <RichMessage
            message={m.piLoadingBody}
            tags={{ link: modelsLink }}
            values={{ computer: computerName, model: state.modelName }}
          />
        </p>
      </div>
    );
  }

  if (
    state.kind === "no_local_model" ||
    state.kind === "download_stopped" ||
    state.kind === "models_installed"
  ) {
    return (
      <div
        className="rounded-lg border border-[var(--app-status-warning-border)] bg-[var(--app-status-warning-surface)] p-3 text-sm text-app-body"
        role="status"
      >
        {state.kind === "download_stopped" ? (
          <>
            <p className="font-medium text-foreground">
              {t(m.piDownloadStoppedTitle)}
            </p>
            <p className="mt-1 text-muted-foreground">
              <RichMessage
                message={m.piDownloadStoppedBody}
                tags={{ link: modelsLink }}
                values={{ computer: computerName, model: state.modelName }}
              />
            </p>
          </>
        ) : state.kind === "models_installed" ? (
          <>
            <p className="font-medium text-foreground">
              {t(m.piCredentialsOrSourceTitle)}
            </p>
            <p className="mt-1 text-muted-foreground">
              <RichMessage
                message={m.piCredentialsOrSourceBody}
                tags={{ link: modelsLink }}
                values={{ computer: computerName }}
              />
            </p>
          </>
        ) : (
          <>
            <p className="font-medium text-foreground">
              {t(m.piNeedsModelTitle)}
            </p>
            <p className="mt-1 text-muted-foreground">
              <RichMessage
                message={m.piNeedsModelBody}
                tags={{ link: modelsLink }}
                values={{ computer: computerName }}
              />
            </p>
          </>
        )}
        <details className="mt-2.5 border-t border-[var(--app-status-warning-border)]/70 pt-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none font-medium text-foreground/80 hover:text-foreground">
            {t(m.piStandaloneCliToggle)}
          </summary>
          <div className="mt-2 text-sm text-app-body">
            <LocalRuntimeAuthenticationGuidance
              computer={computer}
              computerName={computerName}
              runtimeType="pi"
            />
          </div>
        </details>
      </div>
    );
  }

  return (
    <div
      className="rounded-lg border border-[var(--app-status-warning-border)] bg-[var(--app-status-warning-surface)] p-3 text-sm text-app-body"
      role="status"
    >
      <LocalRuntimeAuthenticationGuidance
        computer={computer}
        computerName={computerName}
        runtimeType="pi"
      />
    </div>
  );
}
