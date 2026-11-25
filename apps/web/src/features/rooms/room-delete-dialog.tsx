import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Delete02Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { teamHubDone } from "@/features/teamhub/teamhub-api";
import { TeamHubError } from "@/features/teamhub/teamhub-client";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubRoom,
  TeamHubRoomPage,
} from "@/features/teamhub/teamhub-types";
import { commonMessages } from "@/i18n/common.messages";
import { RichMessage, useT } from "@/i18n/use-translation";

import { roomDialogMessages as m } from "./room-dialogs.messages";
import { roomQueryKey, tenantRoomsQueryKey } from "./room-queries";

export function RoomDeleteDialog({
  onClose,
  room,
  tenantId,
}: {
  onClose: () => void;
  room: TeamHubRoom;
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const mountedRef = useRef(false);
  const deletionConfirmedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (deletionConfirmedRef.current) {
        queryClient.removeQueries({
          queryKey: roomQueryKey(tenantId, room.id),
        });
      }
    };
  }, [queryClient, room.id, tenantId]);
  const deleteRoom = useMutation({
    mutationFn: () =>
      teamHubDone(
        client.api.DELETE("/v0/rooms/{roomId}", {
          params: { path: { roomId: room.id } },
        }),
      ),
    onSuccess: async () => {
      deletionConfirmedRef.current = true;
      // A confirmation can arrive after the user has already left this Room.
      if (!mountedRef.current) {
        queryClient.removeQueries({
          queryKey: roomQueryKey(tenantId, room.id),
        });
      }
      queryClient.setQueryData<TeamHubRoomPage>(
        tenantRoomsQueryKey(tenantId),
        (current) =>
          current
            ? {
                ...current,
                items: current.items.filter(
                  (candidate) => candidate.id !== room.id,
                ),
              }
            : current,
      );
      // The navigation promise can resolve before React commits the new route.
      // The unmount cleanup above owns cache removal while this view is mounted.
      await navigate(`/t/${tenantId}/rooms`, { replace: true });
    },
  });
  // TeamHub's own message is shown as it is; an unknown outcome is worded here.
  const failure = deleteRoom.error
    ? deleteRoom.error instanceof TeamHubError
      ? deleteRoom.error.message
      : t(m.deleteUnconfirmed)
    : undefined;
  const descriptionMessage =
    room.kind === "direct"
      ? m.deleteDirectRoomDescription
      : m.deleteRoomDescription;

  return (
    <ModalDialog
      description={
        <RichMessage
          message={descriptionMessage}
          tags={{
            name: (text) => (
              <strong className="font-semibold text-foreground">{text}</strong>
            ),
          }}
          values={{ name: room.name }}
        />
      }
      onClose={() => {
        if (!deleteRoom.isPending) {
          onClose();
        }
      }}
      size="sm"
      title={t(m.deleteRoom)}
      footer={
        <>
          <Button disabled={deleteRoom.isPending} onClick={onClose}>
            {t(commonMessages.cancel)}
          </Button>
          <Button
            data-voice-risk="never"
            loading={deleteRoom.isPending}
            onClick={() => deleteRoom.mutate()}
            tone="danger"
          >
            <Icon icon={Delete02Icon} size={16} />
            {t(m.deleteRoom)}
          </Button>
        </>
      }
    >
      {failure ? (
        <p className="px-5 py-4 text-sm text-app-danger" role="alert">
          {failure}
        </p>
      ) : null}
    </ModalDialog>
  );
}
