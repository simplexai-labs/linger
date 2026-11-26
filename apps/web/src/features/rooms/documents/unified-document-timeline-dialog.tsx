import { formatDateTime } from "@/lib/date-format";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Cancel01Icon,
  RotateLeft01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { Spinner } from "@/components/ui/spinner";
import { Icon } from "@/components/ui/icon";
import { useMemo, useState } from "react";

import { ReadOnlyBlockNoteDocumentLoader } from "@/components/read-only-blocknote-document-loader";
import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { documentQueryKey } from "@/features/rooms/room-queries";
import type { TeamHubDocumentHistoryEntry } from "@/features/teamhub/teamhub-types";
import { ActorAvatar } from "@/features/rooms/members/actor-avatar";
import { formatLocale, translate, type Translate } from "@/i18n/language";
import { useT, useTranslation } from "@/i18n/use-translation";

import { diffDocumentLines } from "./document-history-diff";
import { historyRevisionMarkdown } from "./document-history-revision";
import { documentPageMessages as m } from "./document-page.messages";

const checkpointDate: Intl.DateTimeFormatOptions = {
  dateStyle: "medium",
  timeStyle: "short",
};

export function UnifiedDocumentTimelineDialog({
  client,
  documentId,
  onClose,
  tenantId,
}: {
  client: TeamHubClient;
  documentId: string;
  onClose: () => void;
  tenantId: string;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(
    null,
  );
  const [restoreFeedback, setRestoreFeedback] = useState<string | null>(null);
  const [highlightChanges, setHighlightChanges] = useState(true);
  const historyQueryKey = [
    "teamhub",
    "document",
    documentId,
    "history",
  ] as const;
  const history = useQuery({
    queryFn: () =>
      teamHubData(
        client.api.GET("/v0/documents/{documentId}/history", {
          params: { path: { documentId } },
        }),
      ),
    queryKey: historyQueryKey,
  });
  const selectedHistory =
    history.data?.items.find((entry) => entry.id === selectedHistoryId) ??
    history.data?.items[0];
  const selectedHistoryIndex = selectedHistory
    ? (history.data?.items.findIndex(
        (entry) => entry.id === selectedHistory.id,
      ) ?? -1)
    : -1;
  const previousHistory =
    selectedHistoryIndex >= 0
      ? history.data?.items[selectedHistoryIndex + 1]
      : undefined;
  const selectedHistoryContent = useHistoryMarkdown(client, selectedHistory);
  const previousHistoryContent = useHistoryMarkdown(client, previousHistory);
  const historyDiff = useMemo(() => {
    if (
      !highlightChanges ||
      selectedHistoryContent.data === undefined ||
      previousHistoryContent.data === undefined
    ) {
      return undefined;
    }
    return diffDocumentLines(
      previousHistoryContent.data,
      selectedHistoryContent.data,
    );
  }, [
    highlightChanges,
    previousHistoryContent.data,
    selectedHistoryContent.data,
  ]);
  const restore = useMutation({
    mutationFn: () => {
      if (!selectedHistory) throw new Error("No checkpoint is selected.");
      return teamHubData(
        client.api.POST(
          "/v0/documents/{documentId}/history/{historyEntryId}/restore",
          {
            params: {
              path: { documentId, historyEntryId: selectedHistory.id },
            },
          },
        ),
      );
    },
    onSuccess: async (result) => {
      setRestoreFeedback(
        result.status === "already_current"
          ? translate(m.alreadyCurrent)
          : translate(m.restored),
      );
      if (result.status === "restored") {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: historyQueryKey }),
          queryClient.invalidateQueries({
            queryKey: documentQueryKey(tenantId, documentId),
          }),
        ]);
      }
    },
  });
  return (
    <ModalDialog
      ariaLabel={t(m.pageHistory)}
      className="fixed inset-0 z-50 m-0 max-h-none max-w-none overflow-hidden border-0 bg-popover p-0 shadow-lg backdrop:bg-[var(--app-overlay)] backdrop:backdrop-blur-sm sm:inset-0 sm:m-auto sm:h-[min(640px,82dvh)] sm:w-[calc(100%-2.5rem)] sm:max-w-3xl sm:rounded-[var(--app-modal-radius)]"
      onClose={onClose}
    >
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-app-border px-4">
          <h2 className="text-sm font-semibold text-app-ink">
            {t(m.pageHistory)}
          </h2>
          <div>
            <Button
              aria-label={t(m.closePageHistory)}
              data-voice-close
              onClick={onClose}
              size="icon"
              tone="ghost"
            >
              <Icon icon={Cancel01Icon} />
            </Button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden">
          <div className="grid h-full min-h-0 sm:grid-cols-[200px_minmax(0,1fr)]">
            <aside className="workspace-scrollbar min-h-0 overflow-y-auto border-b border-app-border p-3 sm:border-r sm:border-b-0">
              <TimelineList
                empty={t(m.noPageHistory)}
                error={history.error}
                items={history.data?.items ?? []}
                onSelect={setSelectedHistoryId}
                pending={history.isPending}
                selectedId={selectedHistory?.id}
              />
            </aside>
            <HistoryPreview
              diff={historyDiff}
              entry={selectedHistory}
              error={
                selectedHistoryContent.error ?? previousHistoryContent.error
              }
              highlightChanges={highlightChanges}
              loading={
                selectedHistoryContent.isPending ||
                (highlightChanges &&
                  previousHistory !== undefined &&
                  previousHistoryContent.isPending)
              }
              markdown={selectedHistoryContent.data}
              onHighlightChanges={setHighlightChanges}
              onRestore={() => restore.mutate()}
              previousEntry={previousHistory}
              restoreError={restore.error}
              restoreFeedback={restoreFeedback}
              restorePending={restore.isPending}
            />
          </div>
        </div>
      </div>
    </ModalDialog>
  );
}

function useHistoryMarkdown(
  client: TeamHubClient,
  entry: TeamHubDocumentHistoryEntry | undefined,
) {
  return useQuery({
    enabled: entry !== undefined,
    queryFn: async () => {
      if (!entry) throw new Error("No checkpoint is selected.");
      const content = await teamHubData(
        client.api.GET("/v0/document-history/{historyEntryId}/content", {
          params: { path: { historyEntryId: entry.id } },
        }),
      );
      if (content.history_entry.id !== entry.id) {
        throw new Error(translate(m.revisionInconsistent));
      }
      return historyRevisionMarkdown(
        content.state_bytes,
        content.state_bytes_sha256,
      );
    },
    queryKey: ["teamhub", "document-history", entry?.id, "markdown"],
  });
}

function HistoryPreview({
  diff,
  entry,
  error,
  highlightChanges,
  loading,
  markdown,
  onHighlightChanges,
  onRestore,
  previousEntry,
  restoreError,
  restoreFeedback,
  restorePending,
}: {
  diff: ReturnType<typeof diffDocumentLines> | undefined;
  entry: TeamHubDocumentHistoryEntry | undefined;
  error: Error | null;
  highlightChanges: boolean;
  loading: boolean;
  markdown: string | undefined;
  onHighlightChanges: (value: boolean) => void;
  onRestore: () => void;
  previousEntry: TeamHubDocumentHistoryEntry | undefined;
  restoreError: Error | null;
  restoreFeedback: string | null;
  restorePending: boolean;
}) {
  const { language, t } = useTranslation();
  return (
    <section
      aria-label={t(m.historyPreview)}
      className="flex min-h-0 min-w-0 flex-col"
    >
      {entry ? (
        <div className="flex min-h-12 shrink-0 items-center justify-between gap-3 border-b border-app-border px-4">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-app-ink">
              {formatDateTime(
                entry.created_at,
                checkpointDate,
                formatLocale(language),
              )}
            </p>
            <p className="truncate text-xs text-app-muted">
              {historyActors(entry, t)}
            </p>
          </div>
          {previousEntry ? (
            <label className="flex shrink-0 items-center gap-2 text-xs text-app-body">
              <input
                checked={highlightChanges}
                onChange={(event) =>
                  onHighlightChanges(event.currentTarget.checked)
                }
                type="checkbox"
              />
              {t(m.highlightChanges)}
            </label>
          ) : null}
        </div>
      ) : null}
      <div className="workspace-scrollbar min-h-0 flex-1 overflow-y-auto">
        {!entry ? (
          <div className="flex h-full items-center justify-center p-8 text-center text-sm text-app-muted">
            {t(m.selectCheckpoint)}
          </div>
        ) : loading ? (
          <div
            className="flex h-full items-center justify-center gap-2 text-sm text-app-muted"
            role="status"
          >
            <Spinner size={16} />
            {t(m.loadingCheckpoint)}
          </div>
        ) : error ? (
          <p className="p-8 text-center text-sm text-app-danger" role="alert">
            {error.message}
          </p>
        ) : diff?.some((line) => line.kind !== "equal") ? (
          <HistoryDiff lines={diff} />
        ) : markdown ? (
          <div className="mx-auto max-w-[760px] px-6 py-8">
            <ReadOnlyBlockNoteDocumentLoader
              ariaLabel={t(m.historicalContent)}
              markdown={markdown}
            />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center p-8 text-sm text-app-muted">
            {diff ? (
              <span className="flex items-center gap-2">
                <Icon icon={Tick02Icon} size={14} />
                {t(m.checkpointIdentical)}
              </span>
            ) : (
              t(m.checkpointEmpty)
            )}
          </div>
        )}
      </div>
      {entry ? (
        <div className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-t border-app-border px-4 py-2">
          <div className="min-w-0">
            {restoreFeedback ? (
              <p className="text-sm text-app-muted" role="status">
                {restoreFeedback}
              </p>
            ) : null}
            {restoreError ? (
              <p className="text-sm text-app-danger" role="alert">
                {restoreError.message}
              </p>
            ) : null}
          </div>
          <Button
            data-voice-risk="confirm"
            disabled={restorePending}
            onClick={onRestore}
            tone="primary"
          >
            {restorePending ? (
              <Spinner size={14} />
            ) : (
              <Icon icon={RotateLeft01Icon} size={14} />
            )}
            {t(m.restoreCheckpoint)}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function HistoryDiff({
  lines,
}: {
  lines: ReturnType<typeof diffDocumentLines>;
}) {
  return (
    <div className="p-5 font-mono text-xs leading-5" role="note">
      {lines.map((line) => {
        const prefix =
          line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";
        const className =
          line.kind === "add"
            ? "bg-[var(--app-status-success-surface)] text-[var(--app-status-success-text)]"
            : line.kind === "remove"
              ? "bg-[var(--app-status-danger-surface)] text-[var(--app-status-danger-text)] line-through"
              : "text-app-body";
        return (
          <div className={`flex gap-2 px-2 ${className}`} key={line.id}>
            <span className="w-3 shrink-0 select-none opacity-60">
              {prefix}
            </span>
            <span className="min-w-0 break-words whitespace-pre-wrap">
              {line.text || " "}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function historyActors(entry: TeamHubDocumentHistoryEntry, t: Translate) {
  const actors =
    entry.contributors.length > 0 ? entry.contributors : [entry.created_by];
  return actors.map((actor) => actor.display_name).join(t(m.listSeparator));
}

function TimelineList({
  empty,
  error,
  items,
  onSelect,
  pending,
  selectedId,
}: {
  empty: string;
  error: Error | null;
  items: TeamHubDocumentHistoryEntry[];
  onSelect?: (id: string) => void;
  pending: boolean;
  selectedId?: string;
}) {
  const { language, t } = useTranslation();
  if (pending) {
    return (
      <p
        className="flex items-center justify-center gap-2 py-16 text-sm text-app-muted"
        role="status"
      >
        <Spinner size={16} />
        {t(m.loadingTimeline)}
      </p>
    );
  }
  if (error) {
    return (
      <p className="py-12 text-center text-sm text-app-danger" role="alert">
        {error.message}
      </p>
    );
  }
  if (items.length === 0) {
    return <p className="py-16 text-center text-sm text-app-muted">{empty}</p>;
  }
  return (
    <ul className="divide-y divide-app-border/60">
      {items.map((item) => (
        <li key={item.id}>
          <button
            aria-pressed={onSelect ? item.id === selectedId : undefined}
            className={`flex w-full items-start gap-3 rounded-lg px-2 py-3 text-left transition-colors duration-300 ${
              item.id === selectedId ? "bg-accent" : "hover:bg-muted/70"
            }`}
            disabled={!onSelect}
            onClick={() => onSelect?.(item.id)}
            type="button"
          >
            <ActorAvatar
              actorId={item.created_by.id}
              kind={item.created_by.kind}
              name={item.created_by.display_name}
              size="xs"
            />
            <span className="min-w-0">
              <strong className="block truncate text-sm font-medium text-app-ink">
                {formatDateTime(
                  item.created_at,
                  checkpointDate,
                  formatLocale(language),
                )}
              </strong>
              <span className="mt-0.5 block text-xs text-app-muted">
                {item.created_by.display_name}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
