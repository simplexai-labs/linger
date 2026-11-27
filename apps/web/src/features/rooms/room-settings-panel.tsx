import { RoomHistoryShareDialog } from "./sharing/room-history-share-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Delete02Icon,
  Link01Icon,
  Logout01Icon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { Suspense, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { TeamHubError } from "@/features/teamhub/teamhub-client";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import { commonMessages } from "@/i18n/common.messages";
import { useT } from "@/i18n/use-translation";
import { roomDialogMessages } from "./room-dialogs.messages";
import { roomSettingsMessages as m } from "./room-settings.messages";
import { sidePanelMessages } from "./task-sidebar/side-panel.messages";
import {
  requireRoomScope,
  roomQueryKey,
  roomQueryOptions,
  roomMembersQueryOptions,
  teamHubIdentityQueryOptions,
  tenantRoomsQueryKey,
} from "./room-queries";
import {
  PanelFooterAction,
  PanelFooterActions,
} from "./members/panel-footer-actions";
import { RoomAvatar } from "./members/room-avatar";
import { RoomMembersSection } from "./members/room-members-section";
import { RoomDeleteDialog } from "./room-delete-dialog";
import { useRoomParticipation, RoomRejoinBanner } from "./room-participation";
import type {
  TeamHubActorRef,
  TeamHubRoom,
} from "@/features/teamhub/teamhub-types";

export function RoomSettingsPanel({
  onOpenProfile,
  roomId,
  tenantId,
}: {
  onOpenProfile?: (actorId: string) => void;
  roomId: string;
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  const t = useT();
  const room = useQuery(roomQueryOptions(client, tenantId, roomId));
  const members = useQuery(roomMembersQueryOptions(client, tenantId, roomId));
  const identity = useQuery(teamHubIdentityQueryOptions(client));
  if (room.isPending || members.isPending || identity.isPending)
    return (
      <p role="status" className="p-5 text-sm text-app-muted">
        {t(m.loading)}
      </p>
    );
  if (!room.data || !members.data || !identity.data)
    return (
      <p role="alert" className="p-5 text-sm text-app-danger">
        {t(m.loadFailed)}
      </p>
    );
  const actorId = identity.data.actors.find(
    (actor) => actor.tenant_id === tenantId,
  )?.id;
  const owner = members.data.items.some(
    (member) => member.actor.id === actorId && member.role === "owner",
  );
  return (
    <RoomSettingsContent
      members={members.data.items.map((member) => member.actor)}
      onOpenProfile={onOpenProfile}
      owner={owner}
      room={room.data}
    />
  );
}
function RoomSettingsContent({
  members,
  onOpenProfile,
  room,
  owner,
}: {
  members: TeamHubActorRef[];
  onOpenProfile?: (actorId: string) => void;
  room: TeamHubRoom;
  owner: boolean;
}) {
  const [sharing, setSharing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const leave = useRoomParticipation(room);
  const t = useT();
  const groupRoom = room.kind === "room";
  return (
    <div
      className="agent-settings-column workspace-scrollbar flex h-full min-h-0 flex-col gap-8 overflow-y-auto bg-sidebar/50 pb-4 [scrollbar-gutter:stable_both-edges]"
      data-testid="panel-room-settings"
    >
      <RoomHeader
        groupRoom={groupRoom}
        members={members}
        canRename={owner}
        onShare={owner ? () => setSharing(true) : undefined}
        room={room}
      />
      {groupRoom ? (
        <>
          <Suspense
            fallback={
              <p role="status" className="p-5 text-sm text-app-muted">
                {t(m.loadingMembers)}
              </p>
            }
          >
            <RoomMembersSection
              onOpenProfile={onOpenProfile}
              roomId={room.id}
              tenantId={room.tenant_id}
            />
          </Suspense>
          {room.participation === "left" ? (
            <div className="px-3">
              <RoomRejoinBanner room={room} />
            </div>
          ) : null}
          {owner || room.participation !== "left" ? (
            <PanelFooterActions label={t(m.roomActions)}>
              {room.participation === "left" ? null : (
                <PanelFooterAction
                  data-voice-risk="never"
                  onClick={() => {
                    leave.reset();
                    setLeaving(true);
                  }}
                >
                  <Icon icon={Logout01Icon} size={14} />
                  {t(m.leaveRoom)}
                </PanelFooterAction>
              )}
              {owner ? (
                <PanelFooterAction
                  danger
                  data-voice-risk="never"
                  onClick={() => setDeleting(true)}
                >
                  <Icon icon={Delete02Icon} size={14} />
                  {t(roomDialogMessages.deleteRoom)}
                </PanelFooterAction>
              ) : null}
            </PanelFooterActions>
          ) : null}
        </>
      ) : null}
      {sharing ? (
        <RoomHistoryShareDialog
          canCreate={room.participation !== "left"}
          roomId={room.id}
          onClose={() => setSharing(false)}
        />
      ) : null}
      {deleting ? (
        <RoomDeleteDialog
          room={room}
          tenantId={room.tenant_id}
          onClose={() => setDeleting(false)}
        />
      ) : null}
      {leaving ? (
        <ModalDialog
          description={t(m.leaveDescription)}
          onClose={() => {
            if (!leave.isPending) setLeaving(false);
          }}
          size="sm"
          title={t(m.leaveRoom)}
          footer={
            <>
              <Button
                disabled={leave.isPending}
                onClick={() => setLeaving(false)}
              >
                {t(commonMessages.cancel)}
              </Button>
              <Button
                data-voice-risk="never"
                tone="danger"
                loading={leave.isPending}
                onClick={() =>
                  leave.mutate("left", { onSuccess: () => setLeaving(false) })
                }
              >
                {t(m.leave)}
              </Button>
            </>
          }
        >
          {leave.error ? (
            <p role="alert" className="px-5 py-4 text-sm text-app-danger">
              {leave.error.message}
            </p>
          ) : null}
        </ModalDialog>
      ) : null}
    </div>
  );
}

/**
 * The Room's identity, laid out like an Agent's: the name renames in place
 * and Share sits in the corner where an Agent has Publish.
 */
function RoomHeader({
  canRename,
  groupRoom,
  members,
  onShare,
  room,
}: {
  canRename: boolean;
  groupRoom: boolean;
  members: TeamHubActorRef[];
  onShare?: () => void;
  room: TeamHubRoom;
}) {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(room.name);
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renaming) nameInput.current?.select();
  }, [renaming]);
  const rename = useMutation({
    mutationFn: (name: string) =>
      teamHubData(
        client.api.PATCH("/v0/rooms/{roomId}", {
          params: { path: { roomId: room.id } },
          body: { name },
        }),
      ).then((updated) => requireRoomScope(updated, room.tenant_id, room.id)),
    onSuccess: async (updated) => {
      queryClient.setQueryData(roomQueryKey(room.tenant_id, room.id), {
        ...updated,
        participation: room.participation,
      });
      setRenaming(false);
      await queryClient.invalidateQueries({
        queryKey: tenantRoomsQueryKey(room.tenant_id),
      });
    },
  });
  function save() {
    const name = draft.trim();
    if (!name || name === room.name) {
      setDraft(room.name);
      setRenaming(false);
      return;
    }
    if (!rename.isPending) rename.mutate(name);
  }
  const renameError = rename.error
    ? rename.error instanceof TeamHubError
      ? rename.error.code === "ROOM_NAME_TAKEN"
        ? t(roomDialogMessages.nameTaken)
        : rename.error.message
      : t(m.saveUnconfirmed)
    : undefined;
  return (
    <header className="relative mx-auto flex w-full max-w-[780px] flex-col items-center px-5 pt-8 text-center">
      {onShare ? (
        <div className="absolute right-3 top-3">
          <button
            className="panel-header-action-button"
            onClick={onShare}
            title={t(m.shareConversation)}
            type="button"
          >
            <Icon icon={Link01Icon} size={14} />
            {t(m.share)}
          </button>
        </div>
      ) : null}
      <RoomAvatar members={members} size="lg" />
      {renaming ? (
        <input
          aria-label={t(m.name)}
          ref={nameInput}
          className="mt-2.5 max-w-full rounded-md bg-card px-2 text-center text-[15px] font-semibold leading-5 text-foreground shadow-outline outline-none focus-visible:ring-2 focus-visible:ring-app-focus"
          disabled={rename.isPending}
          maxLength={120}
          onBlur={save}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              rename.reset();
              setDraft(room.name);
              setRenaming(false);
            }
          }}
          value={draft}
        />
      ) : canRename ? (
        <h2 className="mt-2.5 max-w-full text-[15px] font-semibold leading-5 text-foreground">
          <button
            aria-label={t(m.renameRoom, { name: room.name })}
            className="max-w-full break-words rounded-md px-2 py-0.5 hover:bg-sidebar-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-focus"
            onClick={() => {
              rename.reset();
              setDraft(room.name);
              setRenaming(true);
            }}
            type="button"
          >
            {room.name}
          </button>
        </h2>
      ) : (
        <h2 className="mt-2.5 break-words text-[15px] font-semibold leading-5 text-foreground">
          {room.name}
        </h2>
      )}
      {renaming && renameError ? (
        <p className="mt-1 text-xs text-app-danger" role="alert">
          {renameError}
        </p>
      ) : null}
      {room.description ? (
        <p className="mt-1 line-clamp-2 max-w-[22rem] text-xs leading-[18px] text-muted-foreground">
          {room.description}
        </p>
      ) : null}
      {groupRoom ? (
        <p className="mt-1 text-xs tabular-nums text-muted-foreground">
          {t(sidePanelMessages.memberCount, { count: members.length })}
        </p>
      ) : null}
    </header>
  );
}
