// The active computer's outbox: written to disk first, then sent whenever a
// session is open, with the identical request each time.
import { now, record } from "../lib/timing";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { createMessage, newIdempotencyKey } from "../api/teamhub";
import type {
  MessageAttachmentUpload,
  VoiceLiveTurnMarker,
} from "../api/types";
import { useComputer } from "../computer/computer-context";
import { documentFiles } from "../computer/store-expo";
import { messagesKey } from "../realtime/realtime-context";
import { teamHubKey } from "../state/queries";
import { insertMessage, type MessagePages } from "./message-cache";
import { composeMessage, type Mentionable } from "./compose-message";
import { Outbox, type OutboxEntry } from "./outbox";

const RETRY_MS = 5_000;
const NO_ENTRIES: readonly OutboxEntry[] = [];

export interface SendOptions {
  /** A key derived from the source, such as a voice turn, so it is sent once. */
  readonly key?: string;
  readonly voiceLiveTurn?: VoiceLiveTurnMarker;
  /** Members the text names with their @ token. */
  readonly mentions?: readonly Mentionable[];
  /** The Agent of a direct chat, whose @ leads every message. */
  readonly directAgent?: Mentionable;
}

interface OutboxValue {
  readonly outbox: Outbox | undefined;
  send(
    roomId: string,
    text: string,
    uploads: readonly MessageAttachmentUpload[],
    options?: SendOptions,
  ): Promise<void>;
  /** Resolves once none of these keys waits, or after timeoutMs. */
  settled(keys: readonly string[], timeoutMs: number): Promise<void>;
  /** Whether the computer accepted every one of these messages in time. */
  delivered(keys: readonly string[], timeoutMs: number): Promise<boolean>;
  retry(key: string): void;
  discard(key: string): void;
}

const OutboxContext = createContext<OutboxValue | undefined>(undefined);

export function useOutbox(): OutboxValue {
  const value = useContext(OutboxContext);
  if (!value) throw new Error("useOutbox outside OutboxProvider");
  return value;
}

export function useOutboxEntries(roomId: string): readonly OutboxEntry[] {
  const { outbox } = useOutbox();
  const subscribe = useCallback(
    (listener: () => void) => outbox?.subscribe(listener) ?? (() => undefined),
    [outbox],
  );
  const all = useSyncExternalStore(
    subscribe,
    () => outbox?.entries() ?? NO_ENTRIES,
  );
  return useMemo(
    () => all.filter((entry) => entry.roomId === roomId),
    [all, roomId],
  );
}

export function OutboxProvider(props: { readonly children: ReactNode }) {
  const { active, session } = useComputer();
  const client = useQueryClient();
  const hostId = active?.hostId;
  const [outbox, setOutbox] = useState<Outbox | undefined>();
  const [kick, setKick] = useState(0);

  useEffect(() => {
    // Drop the previous computer's outbox at once, so nothing it holds can
    // go out through the next computer's session while this one loads.
    setOutbox(undefined);
    if (!hostId) return;
    let cancelled = false;
    const next = new Outbox(documentFiles, hostId, (entry, message) => {
      client.setQueryData<MessagePages>(
        messagesKey(hostId, entry.roomId),
        (data) => insertMessage(data, message),
      );
      void client.invalidateQueries({ queryKey: teamHubKey(hostId, "rooms") });
    });
    void next.load().then(() => {
      if (!cancelled) setOutbox(next);
    });
    return () => {
      cancelled = true;
    };
  }, [client, hostId]);

  // Send whatever waits while a session is open; retry transient failures.
  useEffect(() => {
    if (!outbox || !session || outbox.hostId !== hostId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const run = () => {
      void outbox
        .flush(async (entry) => {
          const started = now();
          const sent = await createMessage(
            session,
            entry.roomId,
            entry.body,
            entry.key,
          );
          record("message.send_to_ack", now() - started);
          return sent;
        })
        .then((done) => {
          if (!done && !stopped) timer = setTimeout(run, RETRY_MS);
        });
    };
    run();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [hostId, kick, outbox, session]);

  const value = useMemo<OutboxValue>(
    () => ({
      outbox,
      async send(roomId, text, uploads, options = {}) {
        if (!outbox) throw new Error("The outbox is not ready yet");
        const key = options.key ?? newIdempotencyKey();
        if (outbox.entries().some((entry) => entry.key === key)) return;
        const body = {
          ...composeMessage({
            text,
            mentions: options.mentions ?? [],
            directAgent: options.directAgent,
          }),
          ...(uploads.length > 0
            ? { attachment_upload_ids: uploads.map((upload) => upload.id) }
            : {}),
          ...(options.voiceLiveTurn
            ? { voice_live_turn: options.voiceLiveTurn }
            : {}),
        };
        await outbox.enqueue({
          key,
          roomId,
          body,
          attachmentNames: uploads.map((upload) => upload.filename),
        });
        setKick((value) => value + 1);
      },
      async delivered(keys, timeoutMs) {
        await this.settled(keys, timeoutMs);
        // A delivered message leaves the outbox; one still there is waiting
        // or failed.
        return !(outbox?.entries() ?? []).some((entry) =>
          keys.includes(entry.key),
        );
      },
      settled(keys, timeoutMs) {
        return new Promise<void>((resolve) => {
          if (!outbox) {
            resolve();
            return;
          }
          const waiting = () =>
            outbox
              .entries()
              .some(
                (entry) =>
                  entry.state === "sending" && keys.includes(entry.key),
              );
          const finish = () => {
            clearTimeout(timer);
            unsubscribe();
            resolve();
          };
          const timer = setTimeout(finish, timeoutMs);
          const unsubscribe = outbox.subscribe(() => {
            if (!waiting()) finish();
          });
          if (!waiting()) finish();
        });
      },
      retry(key) {
        void outbox?.retry(key).then(() => setKick((value) => value + 1));
      },
      discard(key) {
        void outbox?.discard(key);
      },
    }),
    [outbox],
  );

  return (
    <OutboxContext.Provider value={value}>
      {props.children}
    </OutboxContext.Provider>
  );
}
