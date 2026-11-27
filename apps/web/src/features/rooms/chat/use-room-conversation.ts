import {
  type QueryClient,
  type QueryKey,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  type ComponentProps,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import type { TeamHubMessagePresentation } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubMessage,
  TeamHubTenantAgent,
} from "@/features/teamhub/teamhub-types";

import type { RoomMessageSender } from "./room-message-sender";

import {
  teamHubQueryRoot,
  tenantAgentsQueryOptions,
  tenantRoomActivityQueryKey,
} from "../room-queries";
import { visibleDirectPeerRunStatuses } from "./direct-peer-streaming";
import type { AgentStreamingStatusDock } from "./message-timeline";
import { useMessageReactionToggle } from "./message-reactions/use-message-reaction-toggle";
import type { RoomMessageOutboxScope } from "./room-message-outbox";
import { useRoomAgentStreamingStatus } from "./use-room-agent-streaming-status";
import { useRoomMessageDelivery } from "./use-room-message-delivery";

const EMPTY_AGENT_RUNTIME_UPDATED_AT: Readonly<Record<string, string>> = {};

interface ObservedAgentRuntime {
  runtimeKey: string;
  changedAt?: string;
}

interface AgentRuntimeChangeTracker {
  getSnapshot(tenantId: string): Readonly<Record<string, string>>;
  subscribe(listener: () => void): () => void;
}

// Scoped per QueryClient so runtime-change timestamps survive Room <-> Settings
// navigation within a session while staying isolated across test clients.
const agentRuntimeTrackers = new WeakMap<
  QueryClient,
  AgentRuntimeChangeTracker
>();

function agentRuntimeFingerprint(
  runtime: TeamHubTenantAgent["runtime"],
): string {
  const placement = runtime.placement;
  return JSON.stringify([
    runtime.model,
    runtime.reasoning_effort ?? "",
    placement?.type ?? "",
    placement?.computer_id ?? "",
    placement?.runtime_type ?? "",
    placement?.workspace_grant_id ?? "",
  ]);
}

function tenantIdFromAgentsQueryKey(
  queryKey: readonly unknown[],
): string | undefined {
  if (
    queryKey.length === 3 &&
    queryKey[0] === teamHubQueryRoot[0] &&
    typeof queryKey[1] === "string" &&
    queryKey[2] === "agents"
  ) {
    return queryKey[1];
  }
  return undefined;
}

function tenantAgentItems(
  value: unknown,
): readonly TeamHubTenantAgent[] | undefined {
  if (typeof value !== "object" || value === null || !("items" in value)) {
    return undefined;
  }
  return Array.isArray(value.items)
    ? (value.items as readonly TeamHubTenantAgent[])
    : undefined;
}

function getOrCreateAgentRuntimeTracker(
  queryClient: QueryClient,
): AgentRuntimeChangeTracker {
  const existing = agentRuntimeTrackers.get(queryClient);
  if (existing) return existing;

  const observedByTenant = new Map<string, Map<string, ObservedAgentRuntime>>();
  const snapshotsByTenant = new Map<string, Readonly<Record<string, string>>>();
  const listeners = new Set<() => void>();

  const observe = (tenantId: string, items: readonly TeamHubTenantAgent[]) => {
    let observed = observedByTenant.get(tenantId);
    if (!observed) {
      observed = new Map();
      observedByTenant.set(tenantId, observed);
    }
    let snapshotChanged = false;
    for (const agent of items) {
      const runtimeKey = agentRuntimeFingerprint(agent.runtime);
      const previous = observed.get(agent.actor.id);
      if (!previous) {
        observed.set(agent.actor.id, { runtimeKey });
      } else if (previous.runtimeKey !== runtimeKey) {
        observed.set(agent.actor.id, {
          runtimeKey,
          changedAt: agent.updated_at,
        });
        snapshotChanged = true;
      }
    }
    if (!snapshotChanged) return;
    const nextSnapshot: Record<string, string> = {};
    for (const [actorId, entry] of observed) {
      if (entry.changedAt !== undefined) {
        nextSnapshot[actorId] = entry.changedAt;
      }
    }
    snapshotsByTenant.set(tenantId, nextSnapshot);
    for (const listener of listeners) {
      listener();
    }
  };

  for (const query of queryClient.getQueryCache().getAll()) {
    const tenantId = tenantIdFromAgentsQueryKey(query.queryKey);
    const items = tenantId ? tenantAgentItems(query.state.data) : undefined;
    if (tenantId && items) {
      observe(tenantId, items);
    }
  }

  queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "added" && event.type !== "updated") return;
    const tenantId = tenantIdFromAgentsQueryKey(event.query.queryKey);
    const items = tenantId
      ? tenantAgentItems(event.query.state.data)
      : undefined;
    if (tenantId && items) {
      observe(tenantId, items);
    }
  });

  const tracker: AgentRuntimeChangeTracker = {
    getSnapshot(tenantId: string) {
      return snapshotsByTenant.get(tenantId) ?? EMPTY_AGENT_RUNTIME_UPDATED_AT;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  agentRuntimeTrackers.set(queryClient, tracker);
  return tracker;
}

/**
 * Tracks per-Agent timestamps when `agent.runtime` changes in the tenant
 * directory cache, ignoring profile/avatar edits that bump `updated_at`
 * without changing model, reasoning effort, or placement.
 */
export function useAgentRuntimeUpdatedAtByActorId(
  tenantId: string,
): Readonly<Record<string, string>> {
  const queryClient = useQueryClient();
  const subscribe = useCallback(
    (listener: () => void) =>
      getOrCreateAgentRuntimeTracker(queryClient).subscribe(listener),
    [queryClient],
  );
  const getSnapshot = useCallback(
    () =>
      agentRuntimeTrackers.get(queryClient)?.getSnapshot(tenantId) ??
      EMPTY_AGENT_RUNTIME_UPDATED_AT,
    [queryClient, tenantId],
  );
  return useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => EMPTY_AGENT_RUNTIME_UPDATED_AT,
  );
}

/**
 * The live conversation of one Room: Agent streaming from the Run statuses
 * TeamHub pushes, the Message Outbox, and reactions. Room chat and a Thread
 * share it. Until `roomId` names a Room nothing subscribes.
 */
export function useRoomConversation({
  client,
  composition,
  currentActorId,
  directPeerAgentId,
  documentsQueryKey,
  enabled,
  messages,
  messagesQueryKey,
  onMessagePresented,
  openLiveActivity,
  outboxScope,
  roomId,
  tenantId,
}: {
  client: TeamHubClient;
  composition: RoomMessageSender;
  currentActorId?: string;
  /** Streaming shows only this Agent: the peer of a Direct Room. */
  directPeerAgentId?: string;
  documentsQueryKey?: QueryKey;
  enabled: boolean;
  /** The Room's Messages, oldest first. */
  messages: readonly TeamHubMessage[];
  messagesQueryKey: QueryKey;
  onMessagePresented?: (
    messageId: string,
    presentation: TeamHubMessagePresentation,
  ) => void;
  openLiveActivity: (
    agent: { display_name: string; id: string },
    runStatusId: string,
    runId?: string,
  ) => void;
  outboxScope: RoomMessageOutboxScope;
  roomId: string;
  tenantId: string;
}) {
  const queryClient = useQueryClient();
  const live = enabled && Boolean(roomId);
  const agentStreaming = useRoomAgentStreamingStatus({
    enabled: live,
    messages,
    roomId,
    tenantId,
  });
  const delivery = useRoomMessageDelivery({
    composition,
    documentsQueryKey,
    messagesQueryKey,
    // The woken Agent's Run status arrives on the event stream.
    onMessageCommitted: () => {
      void queryClient.invalidateQueries({
        queryKey: tenantRoomActivityQueryKey(tenantId),
      });
    },
    onMessagePresented,
    outboxScope,
    roomId,
  });
  const toggleReaction = useMessageReactionToggle({
    client,
    currentActorId,
    queryClient,
    roomId,
    tenantId,
  });
  useQuery({
    ...tenantAgentsQueryOptions(client, tenantId),
    enabled: live,
  });
  const agentRuntimeUpdatedAtByActorId =
    useAgentRuntimeUpdatedAtByActorId(tenantId);
  const streamingRunStatuses = useMemo(
    () =>
      visibleDirectPeerRunStatuses(
        agentStreaming.runStatuses,
        directPeerAgentId,
      ),
    [agentStreaming.runStatuses, directPeerAgentId],
  );
  // Re-read the clock when the next pending card lapses, so an expired card
  // stops holding its Agent's line at waiting without a new Message.
  const [now, setNow] = useState(Date.now);
  const pending = useMemo(
    () => pendingDecisionsByRequester(messages, currentActorId, now),
    [messages, currentActorId, now],
  );
  useEffect(() => {
    if (pending.nextExpiry === undefined) return;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(0, pending.nextExpiry - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [pending.nextExpiry]);
  const dock: ComponentProps<typeof AgentStreamingStatusDock> = {
    agentRuntimeUpdatedAtByActorId,
    cancelRoomRun: (runId, requestId) =>
      teamHubData(
        client.api.POST("/v0/rooms/{roomId}/runs/{runId}/cancel", {
          params: { path: { roomId, runId } },
          body: { request_id: requestId },
        }),
      ),
    redeliverRoomRun: (runId) =>
      teamHubData(
        client.api.POST(
          "/v0/rooms/{roomId}/runs/{runId}/redeliver-unconfirmed-inputs",
          { params: { path: { roomId, runId } } },
        ),
      ),
    runStatuses: streamingRunStatuses,
    onViewActivity: (runStatusId, agent, runId) => {
      if (runId) {
        openLiveActivity(agent, runStatusId, runId);
        return;
      }
      const runStatus = streamingRunStatuses.find(
        (item) => item.id === runStatusId,
      );
      openLiveActivity(
        runStatus?.agent ?? agent,
        runStatus?.id ?? runStatusId,
        runStatus?.run_id,
      );
    },
    runtimePresentationEventsByRunStatusId:
      agentStreaming.runtimePresentationEventsByRunStatusId,
    scopeKey: ["teamhub", tenantId, roomId],
    waitingDecisionSince: pending.since,
  };

  return {
    agentStreaming,
    delivery,
    dock,
    pendingMessages: delivery.outgoing,
    streamingRunStatuses,
    toggleReaction,
  };
}

/** Infinite-query pages arrive newest first; the timeline reads oldest first. */
export function orderRoomMessages(
  pages: readonly { items: TeamHubMessage[] }[],
) {
  return pages
    .slice()
    .reverse()
    .flatMap((page) => page.items)
    .sort(compareRoomMessages);
}

function compareRoomMessages(
  left: TeamHubMessage,
  right: TeamHubMessage,
): number {
  if (left.created_at !== right.created_at) {
    return left.created_at < right.created_at ? -1 : 1;
  }
  if (left.id === right.id) return 0;
  // A Room notice written with a Message, such as the member a mention just
  // admitted, shares its time and reads before it.
  const leftNotice = left.message_kind === "room_notice";
  if (leftNotice !== (right.message_kind === "room_notice")) {
    return leftNotice ? -1 : 1;
  }
  return left.id < right.id ? -1 : 1;
}

/**
 * The decision cards in these Messages that still wait on `ownerId`: for each
 * requesting Agent, when its newest one was posted, and when the first of
 * them lapses. Cards another Human decides are left out, since this Human
 * cannot answer them.
 */
export function pendingDecisionsByRequester(
  messages: readonly TeamHubMessage[],
  ownerId: string | undefined,
  now: number,
): { since: ReadonlyMap<string, string>; nextExpiry?: number } {
  const since = new Map<string, string>();
  let nextExpiry: number | undefined;
  if (!ownerId) return { since };
  for (const { card, created_at } of messages) {
    if (card?.status !== "pending" || card.decision_owner.id !== ownerId)
      continue;
    const expiry = card.expires_at ? Date.parse(card.expires_at) : undefined;
    if (expiry !== undefined && expiry <= now) continue;
    if (
      expiry !== undefined &&
      (nextExpiry === undefined || expiry < nextExpiry)
    )
      nextExpiry = expiry;
    const newest = since.get(card.requester.id);
    if (!newest || Date.parse(newest) < Date.parse(created_at))
      since.set(card.requester.id, created_at);
  }
  return nextExpiry === undefined ? { since } : { since, nextExpiry };
}
