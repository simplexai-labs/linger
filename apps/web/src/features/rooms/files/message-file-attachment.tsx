import { Cancel01Icon, Download04Icon } from "@hugeicons/core-free-icons";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { FileTypeIcon } from "@/features/library/workspace-file-icon";
import { commonMessages } from "@/i18n/common.messages";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import { useT } from "@/i18n/use-translation";

import {
  loadArtifactPreview,
  triggerArtifactDownload,
} from "./artifact-preview-loader";
import {
  chatImageSize,
  localMessageImage,
  useDecodedImage,
} from "./local-message-images";
import {
  resolveArtifactPreviewMediaType,
  selectArtifactRenderer,
} from "./artifact-renderer-policy";
import {
  artifactFileTypeLabel,
  type ArtifactFileKind,
} from "./artifact-file-kind";
import { filePreviewMessages } from "./file-preview.messages";
import { fileItemDetail, MessageFileItem } from "./message-file-item";
import { chatMessages } from "../chat/chat.messages";
import { FileVoiceMaterialButton } from "../chat/voice-mode/file-voice-material-button";

/**
 * A Document-backed file in a Message. An image shows itself in the chat
 * and a video plays there; any other file, or media that cannot load, is a
 * MessageFileItem whose media type decides whether it previews or opens.
 * Every file that can open here can also be downloaded; an image opens in
 * a full-screen viewer.
 */
export function MessageFileAttachment({
  actionLabel,
  disabled = false,
  documentId,
  downloadFilename,
  filename,
  iconKind,
  mediaType,
  onOpen,
  previewEnabled = true,
  sizeBytes,
  sourceFilename = filename,
  typeLabel,
  versionId,
}: {
  /** Overrides the action the media type picks. */
  actionLabel?: "Open" | "Preview";
  disabled?: boolean;
  documentId?: string;
  /** The saved file's name; defaults to the stored file name. */
  downloadFilename?: string;
  /** The name people see, such as a Document's current title. */
  filename: string;
  iconKind?: ArtifactFileKind;
  mediaType?: string;
  onOpen: () => void;
  previewEnabled?: boolean;
  sizeBytes?: number;
  /** The stored file name, which with the media type decides previewability. */
  sourceFilename?: string;
  typeLabel?: string;
  versionId?: string;
}) {
  const t = useT();
  const renderer = selectArtifactRenderer({
    filename: sourceFilename,
    mediaType: mediaType ?? "",
    sizeBytes: sizeBytes ?? 0,
  }).kind;
  const canOpen = previewEnabled && !disabled;
  const download = useMessageFileDownload(
    canOpen ? documentId : undefined,
    downloadFilename ?? sourceFilename,
  );
  const image =
    canOpen && documentId && versionId && renderer === "image"
      ? { documentId, versionId }
      : undefined;
  const video =
    canOpen &&
    versionId &&
    renderer === "media" &&
    resolveArtifactPreviewMediaType(sourceFilename, mediaType ?? "").startsWith(
      "video/",
    )
      ? versionId
      : undefined;
  const icon = (
    <FileTypeIcon
      filename={sourceFilename}
      kind={iconKind}
      mediaType={mediaType}
    />
  );
  const item = (
    <MessageFileItem
      actionLabel={
        actionLabel ?? (renderer === "download" ? "Open" : "Preview")
      }
      detail={fileItemDetail(
        typeLabel ?? artifactFileTypeLabel(sourceFilename, mediaType, t),
        sizeBytes,
      )}
      disabled={disabled}
      downloadPending={download.pending}
      name={filename}
      onDownload={download.start}
      onOpen={canOpen ? onOpen : undefined}
      visual={icon}
    />
  );
  return (
    // The hover group is as wide as what it shows, so Add to voice centres
    // under a file item and under a narrower image alike.
    <div className="group/file relative w-fit max-w-full">
      {image ? (
        <MessageImage
          {...image}
          fallback={item}
          filename={filename}
          key={`${image.documentId}:${image.versionId}`}
          onDownload={download.start}
        />
      ) : video ? (
        <MessageVideo
          fallback={item}
          filename={filename}
          key={video}
          versionId={video}
        />
      ) : (
        item
      )}
      {download.failed ? (
        <p className="mt-1 text-xs text-destructive" role="alert">
          {t(chatMessages.downloadFileFailed, { name: filename })}
        </p>
      ) : null}
      {documentId && !disabled ? (
        <FileVoiceMaterialButton
          documentId={documentId}
          filename={filename}
          versionId={versionId}
        />
      ) : null}
    </div>
  );
}

/**
 * A video played in the chat at the size of an image. It streams from its
 * content URL, so only its metadata loads before someone plays it.
 */
function MessageVideo({
  fallback,
  filename,
  versionId,
}: {
  fallback: ReactNode;
  filename: string;
  versionId: string;
}) {
  const { client } = useTeamHubRuntime();
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let dispose = () => {};
    client.getDocumentVersionContentLocation(versionId).then(
      (location) => {
        if (!active) {
          location.dispose();
          return;
        }
        dispose = location.dispose;
        setUrl(location.url);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
      dispose();
    };
  }, [client, versionId]);

  if (failed) return fallback;
  return (
    <div className="w-fit max-w-[28rem] overflow-hidden rounded-xl bg-black">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- user-provided media has no caption track to reference */}
      <video
        aria-label={filename}
        className="block h-auto max-h-[360px] max-w-full"
        controls
        onError={() => setFailed(true)}
        playsInline
        preload="metadata"
        src={url}
      />
    </div>
  );
}

/**
 * Saves a Message file's latest content under `filename`. Absent
 * `documentId` means the file cannot be downloaded here.
 */
function useMessageFileDownload(
  documentId: string | undefined,
  filename: string,
) {
  const { client } = useTeamHubRuntime();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!documentId) return { failed: false, pending: false, start: undefined };
  const start = () => {
    if (pending) return;
    setPending(true);
    setFailed(false);
    client.downloadLatestDocument(documentId).then(
      (content) => {
        triggerArtifactDownload(content.blob, safeFilename(filename));
        setPending(false);
      },
      () => {
        setFailed(true);
        setPending(false);
      },
    );
  };
  return { failed, pending, start };
}

function safeFilename(filename: string) {
  return filename.replaceAll(/[\\/:*?"<>|]/g, "-");
}

/**
 * An image shown in the chat at a readable size; opening it shows it full
 * screen.
 */
function MessageImage({
  documentId,
  fallback,
  filename,
  onDownload,
  versionId,
}: {
  documentId: string;
  fallback: ReactNode;
  filename: string;
  onDownload?: () => void;
  versionId: string;
}) {
  const { client } = useTeamHubRuntime();
  const t = useT();
  const container = useRef<HTMLDivElement>(null);
  const localFile = localMessageImage(documentId);
  const local = useDecodedImage(localFile);
  // A local file past the remembered limit falls back to the download.
  const hasLocalFile = localFile !== undefined;
  const [objectUrl, setObjectUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [viewing, setViewing] = useState(false);

  useEffect(() => {
    let active = true;
    let started = false;
    let dispose = () => {};
    const controller = new AbortController();
    setObjectUrl(undefined);
    setFailed(false);
    if (hasLocalFile) return;

    async function load() {
      if (started) return;
      started = true;
      try {
        const preview = await loadArtifactPreview({
          client,
          documentId,
          signal: controller.signal,
          versionId,
        });
        if (!active) {
          preview.dispose();
          return;
        }
        if (preview.decision.kind !== "image" || !preview.objectUrl) {
          preview.dispose();
          setFailed(true);
          return;
        }
        dispose = preview.dispose;
        setObjectUrl(preview.objectUrl);
      } catch {
        if (active) setFailed(true);
      }
    }

    // Defer the authenticated Blob transfer until this item approaches the
    // viewport (including scrollable Threads).
    const observer =
      typeof IntersectionObserver === "undefined"
        ? undefined
        : new IntersectionObserver(
            (entries) => {
              if (entries.some((entry) => entry.isIntersecting)) {
                observer?.disconnect();
                void load();
              }
            },
            { rootMargin: "300px" },
          );
    if (observer && container.current) observer.observe(container.current);
    else void load();

    return () => {
      active = false;
      observer?.disconnect();
      controller.abort();
      dispose();
    };
  }, [client, documentId, hasLocalFile, versionId]);

  return (
    // Only as wide as the image, so an own Message can align it right.
    <div className="w-fit max-w-full" ref={container}>
      {failed ? (
        fallback
      ) : local || objectUrl ? (
        <button
          aria-label={t(chatMessages.previewFile, { name: filename })}
          className="block w-fit max-w-[28rem] overflow-hidden rounded-xl transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setViewing(true)}
          type="button"
        >
          <img
            alt={filename}
            className="block h-auto max-h-[360px] max-w-full object-contain"
            decoding="async"
            {...(local ? chatImageSize(local) : {})}
            onError={() => setFailed(true)}
            src={local?.url ?? objectUrl}
          />
        </button>
      ) : (
        <div
          aria-label={t(chatMessages.loadingFile, { name: filename })}
          className="flex h-40 w-80 max-w-full items-center justify-center rounded-xl bg-app-surface-soft text-sm text-app-muted"
          role="status"
        >
          {t(chatMessages.loadingImage)}
        </div>
      )}
      {viewing && (local || objectUrl) ? (
        <MessageImageViewer
          filename={filename}
          onClose={() => setViewing(false)}
          onDownload={onDownload}
          src={local?.url ?? objectUrl ?? ""}
        />
      ) : null}
    </div>
  );
}

/** A Message image at full size over a dimmed screen. */
function MessageImageViewer({
  filename,
  onClose,
  onDownload,
  src,
}: {
  filename: string;
  onClose: () => void;
  onDownload?: () => void;
  src: string;
}) {
  const t = useT();
  return (
    <ModalDialog
      ariaLabel={t(chatMessages.imageViewer, { name: filename })}
      className="chat-image-viewer flex items-center justify-center p-10"
      closeOnBackdrop
      onClose={onClose}
    >
      <img
        alt={filename}
        className="block max-h-full max-w-full rounded-lg object-contain shadow-2xl"
        src={src}
      />
      <div className="absolute top-4 right-4 flex gap-2">
        {onDownload ? (
          <Button
            aria-label={t(filePreviewMessages.downloadFile, { name: filename })}
            onClick={onDownload}
            size="icon"
            title={t(filePreviewMessages.download)}
            tone="subtle"
          >
            <Icon icon={Download04Icon} />
          </Button>
        ) : null}
        <Button
          aria-label={t(commonMessages.close)}
          onClick={onClose}
          size="icon"
          title={t(commonMessages.close)}
          tone="subtle"
        >
          <Icon icon={Cancel01Icon} />
        </Button>
      </div>
    </ModalDialog>
  );
}
