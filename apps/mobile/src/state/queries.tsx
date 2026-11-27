// Server state through TanStack Query. Every key starts with the computer's
// Host ID, so one computer's cache never shows another's data, and a new
// session refetches what is on screen.
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { useEffect, useMemo, useRef, type ReactNode } from "react";

import {
  getAnotherMe,
  getMe,
  getRoom,
  listAgentAvailability,
  listRoomMembers,
  listRooms,
  listTenantAgents,
} from "../api/teamhub";
import type { ActorRef, RoomListItem, RoomMember } from "../api/types";
import { useComputer } from "../computer/computer-context";
import type { PhoneSession } from "../session/session";

export class NotConnected extends Error {
  constructor() {
    super("Not connected to the computer");
    this.name = "NotConnected";
  }
}

export function teamHubKey(
  hostId: string | undefined,
  ...parts: unknown[]
): QueryKey {
  return ["teamhub", hostId ?? "none", ...parts];
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 10 * 60_000,
        retry: (failures, error) =>
          !(error instanceof NotConnected) && failures < 2,
        refetchOnWindowFocus: false,
      },
    },
  });
}

/** Keeps the cache in step with the active computer and its session. */
function SessionCacheSync() {
  const { active, session } = useComputer();
  const client = useQueryClient();
  const hostId = active?.hostId;
  const previousHost = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (previousHost.current && previousHost.current !== hostId)
      client.removeQueries({ queryKey: ["teamhub", previousHost.current] });
    previousHost.current = hostId;
  }, [client, hostId]);

  useEffect(() => {
    if (session && hostId)
      void client.invalidateQueries({ queryKey: ["teamhub", hostId] });
  }, [client, hostId, session]);

  return null;
}

export function QueryProvider(props: {
  readonly client: QueryClient;
  readonly children: ReactNode;
}) {
  return (
    <QueryClientProvider client={props.client}>
      <SessionCacheSync />
      {props.children}
    </QueryClientProvider>
  );
}

/** The session and Host ID for queries; run() fails fast while offline. */
export interface TeamHubAccess {
  readonly hostId: string | undefined;
  readonly session: PhoneSession | undefined;
  readonly connected: boolean;
  run<T>(call: (session: PhoneSession) => Promise<T>): Promise<T>;
}

export function useTeamHub(): TeamHubAccess {
  const { active, session } = useComputer();
  const hostId = active?.hostId;
  // Stable while the session is, so effects that depend on it do not rerun
  // on every render.
  return useMemo(
    () => ({
      hostId,
      session,
      connected: !!session,
      run<T>(call: (session: PhoneSession) => Promise<T>): Promise<T> {
        if (!session || session.closed)
          return Promise.reject(new NotConnected());
        return call(session);
      },
    }),
    [hostId, session],
  );
}

export interface Identity {
  readonly tenantId: string;
  readonly actorId: string;
  readonly displayName: string;
}

export function useIdentity() {
  const teamHub = useTeamHub();
  return useQuery({
    queryKey: teamHubKey(teamHub.hostId, "me"),
    enabled: teamHub.connected,
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<Identity> => {
      const me = await teamHub.run(getMe);
      const actor = me.actors[0];
      if (!actor) throw new Error("This account has no workspace");
      return {
        tenantId: actor.tenant_id,
        actorId: actor.id,
        displayName: actor.display_name || me.account.email || "",
      };
    },
  });
}

export function useAnotherMe() {
  const teamHub = useTeamHub();
  const identity = useIdentity();
  const tenantId = identity.data?.tenantId;
  return useQuery({
    queryKey: teamHubKey(teamHub.hostId, "another-me", tenantId),
    enabled: teamHub.connected && !!tenantId,
    queryFn: () =>
      teamHub.run((session) => getAnotherMe(session, tenantId ?? "")),
  });
}

/** Whether Another Me's Computer can run tasks; undefined while unknown. */
export function useAnotherMeCanRunTasks(): boolean | undefined {
  const teamHub = useTeamHub();
  const identity = useIdentity();
  const anotherMe = useAnotherMe();
  const tenantId = identity.data?.tenantId;
  const availability = useQuery({
    queryKey: teamHubKey(teamHub.hostId, "agent-availability", tenantId),
    enabled: teamHub.connected && !!tenantId,
    refetchInterval: 60_000,
    queryFn: () =>
      teamHub.run((session) => listAgentAvailability(session, tenantId ?? "")),
  });
  const agentId = anotherMe.data?.agent_actor_id;
  if (!agentId || !availability.data) return undefined;
  const snapshot = availability.data.items.find(
    (item) => item.actor_id === agentId,
  );
  if (!snapshot) return undefined;
  const runtime = snapshot.local_runtime_status;
  if (runtime?.computer_status === "offline") return false;
  if (
    runtime?.connection_status === "offline" ||
    runtime?.connection_status === "reconnecting"
  )
    return false;
  return (
    snapshot.availability.status !== "offline" &&
    snapshot.availability.status !== "error"
  );
}

export function useRooms() {
  const teamHub = useTeamHub();
  const identity = useIdentity();
  const tenantId = identity.data?.tenantId;
  return useQuery({
    queryKey: teamHubKey(teamHub.hostId, "rooms", tenantId),
    enabled: teamHub.connected && !!tenantId,
    queryFn: async (): Promise<RoomListItem[]> => {
      const items: RoomListItem[] = [];
      let cursor: string | undefined;
      // Three pages cover a phone's Room list; older Rooms stay on the computer.
      for (let page = 0; page < 3; page += 1) {
        const result = await teamHub.run((session) =>
          listRooms(session, tenantId ?? "", cursor),
        );
        items.push(...result.items);
        if (!result.page.has_more || !result.page.next_cursor) break;
        cursor = result.page.next_cursor;
      }
      return items;
    },
  });
}

export interface AgentLook {
  readonly avatarKey?: string;
  readonly avatarImageUrl?: string;
}

interface DirectoryAgent extends AgentLook {
  readonly actorId: string;
  readonly displayName: string;
  /** Visible to the whole workspace rather than only its owner. */
  readonly workspace: boolean;
}

/** The Tenant's Agent directory, the few fields screens use. */
function useAgentDirectory() {
  const teamHub = useTeamHub();
  const identity = useIdentity();
  const tenantId = identity.data?.tenantId;
  return useQuery({
    queryKey: teamHubKey(teamHub.hostId, "agents", tenantId),
    enabled: teamHub.connected && !!tenantId,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<DirectoryAgent[]> => {
      const agents: DirectoryAgent[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page += 1) {
        const result = await teamHub.run((session) =>
          listTenantAgents(session, tenantId ?? "", cursor),
        );
        for (const agent of result.items)
          agents.push({
            actorId: agent.actor.id,
            displayName: agent.actor.display_name,
            avatarKey: agent.avatar_key,
            avatarImageUrl: agent.avatar_image_url,
            workspace: agent.visibility_scope === "workspace",
          });
        if (!result.page.has_more || !result.page.next_cursor) break;
        cursor = result.page.next_cursor;
      }
      return agents;
    },
  });
}

/** Each Agent's avatar by Actor ID, from the Tenant's Agent directory. */
export function useAgentLooks(): ReadonlyMap<string, AgentLook> {
  const directory = useAgentDirectory();
  return useMemo(
    () =>
      new Map(
        (directory.data ?? []).map((agent) => [
          agent.actorId,
          {
            avatarKey: agent.avatarKey,
            avatarImageUrl: agent.avatarImageUrl,
          },
        ]),
      ),
    [directory.data],
  );
}

/** Each Agent's name by Actor ID, from the Tenant's Agent directory. */
export function useAgentNames(): ReadonlyMap<string, string> {
  const directory = useAgentDirectory();
  return useMemo(
    () =>
      new Map(
        (directory.data ?? []).map((agent) => [
          agent.actorId,
          agent.displayName,
        ]),
      ),
    [directory.data],
  );
}

/** The Actor IDs of Agents visible to the whole workspace. */
export function useWorkspaceAgentIds(): ReadonlySet<string> {
  const directory = useAgentDirectory();
  return useMemo(
    () =>
      new Set(
        (directory.data ?? [])
          .filter((agent) => agent.workspace)
          .map((agent) => agent.actorId),
      ),
    [directory.data],
  );
}

/** A Room's current members, for @ mentions. */
export function useRoomMembers(roomId: string | undefined) {
  const teamHub = useTeamHub();
  return useQuery({
    queryKey: teamHubKey(teamHub.hostId, "room-members", roomId),
    enabled: teamHub.connected && !!roomId,
    queryFn: async (): Promise<RoomMember[]> =>
      (await teamHub.run((session) => listRoomMembers(session, roomId ?? "")))
        .items,
  });
}

export function useRoom(roomId: string | undefined) {
  const teamHub = useTeamHub();
  return useQuery({
    queryKey: teamHubKey(teamHub.hostId, "room", roomId),
    enabled: teamHub.connected && !!roomId,
    queryFn: () => teamHub.run((session) => getRoom(session, roomId ?? "")),
  });
}

/** The Agent a direct chat is with, whose @ leads every message there. */
export function useDirectAgent(
  roomId: string | undefined,
): ActorRef | undefined {
  const room = useRoom(roomId).data;
  return room?.kind === "direct" && room.direct_peer?.kind === "agent"
    ? room.direct_peer
    : undefined;
}

/** What the Human calls Another Me: its Agent's name, such as Linger. */
export function useAnotherMeName(): string | undefined {
  const roomId = useAnotherMe().data?.room_id;
  return useDirectAgent(roomId)?.display_name;
}
