import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubActor } from "@/features/teamhub/teamhub-types";
import { useT } from "@/i18n/use-translation";
import { chatMessages } from "../chat/chat.messages";
import {
  roomMembersQueryOptions,
  tenantRoomsQueryOptions,
} from "../room-queries";
import { roomSettingsMessages as m } from "../room-settings.messages";
import { RoomCreateMembers } from "./room-create-members";

export function RoomAddMembersDialog({
  onClose,
  roomId,
  tenantId,
}: {
  onClose: () => void;
  roomId: string;
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  const t = useT();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<TeamHubActor[]>([]);
  const submit = useMutation({
    // Each member is independent: whatever succeeds stays applied and only the
    // failures remain queued for a retry.
    mutationFn: async () => {
      const results = await Promise.allSettled(
        selected.map((actor) =>
          teamHubData(
            client.api.PUT("/v0/rooms/{roomId}/members/{actorId}", {
              params: { path: { roomId, actorId: actor.id } },
              body: { role: "member" },
            }),
          ),
        ),
      );
      const failedActors = selected.filter(
        (_, index) => results[index]!.status === "rejected",
      );
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: roomMembersQueryOptions(client, tenantId, roomId).queryKey,
        }),
        queryClient.invalidateQueries({
          queryKey: tenantRoomsQueryOptions(client, tenantId).queryKey,
        }),
      ]);
      return { failedActors };
    },
    onSuccess: ({ failedActors }) => {
      const failedActorIds = new Set(failedActors.map((actor) => actor.id));
      setSelected(selected.filter((actor) => failedActorIds.has(actor.id)));
      if (failedActors.length === 0) onClose();
    },
  });
  const nothingQueued = selected.length === 0;

  return (
    <ModalDialog
      onClose={() => {
        if (!submit.isPending) onClose();
      }}
      size="md"
      title={t(m.addRoomMembers)}
      footer={
        <>
          {nothingQueued ? (
            <Button disabled={submit.isPending} onClick={onClose}>
              {t(m.skipForNow)}
            </Button>
          ) : null}
          <Button
            tone="primary"
            onClick={() => submit.mutate()}
            disabled={nothingQueued}
            loading={submit.isPending}
          >
            {t(m.addMembers)}
          </Button>
        </>
      }
    >
      <div className="space-y-4 px-5 py-4">
        <RoomCreateMembers
          disabled={submit.isPending}
          selected={selected}
          onChange={setSelected}
          tenantId={tenantId}
        />
        {submit.data?.failedActors.length ? (
          <p role="alert" className="text-sm text-app-danger">
            {t(m.addFailed, {
              names: submit.data.failedActors
                .map((actor) => actor.display_name)
                .join(t(chatMessages.listSeparator)),
            })}
          </p>
        ) : null}
        {submit.error ? (
          <p role="alert" className="text-sm text-app-danger">
            {submit.error.message}
          </p>
        ) : null}
      </div>
    </ModalDialog>
  );
}
