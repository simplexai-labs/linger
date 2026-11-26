import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { TeamHubError } from "@/features/teamhub/teamhub-client";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import { commonMessages } from "@/i18n/common.messages";
import { useT } from "@/i18n/use-translation";

import { roomDialogMessages as m } from "./room-dialogs.messages";
import { requireRoomScope, tenantRoomsQueryOptions } from "./room-queries";

/** Room names are unique per member, so a taken default moves to the next
 * number; past this many the creator stops instead of probing further. */
const MAX_NAME_ATTEMPTS = 50;

/**
 * Creates a Room under a default name as soon as it mounts and opens it, where
 * adding members starts. The name can be changed later in Room settings. It
 * shows nothing unless creation fails.
 */
export function RoomCreator({
  onClose,
  tenantId,
}: {
  onClose: () => void;
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  const t = useT();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const startedRef = useRef(false);
  const [failed, setFailed] = useState(false);
  // The numbered name the last request sent. After an outcome TeamHub never
  // confirmed, the retry sends that same name, so ROOM_NAME_TAKEN then means
  // the first request created the Room rather than that the name was in use.
  const numberRef = useRef(1);
  const unconfirmedRef = useRef(false);

  const createRoom = useMutation({
    mutationFn: async () => {
      let taken: unknown;
      for (; numberRef.current <= MAX_NAME_ATTEMPTS; numberRef.current += 1) {
        const number = numberRef.current;
        try {
          const room = await teamHubData(
            client.api.POST("/v0/tenants/{tenantId}/rooms", {
              params: { path: { tenantId } },
              body: {
                name:
                  number === 1
                    ? t(m.defaultRoomName)
                    : t(m.defaultRoomNameNumbered, { number }),
              },
            }),
          );
          unconfirmedRef.current = false;
          return requireRoomScope(room, tenantId, room.id);
        } catch (error) {
          if (
            !(error instanceof TeamHubError) ||
            error.code !== "ROOM_NAME_TAKEN"
          ) {
            if (!(error instanceof TeamHubError)) unconfirmedRef.current = true;
            throw error;
          }
          if (unconfirmedRef.current) return undefined;
          taken = error;
        }
      }
      // Every default is taken; a retry starts over in case one was freed.
      numberRef.current = 1;
      throw taken;
    },
    onError: () => setFailed(true),
    onSuccess: async (room) => {
      await queryClient.invalidateQueries({
        queryKey: tenantRoomsQueryOptions(client, tenantId).queryKey,
      });
      onClose();
      // Undefined: an earlier unconfirmed request made the Room; it is listed.
      if (room)
        await navigate(`/t/${tenantId}/rooms/${room.id}/chat`, {
          state: { newRoomId: room.id },
        });
    },
  });

  useEffect(() => {
    // Strict Mode runs effects twice; one click creates one Room.
    if (startedRef.current) return;
    startedRef.current = true;
    createRoom.mutate();
  }, [createRoom]);

  if (!failed) return null;
  const error = createRoom.error;
  return (
    <ModalDialog
      description={
        !error
          ? undefined
          : error instanceof TeamHubError
            ? error.code === "ROOM_NAME_TAKEN"
              ? t(m.nameTaken)
              : error.message
            : t(m.createUnconfirmed)
      }
      onClose={onClose}
      size="sm"
      title={t(m.createFailed)}
      footer={
        <>
          <Button onClick={onClose}>{t(commonMessages.cancel)}</Button>
          <Button
            loading={createRoom.isPending}
            onClick={() => createRoom.mutate()}
            tone="primary"
          >
            {t(commonMessages.retry)}
          </Button>
        </>
      }
    >
      {null}
    </ModalDialog>
  );
}
