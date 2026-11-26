import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { commonMessages } from "@/i18n/common.messages";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { Select, SelectItem } from "@/components/ui/select";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import type { TeamHubDocumentPlacementNode } from "@/features/teamhub/teamhub-types";
import { useT } from "@/i18n/use-translation";

import type { LibraryRowDocument } from "./library-document-results";
import { libraryMessages as m } from "./library.messages";
import type { DocumentTreeFolder } from "./my-documents-tree-helpers";

/** Copies a shared Document into My pages through the canonical Duplicate command. */
export function useCopyToMyDocuments(client: TeamHubClient, tenantId: string) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const t = useT();
  const [copyingDocument, setCopyingDocument] =
    useState<LibraryRowDocument | null>(null);
  const [copyPending, setCopyPending] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  async function copyToMyDocuments(targetFolderId?: string) {
    if (!copyingDocument || copyPending) return;
    setCopyPending(true);
    setCopyError(null);
    try {
      const duplicate = await teamHubData(
        client.api.POST("/v0/documents/{documentId}/duplicates", {
          params: { path: { documentId: copyingDocument.id } },
          body: targetFolderId ? { target_folder_id: targetFolderId } : {},
        }),
      );
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["teamhub", tenantId, "document-tree"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["teamhub", "library-documents"],
        }),
      ]);
      setCopyingDocument(null);
      void navigate(
        `/t/${encodeURIComponent(tenantId)}/documents/${encodeURIComponent(duplicate.id)}`,
      );
    } catch (copyDocumentError) {
      setCopyError(
        copyDocumentError instanceof Error
          ? copyDocumentError.message
          : t(m.documentNotCopied),
      );
    } finally {
      setCopyPending(false);
    }
  }

  return {
    beginCopy: (document: LibraryRowDocument) => {
      setCopyError(null);
      setCopyingDocument(document);
    },
    cancelCopy: () => {
      setCopyError(null);
      setCopyingDocument(null);
    },
    copyError,
    copyingDocument,
    copyPending,
    copyToMyDocuments,
  };
}

export function CopyToMyDocumentsDialog({
  document,
  error,
  folders,
  items,
  onCancel,
  onCopy,
  pending,
}: {
  document: LibraryRowDocument;
  error: string | null;
  folders: DocumentTreeFolder[];
  items: TeamHubDocumentPlacementNode[];
  onCancel: () => void;
  onCopy: (targetFolderId?: string) => void;
  pending: boolean;
}) {
  const t = useT();
  const [targetId, setTargetId] = useState("__root__");
  return (
    <ModalDialog
      closeOnBackdrop
      description={document.title}
      onClose={onCancel}
      size="sm"
      title={t(m.copyToMyDocuments)}
      footer={
        <>
          <Button disabled={pending} onClick={onCancel} tone="secondary">
            {t(commonMessages.cancel)}
          </Button>
          <Button
            loading={pending}
            onClick={() =>
              onCopy(targetId === "__root__" ? undefined : targetId)
            }
            tone="primary"
          >
            {t(commonMessages.copy)}
          </Button>
        </>
      }
    >
      <div className="px-5 py-4">
        <div className="block text-sm font-medium text-app-body">
          {t(m.destination)}
          <Select
            aria-label={t(m.copyDestination)}
            className="mt-1 w-full"
            onValueChange={setTargetId}
            value={targetId}
          >
            <SelectItem value="__root__">{t(m.myDocuments)}</SelectItem>
            {folders.map((folder) => (
              <SelectItem key={folder.id} value={folder.id}>
                {folderPathLabel(folder, items)}
              </SelectItem>
            ))}
          </Select>
        </div>
        {error ? (
          <p className="mt-3 text-sm text-app-danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </ModalDialog>
  );
}

function folderPathLabel(
  folder: DocumentTreeFolder,
  items: TeamHubDocumentPlacementNode[],
) {
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const names = [folder.name];
  let parentId = folder.parent_id;
  while (parentId !== undefined) {
    const parent = itemsById.get(parentId);
    if (!parent || parent.node_kind !== "folder") break;
    names.unshift(parent.name);
    parentId = parent.parent_id;
  }
  return names.join(" / ");
}
