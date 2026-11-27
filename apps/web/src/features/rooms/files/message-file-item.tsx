import { Download04Icon } from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

import type { TeamHubMessageArtifactTreeSegment } from "@/features/teamhub/teamhub-types";
import type { Translate } from "@/i18n/language";
import { useT } from "@/i18n/use-translation";
import { cn } from "@/lib/cn";

import { chatMessages } from "../chat/chat.messages";
import { filePreviewMessages } from "./file-preview.messages";

/**
 * One file in a chat Message, whatever attached it: an uploaded or delivered
 * file, a shared Document, or a published folder. It sits in a small white box
 * outside the text, as a compact raised card with the file icon, the name
 * and one detail line; the whole card opens or previews it, and a download
 * button at its end saves the file when the caller offers one.
 */
export function MessageFileItem({
  actionLabel = "Open",
  detail,
  disabled = false,
  downloadPending = false,
  name,
  onDownload,
  onOpen,
  visual,
}: {
  actionLabel?: "Open" | "Preview";
  detail: string;
  disabled?: boolean;
  downloadPending?: boolean;
  name: string;
  /** Absent when the file cannot be downloaded here. */
  onDownload?: () => void;
  /** Absent when the file has nothing to open here. */
  onOpen?: () => void;
  /** The icon or thumbnail shown beside the name. */
  visual: ReactNode;
}) {
  const t = useT();
  const download = onDownload && !disabled;
  const row = cn(
    "flex w-full min-w-0 items-center gap-3 rounded-xl p-4 text-left",
    download && "pr-14",
  );
  const content = (
    <>
      <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden">
        {visual}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-app-ink">{name}</span>
        <span className="mt-0.5 block truncate text-xs text-app-muted">
          {detail}
        </span>
      </span>
    </>
  );
  return (
    <div
      className={cn(
        "relative w-[var(--chat-file-width)] max-w-full rounded-xl border border-app-border bg-card shadow-[var(--chat-card-shadow)]",
        disabled && "opacity-55",
      )}
      data-message-file-item
    >
      {disabled ? (
        <button
          aria-label={t(chatMessages.fileUnavailable, { name })}
          className={cn(row, "cursor-not-allowed")}
          disabled
          type="button"
        >
          {content}
        </button>
      ) : onOpen ? (
        <button
          aria-label={t(
            actionLabel === "Open"
              ? chatMessages.openFile
              : chatMessages.previewFile,
            { name },
          )}
          className={cn(
            row,
            "group/item transition-colors duration-150 hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary/40 motion-reduce:transition-none",
          )}
          onClick={onOpen}
          type="button"
        >
          {content}
        </button>
      ) : (
        <div aria-label={name} className={row} role="group">
          {content}
        </div>
      )}
      {download ? (
        <span className="absolute top-1/2 right-3 flex -translate-y-1/2">
          <Button
            aria-label={t(filePreviewMessages.downloadFile, { name })}
            loading={downloadPending}
            onClick={onDownload}
            size="icon"
            title={t(filePreviewMessages.download)}
            tone="ghost"
          >
            {downloadPending ? null : <Icon icon={Download04Icon} />}
          </Button>
        </span>
      ) : null}
    </div>
  );
}

/** "Markdown · 12 KB", or just the type when the size is unknown. */
export function fileItemDetail(typeLabel: string, sizeBytes?: number) {
  return sizeBytes ? `${typeLabel} · ${formatBytes(sizeBytes)}` : typeLabel;
}

/** "7 files · 3 folders · 80 KB" for a published folder. */
export function artifactTreeDetail(
  segment: TeamHubMessageArtifactTreeSegment,
  t: Translate,
) {
  return [
    t(chatMessages.fileCount, { count: segment.file_count }),
    t(chatMessages.folderCount, { count: segment.directory_count }),
    formatBytes(segment.total_bytes),
  ].join(" · ");
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
