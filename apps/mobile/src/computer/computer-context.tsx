// The paired computers on this phone and the live connection to the active
// one. Switching computers stops one connection and starts another; a
// computer that removed the phone has every trace of it deleted.
import { addNetworkStateListener } from "expo-network";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState } from "react-native";

import { logEvent } from "../lib/app-log";
import { requestJson } from "../session/http";
import type { KeyPair } from "../session/noise";
import type {
  PhoneSession,
  SocketFactory,
  SocketLike,
} from "../session/session";
import { toBase64Url } from "../lib/bytes";
import {
  ComputerConnection,
  type ConnectionStatus,
  type Route,
} from "./connection";
import type { PairingLink } from "./pairing-link";
import {
  parseRelayNodes,
  relayNodesOf,
  sameRelayNodes,
  type RelayChoice,
  type RelayNode,
} from "./relay-nodes";
import { ComputerStore, type PairedComputer } from "./store";
import { documentFiles, keychain } from "./store-expo";

const socketFactory: SocketFactory = (url) =>
  new WebSocket(url) as unknown as SocketLike;

/**
 * What a Relay node costs in use: the median of three request round trips
 * through a session already open on it, not the time to open one.
 */
async function requestRoundTrip(session: PhoneSession): Promise<number> {
  const times: number[] = [];
  for (let index = 0; index < 3; index += 1) {
    const started = Date.now();
    await requestJson(session, "GET", "/v0/session");
    times.push(Date.now() - started);
  }
  return times.sort((a, b) => a - b)[1]!;
}

/** How long a liveness probe may take before the session counts as dead. */
const PROBE_TIMEOUT_MS = 8_000;

export interface ComputerContextValue {
  /** False until the stored computers were read. */
  readonly loaded: boolean;
  readonly store: ComputerStore;
  readonly socketFactory: SocketFactory;
  readonly computers: readonly PairedComputer[];
  readonly active: PairedComputer | undefined;
  readonly status: ConnectionStatus | undefined;
  /** The session once the computer approved this phone. */
  readonly session: PhoneSession | undefined;
  readonly route: Route | undefined;
  /** The Relay node origin the session goes through, if any. */
  readonly relay: string | undefined;
  /** Set after a computer removed this phone and its data was deleted. */
  readonly removedNotice: string | undefined;
  switchTo(hostId: string): Promise<void>;
  /** Deletes the key and every file kept for a computer. */
  unpair(hostId: string): Promise<void>;
  /** Stores a freshly paired computer and takes over its session. */
  completePairing(input: {
    link: PairingLink;
    key: KeyPair;
    session: PhoneSession;
    route: Route;
  }): Promise<void>;
  dismissRemovedNotice(): void;
  /** Dials again now instead of waiting out the backoff. */
  retryNow(): void;
  /** Races every Relay node, or dials only one, and reconnects to apply it. */
  setRelayChoice(choice: RelayChoice): Promise<void>;
  /** Measures every Relay node now and remembers the times. */
  probeRelays(): Promise<void>;
  /** Stores the computer's current Relay nodes, enabled ones only. */
  setRelayNodes(nodes: readonly RelayNode[]): Promise<void>;
}

const ComputerContext = createContext<ComputerContextValue | undefined>(
  undefined,
);

export function useComputer(): ComputerContextValue {
  const value = useContext(ComputerContext);
  if (!value) throw new Error("useComputer outside ComputerProvider");
  return value;
}

function sameOrigins(a: readonly string[], b: readonly string[]): boolean {
  return (
    a.length === b.length && a.every((origin, index) => origin === b[index])
  );
}

export function ComputerProvider(props: { readonly children: ReactNode }) {
  const store = useMemo(() => new ComputerStore(documentFiles, keychain), []);
  const [loaded, setLoaded] = useState(false);
  const [computers, setComputers] = useState<PairedComputer[]>([]);
  const [activeId, setActiveId] = useState<string | undefined>();
  const [connection, setConnection] = useState<
    ComputerConnection | undefined
  >();
  const [status, setStatus] = useState<ConnectionStatus | undefined>();
  const [, setRevision] = useState(0);
  const [removedNotice, setRemovedNotice] = useState<string | undefined>();
  const connectionRef = useRef<ComputerConnection | undefined>(undefined);

  const refresh = useCallback(async () => {
    const list = await store.list();
    setComputers(list);
    return list;
  }, [store]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await refresh();
      const stored = await store.activeId();
      if (cancelled) return;
      setActiveId(
        list.some((item) => item.hostId === stored) ? stored : list[0]?.hostId,
      );
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh, store]);

  const startConnection = useCallback(
    (computer: PairedComputer, key: KeyPair) => {
      connectionRef.current?.stop();
      const next = new ComputerConnection({
        computer,
        staticKey: key,
        socketFactory,
        onWelcome: (welcome) => {
          const latest = next.computer;
          const lan = welcome.lan.length > 0 ? welcome.lan : latest.lan;
          // A computer that lists nodes is the authority, an empty list
          // included. One too old to list them names a single relay, which
          // replaces any list a newer version left behind.
          const relays = parseRelayNodes(welcome.relays);
          const relay = relays
            ? (relays[0]?.url ?? null)
            : welcome.relay || latest.relay;
          if (
            sameOrigins(lan, latest.lan) &&
            relay === latest.relay &&
            sameRelayNodes(
              relayNodesOf({ relay, relays }),
              relayNodesOf(latest),
            )
          )
            return;
          const updated: PairedComputer = { ...latest, lan, relay, relays };
          next.updateComputer(updated);
          void store.save(updated).then(refresh);
        },
      });
      connectionRef.current = next;
      next.subscribe((value) => {
        logEvent("info", "connection.status", {
          kind: value.kind,
          route: value.kind === "connected" ? value.route : undefined,
        });
        setStatus(value);
        setRevision((revision) => revision + 1);
      });
      setConnection(next);
      setStatus(next.status);
      return next;
    },
    [refresh, store],
  );

  // Start the connection for the active computer.
  useEffect(() => {
    if (!loaded || !activeId) return;
    const computer = computers.find((item) => item.hostId === activeId);
    if (!computer) return;
    if (connectionRef.current?.computer.hostId === activeId) return;
    let cancelled = false;
    void (async () => {
      const key = await store.key(activeId);
      if (cancelled) return;
      if (!key) {
        // Metadata without a key cannot reconnect; treat it as unpaired.
        await store.remove(activeId);
        await refresh();
        setActiveId(undefined);
        return;
      }
      startConnection(computer, key).start();
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId, computers, loaded, refresh, startConnection, store]);

  useEffect(() => () => connectionRef.current?.stop(), []);

  const forget = useCallback(
    async (hostId: string) => {
      if (connectionRef.current?.computer.hostId === hostId) {
        connectionRef.current.stop();
        connectionRef.current = undefined;
        setConnection(undefined);
        setStatus(undefined);
      }
      await store.remove(hostId);
      const list = await refresh();
      const next = list[0]?.hostId;
      if (next) await store.setActive(next);
      setActiveId((current) => (current === hostId ? next : current));
    },
    [refresh, store],
  );

  // A computer that removed this phone, or no longer knows it: delete it all.
  useEffect(() => {
    if (status?.kind !== "removed" || !connection) return;
    const { hostId, name } = connection.computer;
    setRemovedNotice(`${name} removed this phone. Pair again to use it.`);
    void forget(hostId);
  }, [connection, forget, status]);

  // Reconnect when the app returns to the foreground or the network changes;
  // a session the OS silently dropped fails the probe and reconnects. A
  // session on a Relay also tries the LAN, which may have just come back.
  useEffect(() => {
    const check = () => {
      const current = connectionRef.current;
      if (!current) return;
      const session = current.readySession;
      if (!session) {
        current.nudge();
        return;
      }
      if (current.route === "relay") current.upgradeToLan();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      requestJson(session, "GET", "/v0/session", { signal: controller.signal })
        .catch(() => session.close())
        .finally(() => clearTimeout(timer));
    };
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") check();
    });
    const network = addNetworkStateListener((event) => {
      if (event.isConnected !== false) check();
    });
    return () => {
      appState.remove();
      network.remove();
    };
  }, []);

  const switchTo = useCallback(
    async (hostId: string) => {
      if (hostId === activeId) return;
      connectionRef.current?.stop();
      connectionRef.current = undefined;
      setConnection(undefined);
      setStatus(undefined);
      await store.setActive(hostId);
      setActiveId(hostId);
    },
    [activeId, store],
  );

  const completePairing = useCallback<ComputerContextValue["completePairing"]>(
    async ({ link, key, session, route }) => {
      const computer: PairedComputer = {
        hostId: link.hostId,
        name: session.welcome.name || link.computerName,
        hostKey: toBase64Url(link.hostKey),
        relay: session.welcome.relay || link.relay,
        relays: parseRelayNodes(session.welcome.relays) ?? link.relays,
        lan: session.welcome.lan.length > 0 ? session.welcome.lan : link.lan,
        phoneId: session.welcome.phone_id,
        pairedAt: new Date().toISOString(),
      };
      await store.add(computer, key);
      await store.setActive(computer.hostId);
      // Adopt before the list refreshes, so the effect that starts the
      // active computer's connection finds this one already running.
      startConnection(computer, key).adopt(session, route);
      setActiveId(computer.hostId);
      setRemovedNotice(undefined);
      await refresh();
    },
    [refresh, startConnection, store],
  );

  /** Applies a change to the active connection's computer and stores it. */
  const updateActive = useCallback(
    async (change: (computer: PairedComputer) => PairedComputer) => {
      const current = connectionRef.current;
      if (!current) return undefined;
      const updated = change(current.computer);
      current.updateComputer(updated);
      await store.save(updated);
      await refresh();
      return current;
    },
    [refresh, store],
  );

  const setRelayChoice = useCallback(
    async (choice: RelayChoice) => {
      const current = await updateActive((computer) => ({
        ...computer,
        relayChoice: choice,
      }));
      current?.reconnect();
    },
    [updateActive],
  );

  const probeRelays = useCallback(async () => {
    const current = connectionRef.current;
    if (!current) return;
    const times = await current.probeRelays(requestRoundTrip);
    await updateActive((computer) => {
      const relayLatency = { ...computer.relayLatency };
      for (const node of relayNodesOf(computer)) {
        const ms = times.get(node.url);
        if (ms === undefined) delete relayLatency[node.url];
        else relayLatency[node.url] = ms;
      }
      return { ...computer, relayLatency };
    });
  }, [updateActive]);

  // Time every node once per launch after the first session opens, so
  // Automatic tries the node that is fastest where the phone is now.
  const probed = useRef(new Set<string>());
  useEffect(() => {
    const hostId = connectionRef.current?.computer.hostId;
    if (status?.kind !== "connected" || !hostId || probed.current.has(hostId))
      return;
    probed.current.add(hostId);
    void probeRelays().catch(() => undefined);
  }, [probeRelays, status]);

  const setRelayNodes = useCallback(
    async (nodes: readonly RelayNode[]) => {
      await updateActive((computer) => ({
        ...computer,
        relays: nodes,
        relay: nodes[0]?.url ?? null,
      }));
    },
    [updateActive],
  );

  const active = computers.find((item) => item.hostId === activeId);
  const session =
    connection && connection.computer.hostId === activeId
      ? connection.readySession
      : undefined;
  const value: ComputerContextValue = {
    loaded,
    store,
    socketFactory,
    computers,
    active,
    status: connection?.computer.hostId === activeId ? status : undefined,
    session,
    route: session ? connection?.route : undefined,
    relay: session ? connection?.relay : undefined,
    removedNotice,
    switchTo,
    unpair: forget,
    completePairing,
    dismissRemovedNotice: () => setRemovedNotice(undefined),
    retryNow: () => connectionRef.current?.nudge(),
    setRelayChoice,
    probeRelays,
    setRelayNodes,
  };
  return (
    <ComputerContext.Provider value={value}>
      {props.children}
    </ComputerContext.Provider>
  );
}
