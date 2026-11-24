import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { Delete02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { teamHubData, teamHubDone } from "@/features/teamhub/teamhub-api";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubActor,
  TeamHubActorRef,
  TeamHubTenantAgentAvailabilitySnapshot,
} from "@/features/teamhub/teamhub-types";
import { commonMessages } from "@/i18n/common.messages";
import type { Message } from "@/i18n/messages";
import { useT } from "@/i18n/use-translation";

import {
  roomMembersQueryOptions,
  teamHubIdentityQueryOptions,
  tenantActorsQueryOptions,
  tenantAgentAvailabilityQueryOptions,
  tenantAgentsQueryOptions,
} from "../room-queries";
import { eligibleRoomAgents } from "../agent-admission";
import { roomSettingsMessages as m } from "../room-settings.messages";
import { ActorAvatar } from "./actor-avatar";
import { agentInfoMessages } from "./agent-info.messages";
import { AgentStatus } from "./agent-status";

type AgentAvailability = TeamHubTenantAgentAvailabilitySnapshot["availability"];

/** The roles TeamHub names today; any other value is shown as it was sent. */
const ROLE_LABELS: Record<string, Message<string> | undefined> = {
  owner: m.roleOwner,
  member: m.roleMember,
};

export function RoomMembersSection({
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
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<TeamHubActorRef | null>(
    null,
  );
  const { data: identity } = useSuspenseQuery(
    teamHubIdentityQueryOptions(client),
  );
  const membersQuery = roomMembersQueryOptions(client, tenantId, roomId);
  const { data: members } = useSuspenseQuery(membersQuery);
  const { data: actors } = useSuspenseQuery({
    ...tenantActorsQueryOptions(client, tenantId),
    refetchOnMount: "always",
  });
  const currentActorId = identity.actors.find(
    (actor) => actor.tenant_id === tenantId,
  )?.id;
  const isOwner = members.items.some(
    (member) => member.actor.id === currentActorId && member.role === "owner",
  );
  const agentDirectory = useQuery({
    ...tenantAgentsQueryOptions(client, tenantId),
    refetchOnMount: "always",
    retry: false,
  });
  const agentAvailability = useQuery({
    ...tenantAgentAvailabilityQueryOptions(client, tenantId),
    refetchOnMount: "always",
    retry: false,
  });
  const availabilityByActorId = useMemo(
    () =>
      new Map(
        (agentAvailability.data?.items ?? []).map((snapshot) => [
          snapshot.actor_id,
          snapshot.availability,
        ]),
      ),
    [agentAvailability.data?.items],
  );
  const sponsoredAgentIds = useMemo(() => {
    const actorIds = new Set<string>();
    for (const agent of agentDirectory.data?.items ?? []) {
      if (agent.created_by.id === currentActorId) {
        actorIds.add(agent.actor.id);
      }
    }
    return actorIds;
  }, [agentDirectory.data?.items, currentActorId]);
  const availableActors = useMemo(() => {
    const memberIds = new Set(members.items.map((member) => member.actor.id));
    const availableHumans = actors.items.filter(
      (actor) => actor.kind === "human" && !memberIds.has(actor.id),
    );
    const availableAgents = eligibleRoomAgents({
      agents: agentDirectory.data?.items ?? [],
      roomMemberIds: memberIds,
      sponsorActorId: currentActorId,
    });
    return [...availableHumans, ...availableAgents];
  }, [actors.items, agentDirectory.data?.items, currentActorId, members.items]);
  const refreshMembers = () =>
    queryClient.invalidateQueries({ queryKey: membersQuery.queryKey });
  const putMember = useMutation({
    mutationFn: (actorId: string) =>
      teamHubData(
        client.api.PUT("/v0/rooms/{roomId}/members/{actorId}", {
          params: { path: { roomId, actorId } },
          body: { role: "member" },
        }),
      ),
    onSuccess: refreshMembers,
  });
  const removeMember = useMutation({
    mutationFn: (actorId: string) =>
      teamHubDone(
        client.api.DELETE("/v0/rooms/{roomId}/members/{actorId}", {
          params: { path: { roomId, actorId } },
        }),
      ),
    onSuccess: async () => {
      await refreshMembers();
      setRemoveTarget(null);
    },
  });

  return (
    <section aria-label={t(m.roomMembers)} className="px-5 py-3">
      <div className="space-y-1">
        {members.items.map((member) => {
          const agent = agentDirectory.data?.items.find(
            (candidate) => candidate.actor.id === member.actor.id,
          );
          const role = ROLE_LABELS[member.role];
          return (
            <div
              className="group flex min-h-13 w-full items-center rounded-lg transition-colors duration-300 hover:bg-muted/70"
              key={member.actor.id}
            >
              <button
                aria-label={t(agentInfoMessages.openProfile, {
                  name: member.actor.display_name,
                })}
                className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-2 text-left focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-app-focus"
                onClick={() => onOpenProfile?.(member.actor.id)}
                type="button"
              >
                <ActorAvatar
                  actorId={member.actor.id}
                  kind={member.actor.kind}
                  name={member.actor.display_name}
                  size="sm"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">
                      {member.actor.display_name}
                    </span>
                    {member.actor.kind === "agent" ? (
                      <span className="rounded-sm bg-muted px-1.5 py-0.5 text-2xs font-medium text-muted-foreground">
                        {t(agentInfoMessages.agent)}
                      </span>
                    ) : null}
                    {sponsoredAgentIds.has(member.actor.id) ? (
                      <span className="rounded-sm bg-muted px-1.5 py-0.5 text-2xs font-medium text-foreground">
                        {t(m.yours)}
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <span>{role ? t(role) : member.role}</span>
                    {member.actor.kind === "agent" &&
                    agent &&
                    availabilityByActorId.has(member.actor.id) ? (
                      <>
                        <span aria-hidden>·</span>
                        <AgentStatus
                          availability={
                            availabilityByActorId.get(member.actor.id)!
                          }
                          showDetails
                        />
                      </>
                    ) : null}
                  </span>
                </span>
              </button>
              {isOwner && member.actor.id !== currentActorId ? (
                <Button
                  data-voice-risk="never"
                  aria-label={t(m.removeMember, {
                    name: member.actor.display_name,
                  })}
                  className="mr-1 opacity-70 group-hover:opacity-100"
                  onClick={() => {
                    removeMember.reset();
                    setRemoveTarget(member.actor);
                  }}
                  size="compactIcon"
                  title={t(m.removeMember, {
                    name: member.actor.display_name,
                  })}
                  tone="ghost"
                >
                  <Icon icon={Delete02Icon} size={16} />
                </Button>
              ) : null}
            </div>
          );
        })}
      </div>

      {!addOpen && putMember.error ? (
        <p className="mt-3 text-sm text-app-danger" role="alert">
          {putMember.error.message}
        </p>
      ) : null}
      <Button
        className="mt-3 w-full"
        onClick={() => {
          putMember.reset();
          setAddOpen(true);
        }}
      >
        <Icon className="text-muted-foreground" icon={PlusSignIcon} size={16} />
        {t(m.addMember)}
      </Button>

      {addOpen ? (
        <AddMemberDialog
          agentDirectoryError={agentDirectory.isError}
          agentDirectoryLoading={agentDirectory.isPending}
          actors={availableActors}
          availabilityByActorId={availabilityByActorId}
          sponsoredAgentIds={sponsoredAgentIds}
          error={putMember.error?.message}
          isPending={putMember.isPending}
          onAdd={(actor) =>
            putMember.mutate(actor.id, { onSuccess: () => setAddOpen(false) })
          }
          onClose={() => {
            putMember.reset();
            setAddOpen(false);
          }}
          onRetryAgentDirectory={() => void agentDirectory.refetch()}
        />
      ) : null}
      {removeTarget ? (
        <RemoveMemberDialog
          actor={removeTarget}
          error={removeMember.error?.message}
          isPending={removeMember.isPending}
          onClose={() => {
            removeMember.reset();
            setRemoveTarget(null);
          }}
          onRemove={() => removeMember.mutate(removeTarget.id)}
        />
      ) : null}
    </section>
  );
}

function RemoveMemberDialog({
  actor,
  error,
  isPending,
  onClose,
  onRemove,
}: {
  actor: TeamHubActorRef;
  error?: string;
  isPending: boolean;
  onClose: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const title = t(m.removeMemberTitle, { name: actor.display_name });
  return (
    <ModalDialog
      description={t(m.removeMemberDescription)}
      onClose={onClose}
      size="sm"
      title={title}
      footer={
        <>
          <Button disabled={isPending} onClick={onClose}>
            {t(commonMessages.cancel)}
          </Button>
          <Button
            data-voice-risk="never"
            loading={isPending}
            onClick={onRemove}
            tone="danger"
          >
            {t(commonMessages.remove)}
          </Button>
        </>
      }
    >
      {error ? (
        <p className="px-5 py-4 text-sm text-app-danger" role="alert">
          {error}
        </p>
      ) : null}
    </ModalDialog>
  );
}

function AddMemberDialog({
  agentDirectoryError,
  agentDirectoryLoading,
  actors,
  availabilityByActorId,
  error,
  isPending,
  onAdd,
  onClose,
  onRetryAgentDirectory,
  sponsoredAgentIds,
}: {
  agentDirectoryError: boolean;
  agentDirectoryLoading: boolean;
  actors: TeamHubActor[];
  availabilityByActorId: ReadonlyMap<string, AgentAvailability>;
  error?: string;
  isPending: boolean;
  onAdd: (actor: TeamHubActor) => void;
  onClose: () => void;
  onRetryAgentDirectory: () => void;
  sponsoredAgentIds: Set<string>;
}) {
  const t = useT();
  return (
    <ModalDialog onClose={onClose} size="md" title={t(m.addRoomMember)}>
      <div className="p-3">
        {agentDirectoryError ? (
          <div
            className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3"
            role="alert"
          >
            <span className="text-sm text-muted-foreground">
              {t(m.agentsUnavailable)}
            </span>
            <Button
              onClick={onRetryAgentDirectory}
              size="compact"
              tone="secondary"
            >
              {t(commonMessages.retry)}
            </Button>
          </div>
        ) : null}
        {agentDirectoryLoading ? (
          <p className="mb-3 text-xs text-muted-foreground" role="status">
            {t(m.loadingAgents)}
          </p>
        ) : null}
        {error ? (
          <p
            className="mb-3 rounded-lg border border-[var(--app-status-danger-border)] bg-[var(--app-status-danger-surface)] p-3 text-sm text-app-danger"
            role="alert"
          >
            {error}
          </p>
        ) : null}
        {actors.length ? (
          actors.map((actor) => (
            <button
              className="flex min-h-13 w-full items-center gap-3 rounded-lg px-2 text-left transition-colors duration-300 hover:bg-muted/70 focus-visible:outline-2 focus-visible:outline-app-focus disabled:opacity-50"
              disabled={isPending}
              key={actor.id}
              onClick={() => onAdd(actor)}
              type="button"
            >
              <ActorAvatar
                actorId={actor.id}
                kind={actor.kind}
                name={actor.display_name}
                size="sm"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {actor.display_name}
                </span>
                <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="truncate">
                    {t(
                      actor.kind === "human"
                        ? agentInfoMessages.human
                        : sponsoredAgentIds.has(actor.id)
                          ? m.yours
                          : agentInfoMessages.agent,
                    )}
                  </span>
                  {availabilityByActorId.has(actor.id) ? (
                    <>
                      <span aria-hidden>·</span>
                      <AgentStatus
                        availability={availabilityByActorId.get(actor.id)!}
                        showDetails
                      />
                    </>
                  ) : null}
                </span>
              </span>
              <Icon
                className="text-muted-foreground"
                icon={PlusSignIcon}
                size={16}
              />
            </button>
          ))
        ) : (
          <p className="p-4 text-center text-sm text-muted-foreground">
            {t(m.everyoneAdded)}
          </p>
        )}
      </div>
    </ModalDialog>
  );
}
