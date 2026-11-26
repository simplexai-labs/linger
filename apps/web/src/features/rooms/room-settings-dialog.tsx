import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Delete02Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { TeamHubError } from "@/features/teamhub/teamhub-client";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubRoom,
  TeamHubRoomUpdateInput,
} from "@/features/teamhub/teamhub-types";
import { commonMessages } from "@/i18n/common.messages";
import { useT } from "@/i18n/use-translation";

import { roomDialogMessages } from "./room-dialogs.messages";
import {
  requireRoomScope,
  roomQueryKey,
  tenantRoomsQueryKey,
} from "./room-queries";
import { roomSettingsMessages as m } from "./room-settings.messages";
import { roomSurfaceMessages } from "./room-surface.messages";

export function RoomSettingsDialog({
  onClose,
  onDelete,
  room,
  tenantId,
}: {
  onClose: () => void;
  onDelete: () => void;
  room: TeamHubRoom;
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  const t = useT();
  const queryClient = useQueryClient();
  const formId = useId();
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(room.name);
  const [description, setDescription] = useState(room.description ?? "");
  const updateRoom = useMutation({
    mutationFn: (input: TeamHubRoomUpdateInput) =>
      teamHubData(
        client.api.PATCH("/v0/rooms/{roomId}", {
          params: { path: { roomId: room.id } },
          body: input,
        }),
      ).then((updatedRoom) => requireRoomScope(updatedRoom, tenantId, room.id)),
    onSuccess: async (updatedRoom) => {
      queryClient.setQueryData(roomQueryKey(tenantId, room.id), {
        ...updatedRoom,
        participation: room.participation,
      });
      await queryClient.invalidateQueries({
        queryKey: tenantRoomsQueryKey(tenantId),
      });
      onClose();
    },
  });
  const failure = updateRoom.error
    ? updateRoom.error instanceof TeamHubError
      ? updateRoom.error.message
      : t(m.saveUnconfirmed)
    : null;
  const savedName = room.name;
  const savedDescription = room.description ?? "";
  // Nothing to commit means nothing to press: an enabled Save on an untouched
  // form invites a request that would change nothing.
  const dirty =
    name.trim() !== savedName.trim() ||
    description.trim() !== savedDescription.trim();

  useEffect(() => {
    nameInputRef.current?.focus();
  }, []);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (name.trim() && dirty) {
      const input = {
        description: description.trim(),
        name: name.trim(),
      };
      updateRoom.mutate(input);
    }
  }

  const fields = (
    <>
      <div className="rounded-xl border border-border p-4">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">{t(m.name)}</span>
          <input
            aria-label={t(roomDialogMessages.roomName)}
            className="ui-field-control w-full"
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            ref={nameInputRef}
            value={name}
          />
        </label>

        <label className="mt-4 block">
          <span className="mb-1.5 flex items-baseline justify-between gap-2 text-sm font-medium">
            {t(m.description)}
            <span className="font-normal tabular-nums text-muted-foreground">
              {description.length}/2000
            </span>
          </span>
          <textarea
            aria-label={t(m.roomDescription)}
            className="ui-field-control min-h-24 w-full resize-none"
            maxLength={2000}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t(m.descriptionPlaceholder)}
            value={description}
          />
        </label>
      </div>

      {failure ? (
        <p className="mt-3 text-sm text-app-danger" role="alert">
          {failure}
        </p>
      ) : null}
    </>
  );

  const actions = (
    <>
      <Button disabled={updateRoom.isPending} onClick={onClose}>
        {t(commonMessages.cancel)}
      </Button>
      <Button
        disabled={!name.trim() || !dirty}
        form={formId}
        loading={updateRoom.isPending}
        tone="primary"
        type="submit"
      >
        {t(m.saveChanges)}
      </Button>
    </>
  );

  return (
    <ModalDialog
      onClose={onClose}
      size="md"
      title={t(roomSurfaceMessages.roomSettings)}
      footer={actions}
    >
      <div className="px-5 py-4">
        <form id={formId} onSubmit={handleSubmit}>
          {fields}
        </form>
        <section className="mt-5 border-t border-app-border pt-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-sm text-app-ink">
                {t(roomDialogMessages.deleteRoom)}
              </h3>
              <p className="mt-0.5 text-sm leading-5 text-app-muted">
                {t(m.deleteDescription)}
              </p>
            </div>
            <Button
              data-voice-risk="never"
              disabled={updateRoom.isPending}
              onClick={onDelete}
              size="compact"
              tone="danger"
            >
              <Icon icon={Delete02Icon} size={16} />
              {t(roomDialogMessages.deleteRoom)}
            </Button>
          </div>
        </section>
      </div>
    </ModalDialog>
  );
}
