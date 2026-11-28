import { formatBytes } from "@/lib/format-bytes";
import type { ReactNode } from "react";

import type { TeamHubMessageArtifactTreeSegment } from "@/features/teamhub/teamhub-types";
import type { Translate } from "@/i18n/language";
import { useT } from "@/i18n/use-translation";
import { cn } from "@/lib/cn";

import { chatMessages } from "../chat/chat.messages";

/**
 * One file in a chat Message, whatever attached it: an uploaded or delivered
 * file, a shared Document, or a published folder. It sits in a small white box
 * outside the text, as a compact raised card with the file icon, the name
 * and one detail line; the whole card opens or previews it.
 */
export function MessageFileItem({
  actionLabel = "Open",
  detail,
  disabled = false,
  name,
  onOpen,
  visual,
}: {
  actionLabel?: "Open" | "Preview";
  detail: string;
  disabled?: boolean;
  name: string;
  /** Absent when the file has nothing to open here. */
  onOpen?: () => void;
  /** The icon or thumbnail shown beside the name. */
  visual: ReactNode;
}) {
  const t = useT();
  const row = "flex w-full min-w-0 items-center gap-3 rounded-xl p-4 text-left";
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
        "w-[var(--chat-file-width)] max-w-full rounded-xl border border-app-border bg-card shadow-[var(--chat-card-shadow)]",
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
