import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
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
import { translate } from "@/i18n/language";

import { authMessages } from "./auth.messages";
import { safeAuthenticationReturnTo } from "./authentication-return-to";
import {
  clearDesktopLocalAccountSignedOut,
  markDesktopLocalAccountSignedOut,
} from "./desktop-local-account";
import { clearLocalAuthenticatedState } from "./local-authenticated-state";

/** The English source; the confirmation itself follows the language on screen. */
export const LOGOUT_UNSAVED_DOCUMENT_MESSAGE =
  authMessages.logoutUnsavedDocuments.source;

export function useLogout({ returnTo }: { returnTo?: string } = {}) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const pending = useRef(false);
  const mutation = useMutation({
    retry: false,
    mutationFn: async () => {
      const identity = await queryClient.ensureQueryData(
        teamHubIdentityQueryOptions(client),
      );
      await browserRoomMessageOutbox.clearAccount(identity.account.id);
      markDesktopLocalAccountSignedOut();
      try {
        await teamHubDone(client.api.POST("/v0/auth/logout"));
      } catch (error) {
        clearDesktopLocalAccountSignedOut();
        throw error;
      }
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

  return {
    error: mutation.error,
    isPending: mutation.isPending,
    mutate: () => {
      if (pending.current) return;
      if (
        hasUnsavedRoomDocumentChanges() &&
        !window.confirm(translate(authMessages.logoutUnsavedDocuments))
      )
        return;
      pending.current = true;
      mutation.mutate();
    },
  };
}
