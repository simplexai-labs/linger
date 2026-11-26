import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";

import { browserRoomMessageOutbox } from "@/features/rooms/chat/room-message-outbox";
import {
  deleteRoomDocumentLocalCopies,
  hasUnsavedRoomDocumentChanges,
} from "@/features/rooms/documents/room-document-local-copies";
import { teamHubIdentityQueryOptions } from "@/features/rooms/room-queries";
import { teamHubDone } from "@/features/teamhub/teamhub-api";
import { announceTeamHubAuthenticationRequired } from "@/features/teamhub/teamhub-authentication";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";

import { authMessages } from "./auth.messages";
import { safeAuthenticationReturnTo } from "./authentication-return-to";
import { clearLocalAuthenticatedState } from "./local-authenticated-state";
import { openLogoutConfirmDialog } from "./logout-confirm-dialog";

/** The English source; the confirmation itself follows the language on screen. */
export const LOGOUT_UNSAVED_DOCUMENT_MESSAGE =
  authMessages.logoutUnsavedDocuments.source;

export function useLogout({ returnTo }: { returnTo?: string } = {}) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const pending = useRef(false);
  const cancelConfirmRef = useRef<(() => void) | null>(null);
  const mutation = useMutation({
    retry: false,
    mutationFn: async () => {
      const identity = await queryClient.ensureQueryData(
        teamHubIdentityQueryOptions(client),
      );
      await browserRoomMessageOutbox.clearAccount(identity.account.id);
      await teamHubDone(client.api.POST("/v0/auth/logout"));
      const safeReturnTo = safeAuthenticationReturnTo(returnTo ?? null);
      await navigate(
        safeReturnTo
          ? `/login?return_to=${encodeURIComponent(safeReturnTo)}`
          : "/login",
        { replace: true },
      );
      // Let the router unmount protected query consumers before clearing them.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      clearLocalAuthenticatedState(queryClient);
      // The editors here have unmounted; editors in other tabs close when the
      // deletion reaches them and cannot reopen without the Session. A copy
      // that fails to delete goes at the account's next logout.
      await deleteRoomDocumentLocalCopies({
        actorIds: identity.actors.map((actor) => actor.id),
      }).catch(() => undefined);
      announceTeamHubAuthenticationRequired();
    },
    onSettled: () => {
      pending.current = false;
    },
  });

  useEffect(
    () => () => {
      cancelConfirmRef.current?.();
      cancelConfirmRef.current = null;
    },
    [],
  );

  return {
    error: mutation.error,
    isPending: mutation.isPending,
    mutate: () => {
      if (pending.current || cancelConfirmRef.current) return;
      if (hasUnsavedRoomDocumentChanges()) {
        const dialog = openLogoutConfirmDialog();
        cancelConfirmRef.current = dialog.cancel;
        void dialog.promise.then((confirmed) => {
          if (cancelConfirmRef.current === dialog.cancel) {
            cancelConfirmRef.current = null;
          }
          if (!confirmed || pending.current) return;
          pending.current = true;
          mutation.mutate();
        });
        return;
      }
      pending.current = true;
      mutation.mutate();
    },
  };
}
