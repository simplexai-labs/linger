// Runs the session's event stream and projects Room Events and hints into
// the query cache, the way Web's event sync does for the views a phone has.
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { getMessage, listRoomEvents } from "../api/teamhub";
import type { Message, RoomEventEnvelope, RoomRunStatus } from "../api/types";
import {
  findMessage,
  insertMessage,
  replaceMessage,
  type MessagePages,
} from "../chat/message-cache";
import { mergeRun, type RunView } from "../chat/run-status";
import { useComputer } from "../computer/computer-context";
import { subscribe } from "../session/http";
import type { PhoneSession } from "../session/session";
import { teamHubKey } from "../state/queries";
import { RoomEventSync } from "./room-events";

export type RunViews = Readonly<Record<string, RunView>>;

interface RealtimeValue {
  watchRoom(roomId: string, snapshotSeq: number): void;
  appliedSeq(roomId: string): number | undefined;
  subscribeSeq(listener: () => void): () => void;
}

const RealtimeContext = createContext<RealtimeValue | undefined>(undefined);

export function useRealtime(): RealtimeValue {
  const value = useContext(RealtimeContext);
  if (!value) throw new Error("useRealtime outside RealtimeProvider");
  return value;
}

/** The last room_seq applied for a Room, for its read state. */
export function useAppliedSeq(roomId: string | undefined): number | undefined {
  const realtime = useRealtime();
  return useSyncExternalStore(realtime.subscribeSeq, () =>
    roomId ? realtime.appliedSeq(roomId) : undefined,
  );
}

export function messagesKey(hostId: string | undefined, roomId: string) {
  return teamHubKey(hostId, "messages", roomId);
}

export function runsKey(hostId: string | undefined, roomId: string) {
  return teamHubKey(hostId, "runs", roomId);
}

export function applyRunStatus(
  client: QueryClient,
  hostId: string | undefined,
  run: RoomRunStatus,
): void {
  client.setQueryData<RunViews>(runsKey(hostId, run.room_id), (current) => ({
    ...current,
    [run.run_id]: mergeRun(current?.[run.run_id], run),
  }));
}

function refreshMessage(
  client: QueryClient,
  session: PhoneSession,
  hostId: string,
  roomId: string,
  messageId: string,
): void {
  // Off the event queue: a slow read must not hold later Room Events.
  void getMessage(session, roomId, messageId)
    .then((message: Message) =>
      client.setQueryData<MessagePages>(messagesKey(hostId, roomId), (data) =>
        replaceMessage(data, message),
      ),
    )
    // The event is spent, so a failed read leaves the cached list to refetch.
    .catch(
      () =>
        void client.invalidateQueries({
          queryKey: messagesKey(hostId, roomId),
        }),
    );
}

function project(
  client: QueryClient,
  session: PhoneSession,
  hostId: string,
  event: RoomEventEnvelope,
): void {
  const roomId = event.room_id;
  const payload = event.payload as unknown as Record<string, unknown>;
  switch (event.event_type) {
    case "message.created": {
      const message = payload.message as Message | undefined;
      if (!message) return;
      client.setQueryData<MessagePages>(messagesKey(hostId, roomId), (data) =>
        insertMessage(data, message),
      );
      if (
        message.author.kind === "agent" &&
        message.message_kind === "conversation"
      )
        refreshMessage(client, session, hostId, roomId, message.id);
      void client.invalidateQueries({ queryKey: teamHubKey(hostId, "rooms") });
      return;
    }
    case "card.changed": {
      const messageId = payload.message_id as string;
      const version = payload.version as number;
      const cached = findMessage(
        client.getQueryData<MessagePages>(messagesKey(hostId, roomId)),
        messageId,
      );
      if (cached?.card && cached.card.version < version)
        refreshMessage(client, session, hostId, roomId, messageId);
      return;
    }
    case "agent_run.status_changed": {
      const run = payload.run as RoomRunStatus | undefined;
      if (run) applyRunStatus(client, hostId, run);
      return;
    }
    case "room.created":
    case "room.updated":
    case "room.participation.changed":
    case "room.deleted":
    case "room.member.added":
    case "room.member.removed":
    case "room.member.role_changed":
      void client.invalidateQueries({ queryKey: teamHubKey(hostId, "rooms") });
      void client.invalidateQueries({
        queryKey: teamHubKey(hostId, "room", roomId),
      });
      return;
    default:
      return;
  }
}

export function RealtimeProvider(props: { readonly children: ReactNode }) {
  const { active, session } = useComputer();
  const client = useQueryClient();
  const hostId = active?.hostId;
  const syncRef = useRef<RoomEventSync | undefined>(undefined);
  // Rooms watched on this computer and their last applied room_seq; a new
  // session's stream resumes from these.
  const applied = useRef(new Map<string, number>());
  const listeners = useRef(new Set<() => void>());

  const notify = useCallback(() => {
    for (const listener of [...listeners.current]) listener();
  }, []);

  useEffect(() => {
    applied.current = new Map();
    notify();
  }, [hostId, notify]);

  useEffect(() => {
    if (!session || !hostId) return;
    const sync = new RoomEventSync(
      {
        subscribe: (path, handlers) => subscribe(session, path, handlers),
        listRoomEvents: (roomId, after) =>
          listRoomEvents(session, roomId, after),
      },
      {
        applyRoomEvent: (event) => {
          project(client, session, hostId, event);
          applied.current.set(event.room_id, event.room_seq);
          notify();
        },
        onInvalidated: (event) => {
          const key = (...parts: unknown[]) => teamHubKey(hostId, ...parts);
          switch (event.resource) {
            case "room":
              void client.invalidateQueries({ queryKey: key("rooms") });
              void client.invalidateQueries({
                queryKey: key("room", event.id),
              });
              return;
            case "another-me":
            case "directory":
            case "agents":
            case "computers":
              void client.invalidateQueries({ queryKey: key("another-me") });
              void client.invalidateQueries({
                queryKey: key("agent-availability"),
              });
              void client.invalidateQueries({ queryKey: key("rooms") });
              return;
            case "document":
            case "document-access":
              void client.invalidateQueries({ queryKey: key("documents") });
              void client.invalidateQueries({
                queryKey: key("document", event.id),
              });
              return;
            default:
              return;
          }
        },
        onResync: () => {
          void client.invalidateQueries({ queryKey: ["teamhub", hostId] });
        },
        // The device Session behind the stream ended; a new session
        // revalidates it or the computer refuses the phone.
        onSessionExpired: () => session.close(),
      },
    );
    syncRef.current = sync;
    sync.start();
    for (const [roomId, seq] of applied.current) sync.watch(roomId, seq);
    return () => {
      sync.stop();
      if (syncRef.current === sync) syncRef.current = undefined;
    };
  }, [client, hostId, notify, session]);

  const value = useMemo<RealtimeValue>(
    () => ({
      watchRoom(roomId, snapshotSeq) {
        const known = applied.current.get(roomId);
        if (known === undefined || snapshotSeq > known) {
          applied.current.set(roomId, Math.max(snapshotSeq, known ?? 0));
          notify();
        }
        syncRef.current?.watch(
          roomId,
          applied.current.get(roomId) ?? snapshotSeq,
        );
      },
      appliedSeq(roomId) {
        return applied.current.get(roomId);
      },
      subscribeSeq(listener) {
        listeners.current.add(listener);
        return () => listeners.current.delete(listener);
      },
    }),
    [notify],
  );

  return (
    <RealtimeContext.Provider value={value}>
      {props.children}
    </RealtimeContext.Provider>
  );
}
