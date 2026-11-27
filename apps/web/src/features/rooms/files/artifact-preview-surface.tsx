/* oxlint-disable react-doctor/no-create-object-url-without-revoke -- Preview URLs are revoked on normal cleanup and late-response races; download URLs are revoked immediately after the browser receives the click. */
import {
  ArrowExpand01Icon,
  ArrowShrink02Icon,
  Cancel01Icon,
  Download04Icon,
  FileNotFoundIcon,
  LinkSquare02Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { Spinner } from "@/components/ui/spinner";
import { Icon } from "@/components/ui/icon";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import { commonMessages } from "@/i18n/common.messages";
import { translate } from "@/i18n/language";
import { useT } from "@/i18n/use-translation";
import type {
  TeamHubDocument,
  TeamHubDocumentVersion,
} from "@/features/teamhub/teamhub-types";
import {
  DocumentActionsMenu,
  type RoomDocumentMenuActions,
} from "../documents/room-document-actions-menu";

import { ArtifactReadingViewport } from "./artifact-reading-viewport";
import { ArtifactContentRendererLoader } from "./artifact-content-renderer-loader";
import {
  downloadArtifactPreview,
  loadArtifactPreview,
  type LoadedArtifactPreview,
  triggerArtifactDownload,
} from "./artifact-preview-loader";
import { PreviewSessionExpiryNotice } from "./preview-session-expiry-notice";
import { resolveArtifactPreviewMediaType } from "./artifact-renderer-policy";
import { filePreviewMessages as m } from "./file-preview.messages";

export type DocumentPreviewTarget = Pick<
  TeamHubDocument,
  "current_version" | "id" | "title"
>;

export function ArtifactPreviewSurface({
  documentActions,
  fullScreen,
  knownVersion,
  node,
  onClose,
  openDocumentHref,
  onToggleFullScreen,
  variant = "default",
  versionId: requestedVersionId,
}: {
  documentActions?: RoomDocumentMenuActions;
  fullScreen?: boolean;
  knownVersion?: TeamHubDocumentVersion;
  node: DocumentPreviewTarget;
  onClose?: () => void;
  openDocumentHref?: string;
  onToggleFullScreen?: () => void;
  variant?: "default" | "sidebar";
  versionId?: string;
}) {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const [preview, setPreview] = useState<LoadedArtifactPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const activeTransferRef = useRef<AbortController | null>(null);
  const documentId = node.id;
  const versionId = requestedVersionId ?? node.current_version?.id;
  const displayName = preview?.version.filename ?? node.title;

  useEffect(() => {
    let active = true;
    let disposePreview: () => void = () => undefined;
    const controller = new AbortController();
    activeTransferRef.current = controller;

    setError(null);
    setPreview(null);

    if (!versionId) {
      setError(translate(m.noPublishedVersion));
      activeTransferRef.current = null;
      return () => controller.abort();
    }

    void loadArtifactPreview({
      client,
      documentId,
      knownVersion,
      signal: controller.signal,
      versionId,
    })
      .then((loadedPreview) => {
        if (!active) {
          loadedPreview.dispose();
          return;
        }
        disposePreview = loadedPreview.dispose;
        setPreview(loadedPreview);
      })
      .catch((loadError: unknown) => {
        if (active && !controller.signal.aborted) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : translate(m.previewLoadFailed),
          );
        }
      })
      .finally(() => {
        if (activeTransferRef.current === controller) {
          activeTransferRef.current = null;
        }
      });

    return () => {
      active = false;
      controller.abort();
      activeTransferRef.current?.abort();
      activeTransferRef.current = null;
      disposePreview();
    };
  }, [client, documentId, knownVersion, loadAttempt, versionId]);

  async function download() {
    const version = preview?.version;
    if (!version || isDownloading) {
      return;
    }

    const controller = new AbortController();
    activeTransferRef.current = controller;
    setError(null);
    setIsDownloading(true);
    try {
      const isHistoricalVersion =
        requestedVersionId && requestedVersionId !== node.current_version?.id;
      const blob = isHistoricalVersion
        ? await downloadArtifactPreview({
            client,
            preview,
            signal: controller.signal,
          })
        : (
            await client.downloadLatestDocument(documentId, {
              signal: controller.signal,
            })
          ).blob;
      triggerArtifactDownload(blob, version.filename);
    } catch (downloadError) {
      if (!controller.signal.aborted) {
        setError(
          downloadError instanceof Error
            ? downloadError.message
            : translate(m.downloadFailed),
        );
      }
    } finally {
      setIsDownloading(false);
      if (activeTransferRef.current === controller) {
        activeTransferRef.current = null;
      }
    }
  }

  function close() {
    activeTransferRef.current?.abort();
    onClose?.();
  }

  return (
    <section className="group/artifact relative flex h-full w-full flex-col overflow-hidden bg-app-surface">
      {variant === "sidebar" ? (
        <ArtifactPreviewSidebarActions
          displayName={displayName}
          isDownloading={isDownloading}
          onDownload={() => void download()}
          openDocumentHref={openDocumentHref}
          preview={preview}
        />
      ) : (
        <ArtifactPreviewHeader
          documentActions={documentActions}
          displayName={displayName}
          fullScreen={fullScreen}
          isDownloading={isDownloading}
          onClose={onClose ? close : undefined}
          onDownload={() => void download()}
          openDocumentHref={openDocumentHref}
          onToggleFullScreen={onToggleFullScreen}
          preview={preview}
        />
      )}

      {!error && preview ? (
        <PreviewSessionExpiryNotice
          expiresAt={preview.expiresAt}
          onRefresh={() => setLoadAttempt((attempt) => attempt + 1)}
        />
      ) : null}
      <ArtifactReadingViewport
        position={
          preview && ["text", "markdown"].includes(preview.decision.kind)
            ? preview.readingPosition
            : undefined
        }
      >
        {error ? (
          <PreviewFallback
            description={error}
            downloadPending={isDownloading}
            filename={displayName}
            onDownload={preview ? () => void download() : undefined}
            onRetry={
              versionId
                ? () => setLoadAttempt((attempt) => attempt + 1)
                : undefined
            }
          />
        ) : !preview ? (
          <div
            className="flex h-full items-center justify-center gap-2 text-sm text-app-muted"
            role="status"
          >
            <Spinner size={16} />
            {t(m.loadingPreview)}
          </div>
        ) : preview.decision.kind === "download" ? (
          <PreviewFallback
            description={preview.decision.reason ?? t(m.previewUnavailable)}
            downloadPending={isDownloading}
            filename={preview.version.filename}
            onDownload={() => void download()}
          />
        ) : (
          <ArtifactContentRendererLoader
            blob={preview.blob}
            filename={preview.version.filename}
            kind={preview.decision.kind}
            mediaType={resolveArtifactPreviewMediaType(
              preview.version.filename,
              preview.version.media_type,
            )}
            objectUrl={preview.objectUrl}
            onError={setError}
            previewUrl={preview.previewUrl}
            sourceSizeBytes={preview.sourceSizeBytes}
            readingPosition={preview.readingPosition}
            textContent={preview.textContent}
          />
        )}
      </ArtifactReadingViewport>
    </section>
  );
}

function ArtifactPreviewSidebarActions({
  displayName,
  isDownloading,
  onDownload,
  openDocumentHref,
  preview,
}: {
  displayName: string;
  isDownloading: boolean;
  onDownload: () => void;
  openDocumentHref?: string;
  preview: LoadedArtifactPreview | null;
}) {
  const t = useT();
  return (
    <div className="absolute right-2 top-2 z-10 flex items-center gap-0.5 rounded-md bg-popover p-0.5 opacity-0 shadow-md transition-opacity group-hover/artifact:opacity-100 focus-within:opacity-100">
      {openDocumentHref ? (
        <a
          aria-label={t(m.openDocument)}
          className="flex size-7 items-center justify-center rounded-sm text-app-muted transition-colors hover:bg-accent hover:text-app-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          href={openDocumentHref}
          title={t(m.openDocument)}
        >
          <Icon icon={LinkSquare02Icon} size={14} />
        </a>
      ) : null}
      <button
        aria-label={t(m.downloadFile, { name: displayName })}
        className="flex size-7 items-center justify-center rounded-sm text-app-muted transition-colors hover:bg-accent hover:text-app-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
        disabled={!preview || isDownloading}
        onClick={onDownload}
        title={t(m.download)}
        type="button"
      >
        <Icon icon={Download04Icon} size={14} />
      </button>
    </div>
  );
}

function ArtifactPreviewHeader({
  documentActions,
  displayName,
  fullScreen,
  isDownloading,
  onClose,
  onDownload,
  openDocumentHref,
  onToggleFullScreen,
  preview,
}: {
  documentActions?: RoomDocumentMenuActions;
  displayName: string;
  fullScreen?: boolean;
  isDownloading: boolean;
  onClose?: () => void;
  onDownload: () => void;
  openDocumentHref?: string;
  onToggleFullScreen?: () => void;
  preview: LoadedArtifactPreview | null;
}) {
  const t = useT();
  return (
    <header className="flex h-[58px] shrink-0 items-center justify-between gap-3 px-3 sm:px-4">
      <div className="min-w-0">
        <h2 className="truncate text-sm font-semibold">{displayName}</h2>
        {preview ? (
          <p className="mt-0.5 text-[12px] text-app-subtle">
            {t(m.versionDetails, {
              mediaType: preview.version.media_type,
              size: formatBytes(preview.version.size_bytes),
              version: preview.version.version_number,
            })}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {openDocumentHref ? (
          <a
            aria-label={t(m.openDocument)}
            className="ui-button-icon relative inline-flex shrink-0 items-center justify-center border border-transparent bg-transparent text-app-muted transition-colors duration-150 hover:bg-app-selected hover:text-app-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-focus focus-visible:ring-offset-1"
            href={openDocumentHref}
            title={t(m.openDocument)}
          >
            <Icon icon={LinkSquare02Icon} />
          </a>
        ) : null}
        {documentActions ? (
          <DocumentActionsMenu actions={documentActions} />
        ) : null}
        <Button
          aria-label={t(m.downloadFile, { name: displayName })}
          disabled={!preview || isDownloading}
          onClick={onDownload}
          size="icon"
          title={t(m.download)}
          tone="ghost"
        >
          <Icon icon={Download04Icon} />
        </Button>
        {onToggleFullScreen ? (
          <span className="hidden sm:block">
            <Button
              aria-label={t(fullScreen ? m.exitFullScreen : m.openFullScreen)}
              onClick={onToggleFullScreen}
              size="icon"
              title={t(fullScreen ? m.exitFullScreen : m.fullScreen)}
              tone="ghost"
            >
              {fullScreen ? (
                <Icon icon={ArrowShrink02Icon} />
              ) : (
                <Icon icon={ArrowExpand01Icon} />
              )}
            </Button>
          </span>
        ) : null}
        {onClose ? (
          <Button
            aria-label={t(m.closeFilePreview)}
            data-voice-close
            onClick={onClose}
            size="icon"
            title={t(commonMessages.close)}
            tone="ghost"
          >
            <Icon icon={Cancel01Icon} />
          </Button>
        ) : null}
      </div>
    </header>
  );
}

function PreviewFallback({
  description,
  downloadPending = false,
  filename,
  onDownload,
  onRetry,
}: {
  description: string;
  downloadPending?: boolean;
  filename: string;
  onDownload?: () => void;
  onRetry?: () => void;
}) {
  const t = useT();
  return (
    <div className="flex h-full items-center justify-center p-6 text-center">
      <div className="max-w-sm">
        <span className="mx-auto flex size-12 items-center justify-center rounded-lg bg-app-rail text-app-muted">
          <Icon icon={FileNotFoundIcon} size={20} />
        </span>
        <h3 className="mt-4 truncate text-sm font-semibold">{filename}</h3>
        <p className="mt-2 text-sm leading-6 text-app-muted">{description}</p>
        <div className="mt-5 flex items-center justify-center gap-2">
          {onRetry ? (
            <Button
              aria-label={t(m.retryPreview, { name: filename })}
              onClick={onRetry}
              title={t(m.retryPreview, { name: filename })}
              tone="secondary"
            >
              <Icon icon={RefreshIcon} />
              {t(commonMessages.retry)}
            </Button>
          ) : null}
          {onDownload ? (
            <Button disabled={downloadPending} onClick={onDownload}>
              <Icon icon={Download04Icon} />
              {t(downloadPending ? m.downloading : m.download)}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
