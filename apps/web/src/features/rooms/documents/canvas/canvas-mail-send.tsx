import type { components } from "@linger/wire-contracts/teamhub-public/types";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";

import { externalConnectionsQueryOptions } from "@/features/apps/connected-apps-queries";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import { translate, type Translate } from "@/i18n/language";
import { useT } from "@/i18n/use-translation";
import type { RoomDocumentEditor } from "../room-document-comment-schema";
import { type CanvasDocument, canvasText } from "./canvas-document";
import { canvasMessages } from "./canvas.messages";
import { mailCanvasAppName } from "./canvas-targets";

export type MailCanvasState = components["schemas"]["MailCanvasState"];

const inFlight = new Set<MailCanvasState["status"]>([
  "queued",
  "uploading",
  "sending",
]);

/** Local email and delivery status; editing never contacts Gmail. */
export function mailCanvasQueryOptions(
  client: TeamHubClient,
  documentId: string,
) {
  return queryOptions({
    queryKey: ["mail-canvas", documentId],
    queryFn: () =>
      teamHubData(
        client.api.GET("/v0/documents/{documentId}/mail", {
          params: { path: { documentId } },
        }),
      ),
    // The email's latest content may still be rendering right after an edit.
    retry: (failures, error) =>
      failures < 5 && error instanceof TeamHubError && error.status === 503,
    retryDelay: 500,
    refetchInterval: (query) =>
      query.state.data && inFlight.has(query.state.data.status) ? 1_500 : false,
  });
}

/** What a delivery in progress is doing; undefined once none is. */
export function progressText(
  status: MailCanvasState["status"],
  app: string,
  t: Translate,
): string | undefined {
  switch (status) {
    case "queued":
      return t(canvasMessages.preparing);
    case "uploading":
      return t(canvasMessages.uploadingToMail, { app });
    case "sending":
      return t(canvasMessages.sending);
    default:
      return undefined;
  }
}

/**
 * Sending a gmail canvas: what is saved in Linger is uploaded to Gmail and
 * sent only when `send` runs, so the Human sends exactly what they see.
 * `saved` says the editor showing the email, if any, has nothing unsaved.
 */
export function useMailCanvasSend(
  client: TeamHubClient,
  documentId: string,
  saved: boolean,
) {
  const t = useT();
  const queryClient = useQueryClient();
  const connections = useQuery(externalConnectionsQueryOptions(client));
  const mail = useQuery(mailCanvasQueryOptions(client, documentId));
  // A canvas sends from an account of its own mail app; an older TeamHub
  // names no target and only has Gmail canvases.
  const target = mail.data?.target ?? "gmail";
  const app = mailCanvasAppName(target);
  const accounts =
    connections.data?.connections.filter(
      (connection) =>
        connection.provider === target && connection.status === "active",
    ) ?? [];
  const [chosen, setChosen] = useState<string>();
  const account =
    accounts.find((connection) => connection.id === chosen) ?? accounts[0];
  const status = mail.data?.status;
  const refresh = useCallback(
    () =>
      void queryClient.invalidateQueries({
        queryKey: ["mail-canvas", documentId],
      }),
    [documentId, queryClient],
  );
  const mutation = useMutation({
    mutationFn: async () => {
      if (!account)
        throw new Error(
          translate(canvasMessages.connectMailBeforeSending, { app }),
        );
      if (!mail.data)
        throw new Error(translate(canvasMessages.emailStillLoading));
      // The digest of the email as this card last showed it: if anything
      // changed since, TeamHub refuses and the card shows the new version.
      return teamHubData(
        client.api.POST("/v0/documents/{documentId}/mail", {
          params: { path: { documentId } },
          body: {
            connection_id: account.id,
            request_id: crypto.randomUUID(),
            source_digest: mail.data.source_digest,
          },
        }),
      );
    },
    onError: refresh,
    onSuccess: (state) =>
      queryClient.setQueryData(["mail-canvas", documentId], state),
  });
  const decline = useMutation({
    mutationFn: () =>
      teamHubData(
        client.api.POST("/v0/documents/{documentId}/mail/decline", {
          params: { path: { documentId } },
        }),
      ),
    onError: refresh,
    onSuccess: (state) =>
      queryClient.setQueryData(["mail-canvas", documentId], state),
  });
  const busy =
    mutation.isPending || (status !== undefined && inFlight.has(status));
  const problem = mutation.error
    ? mutation.error instanceof TeamHubError && mutation.error.status === 409
      ? mutation.error.message || t(canvasMessages.emailChanged)
      : mutation.error.message
    : decline.error
      ? decline.error.message
      : status === "failed"
        ? mail.data?.error
        : undefined;
  const canEdit = mail.data?.can_edit === true;
  const canSend =
    canEdit &&
    saved &&
    account !== undefined &&
    Boolean(mail.data?.subject.trim()) &&
    Boolean(mail.data?.to.trim()) &&
    (status === "draft" || status === "failed" || status === "unknown");
  const note = busy
    ? (progressText(status ?? "queued", app, t) ?? t(canvasMessages.preparing))
    : !account && connections.isSuccess
      ? t(canvasMessages.connectMailToSend, { app })
      : !saved
        ? t(canvasMessages.saving)
        : undefined;
  return {
    account,
    accounts,
    app,
    busy,
    canEdit,
    canSend,
    choose: setChosen,
    decline: () => decline.mutate(),
    declining: decline.isPending,
    mail: mail.data,
    note,
    problem: busy ? undefined : problem,
    /** Ask for the latest digest after the editor saved a change. */
    refresh,
    send: () => mutation.mutate(),
    status,
  };
}

/**
 * Records a delivery in the canvas header, so Agents and other readers see
 * the email went out and the editor turns read-only. Shows nothing: Send
 * lives on the email's card in the chat.
 */
export function CanvasMailSentSync({
  canvas,
  client,
  documentId,
  editable,
  editor,
}: {
  canvas: CanvasDocument;
  client: TeamHubClient;
  documentId: string;
  editable: boolean;
  editor: RoomDocumentEditor;
}) {
  const status = useQuery(mailCanvasQueryOptions(client, documentId)).data
    ?.status;
  useEffect(() => {
    if (status !== "sent" || canvas.status === "sent" || !editable) return;
    editor.updateBlock(canvas.blockId, {
      content: canvasText({
        ...canvas,
        fields: { ...canvas.fields, status: "sent" },
      }),
    });
  }, [canvas, editable, editor, status]);
  return null;
}
