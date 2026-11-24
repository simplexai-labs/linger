import { Button } from "@/components/ui/button";
import { FormFeedback } from "@/components/ui/form-feedback";
import type { DesktopUpdate } from "@/features/auth/desktop-update";
import { commonMessages } from "@/i18n/common.messages";
import { useT } from "@/i18n/use-translation";

import { localModelsMessages as m } from "./local-models.messages";
import { formatMegabytes, type LocalModelsUpdate } from "./local-models-update";

/**
 * Lightweight banner for signed localmodels engine updates on this desktop
 * computer. Metadata checks happen silently; downloads only start when the
 * person clicks Update.
 */
export function LocalModelsUpdateBanner({
  desktopUpdate,
  engineUpdate,
  updatedVersion,
}: {
  desktopUpdate?: DesktopUpdate;
  engineUpdate?: LocalModelsUpdate;
  updatedVersion?: string | null;
}) {
  const t = useT();
  const state = engineUpdate?.state;

  if (updatedVersion && state?.kind === "idle") {
    return (
      <div
        className="mt-4 rounded-xl border border-border bg-muted px-3.5 py-2.5 text-sm text-foreground"
        role="status"
      >
        {t(m.engineUpdatedNotice, { version: updatedVersion })}
      </div>
    );
  }
  if (!engineUpdate || !state) return null;

  if (state.kind === "available") {
    return (
      <section
        aria-label={t(m.engineUpdateTitle, { version: state.version })}
        className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-muted/60 px-4 py-3"
      >
        <div className="min-w-48 flex-1">
          <p className="text-sm font-medium text-foreground">
            {t(m.engineUpdateTitle, { version: state.version })}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {state.summary
              ? t(m.sentences, {
                  first: state.summary,
                  second: t(m.engineUpdateSafeBody),
                })
              : t(m.engineUpdateSafeBody)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {state.hasNotes ? (
            <Button
              onClick={() => engineUpdate.openNotes()}
              size="compact"
              tone="ghost"
            >
              {t(m.engineReleaseNotes)}
            </Button>
          ) : null}
          <Button
            onClick={() => engineUpdate.install()}
            size="compact"
            tone="primary"
          >
            {t(m.engineUpdateAction)}
          </Button>
        </div>
      </section>
    );
  }

  if (state.kind === "requires_app_update") {
    return (
      <section
        aria-label={t(m.engineRequiresAppTitle, { version: state.version })}
        className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-muted/60 px-4 py-3"
      >
        <p className="min-w-48 flex-1 text-sm text-muted-foreground">
          {t(m.engineRequiresAppBody, {
            minVersion: state.minLingerVersion,
            version: state.version,
          })}
        </p>
        {desktopUpdate ? (
          <Button onClick={() => desktopUpdate.check()} size="compact">
            {t(m.engineCheckLingerUpdates)}
          </Button>
        ) : null}
      </section>
    );
  }

  if (state.kind === "downloading") {
    return (
      <p
        className="mt-4 rounded-xl bg-muted px-3.5 py-2.5 text-sm text-muted-foreground"
        role="status"
      >
        {state.total
          ? t(m.engineDownloadingProgress, {
              done: formatMegabytes(state.completed),
              total: formatMegabytes(state.total),
              version: state.version,
            })
          : t(m.engineDownloading, { version: state.version })}
      </p>
    );
  }

  if (state.kind === "verifying") {
    return (
      <p
        className="mt-4 rounded-xl bg-muted px-3.5 py-2.5 text-sm text-muted-foreground"
        role="status"
      >
        {t(m.engineVerifying, { version: state.version })}
      </p>
    );
  }

  if (state.kind === "waiting") {
    return (
      <p
        className="mt-4 rounded-xl bg-muted px-3.5 py-2.5 text-sm text-muted-foreground"
        role="status"
      >
        {t(m.engineWaiting, { version: state.version })}
      </p>
    );
  }

  if (state.kind === "applying") {
    return (
      <p
        className="mt-4 rounded-xl bg-muted px-3.5 py-2.5 text-sm text-muted-foreground"
        role="status"
      >
        {t(m.engineApplying, { version: state.version })}
      </p>
    );
  }

  if (state.kind === "failed") {
    return (
      <div className="mt-4">
        <FormFeedback tone="danger">
          <span className="flex flex-wrap items-center gap-2">
            <span>{t(m.engineUpdateFailed, { error: state.error })}</span>
            <button
              className="font-medium underline underline-offset-2"
              onClick={() => engineUpdate.check()}
              type="button"
            >
              {t(commonMessages.retry)}
            </button>
          </span>
        </FormFeedback>
      </div>
    );
  }

  return null;
}
