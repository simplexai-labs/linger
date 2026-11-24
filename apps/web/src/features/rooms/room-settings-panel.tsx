import { RoomHistoryShareDialog } from "./sharing/room-history-share-dialog";
import { useQuery } from "@tanstack/react-query";
import {
  Delete02Icon,
  Link01Icon,
  Logout01Icon,
  PencilEdit01Icon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { Suspense, useState } from "react";
import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import { commonMessages } from "@/i18n/common.messages";
import { useT } from "@/i18n/use-translation";
import { roomDialogMessages } from "./room-dialogs.messages";
import { roomSettingsMessages as m } from "./room-settings.messages";
import { sidePanelMessages } from "./task-sidebar/side-panel.messages";
import {
  roomQueryOptions,
  roomMembersQueryOptions,
  teamHubIdentityQueryOptions,
} from "./room-queries";
import { RoomSettingsDialog } from "./room-settings-dialog";
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
  const [editing, setEditing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const leave = useRoomParticipation(room);
  const t = useT();
  const groupRoom = room.kind === "room" && !room.channel;
  return (
    <div
      className="workspace-scrollbar h-full overflow-y-auto"
      data-testid="panel-room-settings"
    >
      {editing ? (
        <RoomSettingsDialog
          key={room.id}
          embedded
          room={room}
          tenantId={room.tenant_id}
          onClose={() => setEditing(false)}
          onDelete={() => setDeleting(true)}
        />
      ) : (
        <header className="flex flex-col items-center px-5 pb-4 pt-6 text-center">
          <RoomAvatar members={members} size="lg" />
          <div className="mt-3 flex max-w-full items-center gap-1">
            <h2 className="truncate text-base font-semibold leading-5 text-foreground">
              {room.name}
            </h2>
            {owner ? (
              <button
                aria-label={t(m.editDetails)}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                onClick={() => setEditing(true)}
                title={t(m.editDetails)}
                type="button"
              >
                <Icon icon={PencilEdit01Icon} size={14} />
              </button>
            ) : null}
          </div>
          {room.description ? (
            <p className="mt-1 line-clamp-2 text-xs leading-[18px] text-app-muted">
              {room.description}
            </p>
          ) : null}
          {groupRoom ? (
            <p className="mt-1.5 text-xs tabular-nums text-app-muted">
              {t(sidePanelMessages.memberCount, { count: members.length })}
            </p>
          ) : null}
        </header>
      )}
      {groupRoom ? (
        <>
          <h3 className="px-5 pt-2 text-xs font-medium text-app-muted">
            {t(m.members)}
          </h3>
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
          <div className="mx-5 mt-2 space-y-2 border-t border-app-border pb-5 pt-4">
            {owner ? (
              <Button className="w-full" onClick={() => setSharing(true)}>
                <Icon icon={Link01Icon} size={16} />
                {t(m.shareConversation)}
              </Button>
            ) : null}
            {room.participation === "left" ? (
              <RoomRejoinBanner room={room} />
            ) : (
              <Button
                data-voice-risk="never"
                className="w-full"
                onClick={() => {
                  leave.reset();
                  setLeaving(true);
                }}
              >
                <Icon icon={Logout01Icon} size={16} />
                {t(m.leaveRoom)}
              </Button>
            )}
            {owner ? (
              <Button
                data-voice-risk="never"
                className="w-full"
                onClick={() => setDeleting(true)}
                tone="danger"
              >
                <Icon icon={Delete02Icon} size={16} />
                {t(roomDialogMessages.deleteRoom)}
              </Button>
            ) : null}
          </div>
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
