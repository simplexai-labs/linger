import { Loading03Icon } from "@hugeicons/core-free-icons";
import { Link } from "react-router";

import { Icon } from "@/components/ui/icon";
import { ActorAvatar } from "@/features/rooms/members/actor-avatar";
import {
  DocumentActionsMenu,
  type RoomDocumentMenuActions,
} from "@/features/rooms/documents/room-document-actions-menu";
import type {
  TeamHubDocument,
  TeamHubDocumentTreeSummary,
} from "@/features/teamhub/teamhub-types";
import {
  formatLocale,
  type Translate,
  type Translation,
} from "@/i18n/language";
import { useT, useTranslation } from "@/i18n/use-translation";
import { formatDateTime, formatUpdatedAt } from "@/lib/date-format";

import { documentFileName } from "./document-display-name";
import { documentSourceLabels } from "./document-source-label";
import { type LibraryFolder, LibraryFolderRow } from "./library-folder-browser";
import type { LibrarySection } from "./library-sidebar";
import type { PendingDocumentUpload } from "./library-upload-queue";
import {
  DocumentRowsSkeleton,
  RecentCardsSkeleton,
} from "./library-loading-skeletons";
import { libraryMessages as m } from "./library.messages";
import { WorkspaceFileIcon } from "./workspace-file-icon";

/** Library rows come from the smart view (with access sources) or a folder's tree items. */
export type LibraryRowDocument = TeamHubDocumentTreeSummary &
  Partial<Pick<TeamHubDocument, "from">>;

/**
 * The most recently updated Documents as one row of cards above the tabs, so
 * the file a reader was just in is one click away.
 */
export function RecentDocumentCards({
  documentActions,
  documents,
  error,
  pending,
  tenantId,
}: {
  documentActions: (document: TeamHubDocument) => RoomDocumentMenuActions;
  documents: TeamHubDocument[];
  error: Error | null;
  pending: boolean;
  tenantId: string;
}) {
  const translation = useTranslation();
  const { t } = translation;
  const recentShowUnlinked = anyLinked(documents);
  return (
    <section aria-label={t(m.recent)} className="workspace-recent">
      <h3 className="workspace-recent-title">{t(m.recent)}</h3>
      {pending ? (
        <RecentCardsSkeleton label={t(m.loadingDocuments)} />
      ) : error ? (
        <p className="py-6 text-sm text-app-danger" role="alert">
          {error.message || t(m.recentUnavailable)}
        </p>
      ) : documents.length === 0 ? (
        <p className="py-6 text-sm text-app-muted">{t(m.noRecent)}</p>
      ) : (
        <div className="workspace-recent-cards">
          {documents.map((document) => {
            const fileName = documentFileName(document);
            const context = documentContext(document, recentShowUnlinked, t);
            return (
              <article className="workspace-recent-card" key={document.id}>
                <Link
                  aria-label={fileName}
                  className="workspace-recent-link"
                  to={`/t/${encodeURIComponent(tenantId)}/documents/${encodeURIComponent(document.id)}`}
                >
                  <span className="workspace-recent-icon">
                    <WorkspaceFileIcon filename={fileName} />
                  </span>
                  <span className="workspace-recent-name">{fileName}</span>
                  <span className="workspace-recent-meta">
                    <span>{document.owner.display_name}</span>
                    {context ? (
                      <>
                        {" · "}
                        <span>{context}</span>
                      </>
                    ) : null}
                  </span>
                  <time
                    dateTime={document.updated_at}
                    title={exactTime(document.updated_at, translation)}
                  >
                    {formatUpdatedAt(
                      document.updated_at,
                      undefined,
                      translation,
                    )}
                  </time>
                </Link>
                <DocumentActionsMenu
                  actions={documentActions(document)}
                  buttonClassName="workspace-file-action"
                  label={t(m.actionsFor, { name: document.title })}
                />
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

/**
 * Where a Document is visible. "No linked context" only says something when
 * some Document beside it does have a source, so a list where none do omits it.
 */
function documentContext(
  document: LibraryRowDocument,
  showUnlinked: boolean,
  t: Translate,
) {
  if (!document.from) return "";
  if (document.from.length)
    return t(m.visibleIn, {
      // Room and Task names, listed as they are, and the Personal Wiki.
      places: documentSourceLabels(
        document.from,
        t,
        (source) => source.binding_kind,
      ).join(", "),
    });
  return showUnlinked ? t(m.noLinkedContext) : "";
}

function anyLinked(documents: readonly LibraryRowDocument[]) {
  return documents.some((document) => (document.from?.length ?? 0) > 0);
}

export function LibraryDocumentResults({
  activeView,
  documents,
  error,
  folders,
  onCopy,
  onOpenFolder,
  documentActions,
  pending,
  pendingUploads,
  section,
  tenantId,
}: {
  activeView: { empty: string; label: string };
  documents: LibraryRowDocument[];
  error: Error | null;
  folders: readonly LibraryFolder[];
  onCopy: (document: LibraryRowDocument) => void;
  onOpenFolder: (folderId: string) => void;
  documentActions: (
    document: TeamHubDocumentTreeSummary,
  ) => RoomDocumentMenuActions;
  pending: boolean;
  pendingUploads: readonly PendingDocumentUpload[];
  section: LibrarySection;
  tenantId: string;
}) {
  const t = useT();
  if (pending) {
    return <DocumentRowsSkeleton label={t(m.loadingDocuments)} />;
  }
  if (error) {
    return (
      <p className="py-16 text-center text-sm text-app-danger" role="alert">
        {error.message || t(m.listUnavailable)}
      </p>
    );
  }
  const showUnlinked = anyLinked(documents);
  if (
    documents.length === 0 &&
    folders.length === 0 &&
    pendingUploads.length === 0
  ) {
    return (
      <p className="py-16 text-center text-sm text-app-muted">
        {activeView.empty}
      </p>
    );
  }
  return (
    <div
      aria-label={t(m.viewDocuments, { view: activeView.label })}
      className="workspace-file-list"
    >
      {folders.map((folder) => (
        <LibraryFolderRow
          folder={folder}
          key={folder.id}
          onOpen={onOpenFolder}
        />
      ))}
      {pendingUploads.map((upload) => (
        <div
          aria-label={t(
            upload.status === "uploading" ? m.uploadUploading : m.uploadQueued,
            { filename: upload.filename },
          )}
          className="workspace-file-row text-app-muted"
          key={upload.id}
          role="status"
        >
          <span className="workspace-file-name">
            {upload.status === "uploading" ? (
              <Icon
                icon={Loading03Icon}
                className="shrink-0 animate-spin"
                size={16}
              />
            ) : (
              <WorkspaceFileIcon filename={upload.filename} />
            )}
            <strong className="truncate">{upload.filename}</strong>
          </span>
          {upload.status === "uploading" ? (
            <span aria-hidden="true" className="text-xs">
              {Math.round(upload.progress * 100)}%
            </span>
          ) : null}
        </div>
      ))}
      {documents.map((document) => (
        <DocumentRow
          context={documentContext(document, showUnlinked, t)}
          document={document}
          key={document.id}
          actions={documentActions(document)}
          onCopyToMyDocuments={
            section === "shared-with-me" && document.capabilities.duplicate
              ? () => onCopy(document)
              : undefined
          }
          tenantId={tenantId}
        />
      ))}
    </div>
  );
}

/** The full date and time behind a relative label, shown on hover. */
function exactTime(iso: string, translation: Translation) {
  return Number.isFinite(Date.parse(iso))
    ? formatDateTime(iso, undefined, formatLocale(translation.language))
    : undefined;
}

function DocumentRow({
  context,
  document,
  actions,
  onCopyToMyDocuments,
  tenantId,
}: {
  context: string;
  document: LibraryRowDocument;
  actions: RoomDocumentMenuActions;
  onCopyToMyDocuments?: () => void;
  tenantId: string;
}) {
  const t = useT();
  const fileName = documentFileName(document);
  return (
    <div className="workspace-file-row">
      <Link
        aria-label={fileName}
        className="workspace-file-name"
        to={`/t/${encodeURIComponent(tenantId)}/documents/${encodeURIComponent(document.id)}`}
      >
        <WorkspaceFileIcon filename={fileName} />
        <span className="min-w-0">
          <strong>{fileName}</strong>
          {context ? (
            <span className="workspace-file-context">{context}</span>
          ) : null}
        </span>
      </Link>
      <WorkspaceFileMetadata document={document} />
      <DocumentActionsMenu
        actions={{ ...actions, onCopyToMyDocuments }}
        buttonClassName="workspace-file-action"
        label={t(m.actionsFor, { name: document.title })}
      />
    </div>
  );
}

function WorkspaceFileMetadata({
  document,
}: {
  document: TeamHubDocumentTreeSummary;
}) {
  const translation = useTranslation();
  const owner = document.owner;
  return (
    <div className="workspace-file-metadata">
      <span
        className="workspace-file-owner"
        data-kind={owner.kind}
        title={owner.display_name}
      >
        <ActorAvatar
          actorId={owner.id}
          kind={owner.kind}
          name={owner.display_name}
          size="micro"
        />
        <span>{owner.display_name}</span>
      </span>
      <time
        dateTime={document.updated_at}
        title={exactTime(document.updated_at, translation)}
      >
        {formatUpdatedAt(document.updated_at, undefined, translation)}
      </time>
    </div>
  );
}
