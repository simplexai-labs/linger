import {
  Comment01Icon,
  Share08Icon,
  ArrowDown01Icon,
  PencilEdit01Icon,
  SidebarLeftIcon,
  TableOfContentsIcon,
  Tick02Icon,
  ViewIcon,
  Mail01Icon,
} from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import {
  useSyncExternalStore,
  type MutableRefObject,
  type ReactNode,
} from "react";

import { extractRenderedDocumentHeadings } from "@/components/document-headings";
import { ActionMenu } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  documentFileName,
  documentLogicalTitle,
} from "@/features/library/document-display-name";
import {
  canRenameDocument,
  useDocumentRename,
} from "@/features/library/use-document-rename";
import { documentSourceLabel } from "@/features/library/document-source-label";
import { WORKSPACE_TREE_ID } from "@/features/library/workspace-tree";
import { writeDocumentLinkClipboard } from "@/features/rooms/files/document-clipboard-link";
import { documentDetailPath } from "@/features/rooms/files/document-detail-routes";
import { libraryMessages } from "@/features/library/library.messages";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import type {
  TeamHubDocument,
  TeamHubDocumentPlacementNode,
} from "@/features/teamhub/teamhub-types";
import { commonMessages } from "@/i18n/common.messages";
import { translate, type Translate } from "@/i18n/language";
import { useT } from "@/i18n/use-translation";
import { roomMembersQueryOptions } from "../room-queries";

import type { RoomDocumentCollaborationSession } from "./room-document-collaboration";
import { RoomDocumentPresence } from "./room-document-presence";
import { collaborationColor } from "./room-document-presence-model";
import { DocumentActionsMenu } from "./room-document-actions-menu";
import type { UnifiedDocumentPageModel } from "./use-unified-document-page-model";
import { MailCanvasStatus } from "./canvas/canvas-mail-status";
import { documentPageMessages as m } from "./document-page.messages";
import { isMailCanvasTarget } from "./canvas/canvas-targets";

interface UnifiedDocumentPageHeaderProps {
  /** Only the actions, for the byline row under the page title, which
      already names the Document. */
  byline?: boolean;
  documentContentRef: MutableRefObject<HTMLDivElement | null>;
  isWikiPage: boolean;
  model: UnifiedDocumentPageModel;
}

/** Wires the page model's actions and presence into the Document header. */
export function UnifiedDocumentPageHeader({
  byline = false,
  documentContentRef,
  isWikiPage,
  model,
}: UnifiedDocumentPageHeaderProps) {
  const {
    actor,
    sidebar,
    client,
    commentsOpen,
    document,
    documentId,
    duplicateDocument,
    duplicatePending,
    exportDocument,
    exportPending,
    canvasSent,
    isEditing,
    isSharedDocument,
    roomId,
    session,
    sharedTree,
    setCommentsOpen,
    setHeadings,
    setHistoryOpen,
    setIsEditing,
    setShareOpen,
    setTocOpen,
    setTrashConfirmOpen,
    setTreeOpen,
    tenantId,
    tocOpen,
    tree,
    treeOpen,
  } = model;
  return (
    <UnifiedDocumentHeader
      byline={byline}
      sidebar={sidebar}
      commentsOpen={commentsOpen}
      document={document}
      isWikiPage={isWikiPage}
      duplicatePending={duplicatePending}
      exportPending={exportPending}
      canvasSent={canvasSent}
      mailCanvas={isMailCanvasTarget(model.canvasTarget)}
      isEditing={isEditing}
      onComments={() => setCommentsOpen((value) => !value)}
      onCopyLink={() =>
        void writeDocumentLinkClipboard({
          documentId,
          tenantId,
          title: document
            ? documentLogicalTitle(document)
            : translate(m.document),
          url: new URL(
            documentDetailPath({ documentId, tenantId }),
            window.location.origin,
          ).toString(),
        })
      }
      onDelete={() => setTrashConfirmOpen(true)}
      onDuplicate={() => void duplicateDocument()}
      onEditingChange={setIsEditing}
      onExport={() => void exportDocument()}
      onHistory={() => setHistoryOpen(true)}
      onOpenTree={() => setTreeOpen(!treeOpen)}
      onShare={() => setShareOpen(true)}
      onToc={() =>
        setTocOpen((value) => {
          const next = !value;
          if (next) {
            setHeadings(
              extractRenderedDocumentHeadings(documentContentRef.current),
            );
          }
          return next;
        })
      }
      presence={
        actor && session ? (
          roomId ? (
            <RoomDocumentRoomPresence
              actorDisplayName={actor.display_name}
              actorId={actor.id}
              client={client}
              roomId={roomId}
              session={session}
              showSelf
              tenantId={tenantId}
            />
          ) : (
            <RoomDocumentPresence
              awareness={session.awareness}
              currentActor={{
                color: collaborationColor(actor.id),
                displayName: actor.display_name,
                id: actor.id,
              }}
              members={undefined}
              showSelf
            />
          )
        ) : null
      }
      session={session}
      sharedDocument={isSharedDocument}
      sharedTreeItems={sharedTree.data?.items ?? []}
      tocOpen={tocOpen}
      treeItems={tree.data?.items ?? []}
      treeOpen={treeOpen}
      tenantId={tenantId}
    />
  );
}

function UnifiedDocumentHeader({
  byline,
  sidebar,
  commentsOpen,
  document,
  isWikiPage,
  duplicatePending,
  exportPending,
  canvasSent,
  mailCanvas,
  isEditing,
  onComments,
  onCopyLink,
  onDelete,
  onDuplicate,
  onEditingChange,
  onExport,
  onHistory,
  onOpenTree,
  onShare,
  onToc,
  presence,
  session,
  sharedDocument,
  sharedTreeItems,
  tocOpen,
  treeItems,
  treeOpen,
  tenantId,
}: {
  byline: boolean;
  sidebar: boolean;
  commentsOpen: boolean;
  document: TeamHubDocument | undefined;
  isWikiPage: boolean;
  duplicatePending: boolean;
  exportPending: boolean;
  canvasSent: boolean;
  mailCanvas: boolean;
  isEditing: boolean;
  onComments: () => void;
  onCopyLink: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onEditingChange: (editing: boolean) => void;
  onExport: () => void;
  onHistory: () => void;
  onOpenTree: () => void;
  onShare: () => void;
  onToc: () => void;
  presence?: ReactNode;
  session: RoomDocumentCollaborationSession | null;
  sharedDocument: boolean;
  sharedTreeItems: TeamHubDocumentPlacementNode[];
  tocOpen: boolean;
  treeItems: TeamHubDocumentPlacementNode[];
  treeOpen: boolean;
  tenantId: string;
}) {
  const t = useT();
  const rename = useDocumentRename(tenantId);
  const actionsMenu =
    document && !isWikiPage ? (
      <DocumentActionsMenu
        actions={{
          busy: duplicatePending || exportPending,
          canRename: canRenameDocument(document),
          onRename: () => rename.beginRename(document),
          canDelete: document.capabilities.delete,
          canDuplicate: document.capabilities.duplicate,
          canExport: document.capabilities.export,
          canUseVersion: true,
          onCopyLink,
          onDelete,
          onDuplicate,
          onExport,
          onShowHistory: onHistory,
        }}
      />
    ) : null;
  const treeButton = !sidebar ? (
    <>
      <Button
        aria-controls={WORKSPACE_TREE_ID}
        aria-expanded={treeOpen}
        aria-label={t(m.openLibraryPages)}
        className="sm:hidden"
        onClick={onOpenTree}
        size="icon"
        title={t(m.libraryPages)}
        tone="ghost"
      >
        <Icon icon={SidebarLeftIcon} />
      </Button>
    </>
  ) : null;
  const actions = (
    <>
      {mailCanvas && session ? (
        <span className="mr-2 text-xs text-app-muted">
          <MailCanvasStatus
            isEditing={isEditing}
            sent={canvasSent}
            session={session}
          />
        </span>
      ) : !isWikiPage ? (
        presence
      ) : null}
      {document && !isWikiPage ? (
        <Button
          aria-label={t(m.share)}
          size="compactIcon"
          onClick={onShare}
          title={t(m.share)}
          tone="ghost"
        >
          <Icon icon={Share08Icon} />
        </Button>
      ) : null}

      {!sidebar &&
      !isWikiPage &&
      document?.status === "active" &&
      document.capabilities.read &&
      document.capabilities.comment ? (
        <Button
          aria-label={t(m.comments)}
          aria-pressed={commentsOpen}
          onClick={onComments}
          size="icon"
          title={t(m.comments)}
          tone="ghost"
        >
          <Icon icon={Comment01Icon} />
        </Button>
      ) : null}
      {!sidebar && !mailCanvas ? (
        <Button
          aria-label={t(commonMessages.tableOfContents)}
          aria-pressed={tocOpen}
          onClick={onToc}
          size="icon"
          title={t(commonMessages.tableOfContents)}
          tone="ghost"
        >
          <Icon icon={TableOfContentsIcon} />
        </Button>
      ) : null}
      {!sidebar ? actionsMenu : null}
      {!mailCanvas &&
      !isWikiPage &&
      session &&
      document?.format === "blocknote" &&
      document.representation_format !== "html" ? (
        <RoomDocumentActions
          canEdit={
            document.status === "active" &&
            document.capabilities.write &&
            document.can_edit_native_content &&
            !canvasSent
          }
          isEditing={isEditing}
          onEditingChange={onEditingChange}
          session={session}
        />
      ) : null}
      {sidebar ? actionsMenu : null}
    </>
  );
  const breadcrumb =
    !sidebar && document ? (
      <div className="sr-only">
        <UnifiedDocumentBreadcrumb
          document={document}
          items={treeItems}
          sharedDocument={sharedDocument}
          sharedItems={sharedTreeItems}
        />
      </div>
    ) : null;
  if (byline) {
    return (
      <div className="room-document-header-actions">
        {breadcrumb}
        {treeButton}
        {actions}
        {rename.dialog}
      </div>
    );
  }
  return (
    <header
      className="room-document-header border-b border-app-border/60"
      data-mail-canvas={mailCanvas || undefined}
    >
      <div className="room-document-header-identity">
        {treeButton}
        {mailCanvas ? (
          <span className="flex items-center gap-2 text-sm font-medium text-app-ink">
            <Icon icon={Mail01Icon} size={16} />
            {t(m.mail)}
          </span>
        ) : document ? (
          <div className="room-document-header-file">
            <span className="truncate text-sm font-semibold text-app-ink">
              {documentFileName(document)}
            </span>
          </div>
        ) : null}
        {breadcrumb ?? (
          <span className="truncate text-sm font-semibold text-app-ink">
            {sidebar ? "" : t(m.document)}
          </span>
        )}
      </div>
      <div className="room-document-header-actions">{actions}</div>
      {rename.dialog}
    </header>
  );
}

function UnifiedDocumentBreadcrumb({
  document,
  items,
  sharedDocument,
  sharedItems,
}: {
  document: TeamHubDocument;
  items: TeamHubDocumentPlacementNode[];
  sharedDocument: boolean;
  sharedItems: TeamHubDocumentPlacementNode[];
}) {
  const t = useT();
  const personalPlacement = items.find(
    (item) => item.node_kind === "document" && item.document_id === document.id,
  );
  const sharedPlacement = sharedItems.find(
    (item) => item.node_kind === "document" && item.document_id === document.id,
  );
  const placement = personalPlacement ?? sharedPlacement;
  const placementItems = personalPlacement ? items : sharedItems;
  const folders = new Map(
    placementItems
      .filter(
        (
          item,
        ): item is Extract<
          TeamHubDocumentPlacementNode,
          { node_kind: "folder" }
        > => item.node_kind === "folder",
      )
      .map((folder) => [folder.id, folder]),
  );
  const ancestors: Array<{ id: string; name: string }> = [];
  let parentId = placement?.parent_id;
  while (parentId !== undefined) {
    const folder = folders.get(parentId);
    if (folder === undefined) break;
    ancestors.unshift(folder);
    parentId = folder.parent_id;
  }
  const context = document.from[0];
  const contextLabel =
    (context && documentSourceLabel(context, t)) ??
    documentContextLabel(context?.binding_kind, t);
  return (
    <DocumentBreadcrumb
      ancestors={ancestors}
      currentName={documentFileName(document)}
      rootLabel={
        personalPlacement
          ? t(libraryMessages.ownedByMe)
          : sharedDocument
            ? t(libraryMessages.sharedWithMe)
            : placement === undefined
              ? contextLabel
              : t(libraryMessages.ownedByMe)
      }
    />
  );
}

function documentContextLabel(
  bindingKind: TeamHubDocument["from"][number]["binding_kind"] | undefined,
  t: Translate,
) {
  return bindingKind === "room"
    ? t(m.contextRoom)
    : bindingKind === "task"
      ? t(m.contextWorkItem)
      : t(m.contextDocuments);
}

function DocumentBreadcrumb<T extends { id: string; name: string }>({
  ancestors,
  currentName,
  rootLabel,
}: {
  ancestors: T[];
  currentName: string;
  rootLabel: string;
}) {
  const t = useT();
  const visible = ancestors.length > 2 ? ancestors.slice(-2) : ancestors;
  const items = [
    { key: "root", label: rootLabel },
    ...visible.map((folder) => ({
      key: folder.id,
      label: folder.name,
    })),
    { key: "current", label: currentName },
  ];

  return (
    <nav
      aria-label={t(m.breadcrumb)}
      className="hidden min-w-0 flex-1 items-center gap-1 overflow-hidden text-sm text-app-muted sm:flex"
    >
      {items.map((item, index) => (
        <span className="flex min-w-0 items-center gap-1" key={item.key}>
          {index > 0 ? <span aria-hidden="true">›</span> : null}
          <span
            className={
              index === items.length - 1
                ? "truncate font-semibold text-app-ink"
                : "max-w-32 truncate"
            }
            title={item.label}
          >
            {item.label}
          </span>
        </span>
      ))}
    </nav>
  );
}

function RoomDocumentRoomPresence({
  actorDisplayName,
  actorId,
  client,
  roomId,
  session,
  showSelf = false,
  tenantId,
}: {
  actorDisplayName: string;
  actorId: string;
  client: TeamHubClient;
  roomId: string;
  session: RoomDocumentCollaborationSession;
  showSelf?: boolean;
  tenantId: string;
}) {
  const members = useQuery(roomMembersQueryOptions(client, tenantId, roomId));

  return (
    <RoomDocumentPresence
      awareness={session.awareness}
      currentActor={{
        color: collaborationColor(actorId),
        displayName: actorDisplayName,
        id: actorId,
      }}
      members={members.data?.items}
      showSelf={showSelf}
    />
  );
}

function RoomDocumentActions({
  canEdit,
  isEditing,
  onEditingChange,
  session,
}: {
  canEdit: boolean;
  isEditing: boolean;
  onEditingChange: (editing: boolean) => void;
  session: RoomDocumentCollaborationSession;
}) {
  const t = useT();
  const save = useSyncExternalStore(
    session.subscribeSaveState,
    session.getSaveSnapshot,
    session.getSaveSnapshot,
  );

  return (
    <ActionMenu
      buttonClassName="room-document-mode-trigger"
      initialFocusIndex={isEditing ? 0 : 1}
      itemClassName="flex min-h-9 w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm outline-none hover:bg-app-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-app-focus disabled:pointer-events-none disabled:opacity-45"
      label={t(m.documentMode)}
      items={[
        {
          label: t(commonMessages.edit),
          icon: isEditing ? (
            <span
              aria-label={t(m.currentMode)}
              className="inline-flex"
              role="img"
            >
              <Icon icon={Tick02Icon} size={14} />
            </span>
          ) : (
            <Icon icon={PencilEdit01Icon} size={14} />
          ),
          disabled: !canEdit || !save.canEdit,
          onSelect: () => onEditingChange(true),
        },
        {
          label: t(m.read),
          icon: !isEditing ? (
            <span
              aria-label={t(m.currentMode)}
              className="inline-flex"
              role="img"
            >
              <Icon icon={Tick02Icon} size={14} />
            </span>
          ) : (
            <Icon icon={ViewIcon} size={14} />
          ),
          onSelect: () => onEditingChange(false),
        },
      ]}
      trigger={
        <>
          <span>{isEditing ? t(m.editMode) : t(m.readMode)}</span>
          <Icon icon={ArrowDown01Icon} size={14} />
        </>
      }
    />
  );
}
