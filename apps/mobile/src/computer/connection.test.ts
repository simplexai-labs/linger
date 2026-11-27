import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { toBase64Url } from "../lib/bytes";
import { generateKeyPair } from "../session/noise";
import {
  PhoneSession,
  SessionClosed,
  SessionRefused,
  type SocketLike,
  type Welcome,
} from "../session/session";
import {
  backoffDelay,
  ComputerConnection,
  type Clock,
  type ConnectionStatus,
  type ManagedSession,
  type OpenInput,
} from "./connection";
import type { PairedComputer } from "./store";

class FakeSession implements ManagedSession {
  closed = false;
  openSockets = 0;
  closeFrame: { code: number; reason: string } | undefined;
  #close = new Set<(reason: string) => void>();
  #approved = new Set<() => void>();
  #isApproved = false;

  constructor(
    readonly url: string,
    readonly welcome: Welcome,
  ) {}

  get pending(): boolean {
    return this.welcome.type === "pending" && !this.#isApproved;
  }

  approve(): void {
    this.#isApproved = true;
    for (const listener of this.#approved) listener();
  }

  onApproved(listener: () => void): () => void {
    this.#approved.add(listener);
    return () => this.#approved.delete(listener);
  }

  onClose(listener: (reason: string) => void): () => void {
    this.#close.add(listener);
    return () => this.#close.delete(listener);
  }

  drop(frame?: { code: number; reason: string }): void {
    if (this.closed) return;
    this.closed = true;
    this.closeFrame = frame;
    for (const listener of this.#close) listener("dropped");
  }

  close(): void {
    this.drop();
  }
}

const hostId = "c".repeat(32);
const computer: PairedComputer = {
  hostId,
  name: "Studio Mac",
  hostKey: toBase64Url(generateKeyPair().publicKey),
  relay: "wss://relay.example",
  lan: ["ws://10.0.0.2:7443", "ws://10.0.0.3:7443"],
  phoneId: "phone_1",
  pairedAt: "2026-11-01T00:00:00Z",
};
const lanA = `ws://10.0.0.2:7443/v1/connect/${hostId}`;
const lanB = `ws://10.0.0.3:7443/v1/connect/${hostId}`;
const relay = `wss://relay.example/v1/connect/${hostId}`;

interface Outcome {
  at: number;
  welcome?: Partial<Welcome>;
  error?: Error;
  ignoreAbort?: boolean;
}

interface Dialed {
  url: string;
  at: number;
  signal?: AbortSignal;
  session?: FakeSession;
}

function harness(
  script: (url: string, round: number) => Outcome | undefined,
  target: PairedComputer = computer,
) {
  const dialed: Dialed[] = [];
  const rounds = new Map<string, number>();
  const start = Date.now();
  const open = (input: OpenInput): Promise<FakeSession> => {
    const round = rounds.get(input.url) ?? 0;
    rounds.set(input.url, round + 1);
    const outcome = script(input.url, round) ?? {
      at: 0,
      error: new SessionClosed("refused"),
    };
    const entry: Dialed = {
      url: input.url,
      at: Date.now() - start,
      signal: input.signal,
    };
    dialed.push(entry);
    expect(input.hello).toEqual({ type: "resume" });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (outcome.error) {
          reject(outcome.error);
          return;
        }
        entry.session = new FakeSession(input.url, {
          type: "welcome",
          phone_id: "phone_1",
          lan: [],
          ...outcome.welcome,
        });
        resolve(entry.session);
      }, outcome.at);
      input.signal?.addEventListener("abort", () => {
        if (outcome.ignoreAbort) return;
        clearTimeout(timer);
        reject(new SessionClosed("aborted"));
      });
    });
  };
  const clock: Clock = {
    now: () => Date.now(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
    random: () => 0,
  };
  const statuses: ConnectionStatus[] = [];
  const connection = new ComputerConnection<FakeSession>({
    computer: target,
    staticKey: generateKeyPair(),
    socketFactory: () => {
      throw new Error("not used");
    },
    open,
    clock,
  });
  connection.subscribe((status) => statuses.push(status));
  return { connection, dialed, statuses };
}

describe("ComputerConnection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives LAN a 300 ms head start and keeps the first session", async () => {
    const { connection, dialed } = harness((url) =>
      url === lanA ? { at: 120 } : { at: 5_000 },
    );
    connection.start();
    await vi.advanceTimersByTimeAsync(200);
    expect(connection.status).toEqual({ kind: "connected", route: "lan" });
    expect(dialed.map((dial) => dial.url)).toEqual([lanA, lanB]);
    expect(dialed[1]?.signal?.aborted).toBe(true);
  });

  it("dials the Relay after the head start and closes a slower winner", async () => {
    const { connection, dialed } = harness((url) =>
      url === relay ? { at: 50 } : { at: 1_000, ignoreAbort: true },
    );
    connection.start();
    await vi.advanceTimersByTimeAsync(299);
    expect(dialed.map((dial) => dial.url)).toEqual([lanA, lanB]);
    await vi.advanceTimersByTimeAsync(60);
    expect(dialed.find((dial) => dial.url === relay)?.at).toBe(300);
    expect(connection.status).toEqual({ kind: "connected", route: "relay" });
    expect(connection.session?.url).toBe(relay);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(
      dialed
        .filter((dial) => dial.url !== relay)
        .every((dial) => dial.session?.closed),
    ).toBe(true);
    expect(connection.session?.url).toBe(relay);
  });

  it("moves a Relay session to the LAN once the LAN answers", async () => {
    // Round 0: the LAN is down, so the Relay wins. Later the LAN comes back.
    const { connection, dialed, statuses } = harness((url, round) =>
      url === relay
        ? { at: 50 }
        : round === 0
          ? { at: 100, error: new SessionClosed("unreachable") }
          : url === lanA
            ? { at: 80 }
            : { at: 2_000, error: new SessionClosed("unreachable") },
    );
    connection.start();
    await vi.advanceTimersByTimeAsync(400);
    expect(connection.route).toBe("relay");
    const relaySession = connection.session!;
    let reconnects = 0;
    connection.subscribe((status) => {
      if (status.kind !== "connected") reconnects += 1;
    });

    connection.upgradeToLan();
    connection.upgradeToLan(); // a dial already running is not repeated
    await vi.advanceTimersByTimeAsync(100);
    expect(dialed.filter((dial) => dial.url === relay)).toHaveLength(1);
    expect(connection.route).toBe("lan");
    expect(connection.session?.url).toBe(lanA);
    expect(relaySession.closed).toBe(true);
    expect(statuses.at(-1)).toEqual({ kind: "connected", route: "lan" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reconnects).toBe(0);
    expect(connection.session?.url).toBe(lanA);
  });

  it("keeps the Relay session when the LAN does not answer, and retries every 30 s", async () => {
    const { connection, dialed } = harness((url, round) =>
      url === relay
        ? { at: 50 }
        : round < 2
          ? { at: 100, error: new SessionClosed("unreachable") }
          : { at: 80 },
    );
    connection.start();
    await vi.advanceTimersByTimeAsync(400);
    const relaySession = connection.session!;
    connection.upgradeToLan();
    await vi.advanceTimersByTimeAsync(200);
    expect(connection.session).toBe(relaySession);
    expect(connection.status).toEqual({ kind: "connected", route: "relay" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(connection.route).toBe("lan");
    expect(relaySession.closed).toBe(true);
    expect(dialed.filter((dial) => dial.url === relay)).toHaveLength(1);
  });

  it("does not move a session with a voice call open", async () => {
    const { connection } = harness((url, round) =>
      url === relay
        ? { at: 50 }
        : round === 0
          ? { at: 100, error: new SessionClosed("unreachable") }
          : { at: 80 },
    );
    connection.start();
    await vi.advanceTimersByTimeAsync(400);
    const relaySession = connection.session! as FakeSession & {
      openSockets: number;
    };
    relaySession.openSockets = 1;
    connection.upgradeToLan();
    await vi.advanceTimersByTimeAsync(200);
    expect(connection.session).toBe(relaySession);
    relaySession.openSockets = 0;
    connection.upgradeToLan();
    await vi.advanceTimersByTimeAsync(200);
    expect(connection.route).toBe("lan");
  });

  it("tries the fastest Relay node first and the rest after 250 ms", async () => {
    const mainland = `ws://198.51.100.7:7787/v1/connect/${hostId}`;
    const nodes: PairedComputer = {
      ...computer,
      lan: [],
      relays: [
        { id: "global", url: "wss://relay.example", label: "Global" },
        { id: "mainland", url: "ws://198.51.100.7:7787", label: "Mainland" },
      ],
      relayLatency: { "ws://198.51.100.7:7787": 40 },
    };
    const { connection, dialed } = harness(
      (url) => (url === mainland ? { at: 400 } : { at: 60 }),
      nodes,
    );
    connection.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(dialed.map((dial) => dial.url)).toEqual([mainland]);
    await vi.advanceTimersByTimeAsync(249);
    expect(dialed.map((dial) => [dial.url, dial.at])).toEqual([
      [mainland, 0],
      [relay, 250],
    ]);
    await vi.advanceTimersByTimeAsync(60);
    expect(connection.relay).toBe("wss://relay.example");
  });

  it("dials only a pinned Relay node", async () => {
    const pinned: PairedComputer = {
      ...computer,
      lan: [],
      relays: [
        { id: "global", url: "wss://relay.example", label: "Global" },
        { id: "mainland", url: "ws://198.51.100.7:7787", label: "Mainland" },
      ],
      relayChoice: "global",
    };
    const { connection, dialed } = harness(() => ({ at: 10 }), pinned);
    connection.start();
    await vi.advanceTimersByTimeAsync(400);
    expect(dialed.map((dial) => dial.url)).toEqual([relay]);
    expect(connection.status).toEqual({ kind: "connected", route: "relay" });
  });

  it("goes to the Relay as soon as every LAN dial failed", async () => {
    const { connection, dialed } = harness((url) =>
      url === relay
        ? { at: 10 }
        : { at: 40, error: new SessionClosed("unreachable") },
    );
    connection.start();
    await vi.advanceTimersByTimeAsync(60);
    expect(dialed.find((dial) => dial.url === relay)?.at).toBe(40);
    expect(connection.status).toEqual({ kind: "connected", route: "relay" });
  });

  it("backs off from 1 s toward 30 s with jitter and retries at once when nudged", async () => {
    const { connection, dialed, statuses } = harness(() => ({
      at: 0,
      error: new SessionClosed("unreachable"),
    }));
    connection.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(connection.status.kind).toBe("offline");
    await vi.advanceTimersByTimeAsync(4_000);
    const roundStarts = dialed
      .filter((dial) => dial.url === lanA)
      .map((dial) => dial.at);
    const gaps = roundStarts
      .slice(1)
      .map((at, index) => at - (roundStarts[index] ?? 0));
    // random() is 0, so each delay is half the base: 500, 1000, 2000 ms
    // after the round that failed (which itself takes a tick or two).
    expect(gaps).toHaveLength(3);
    gaps.forEach((gap, index) => {
      expect(gap).toBeGreaterThanOrEqual(500 * 2 ** index);
      expect(gap).toBeLessThanOrEqual(500 * 2 ** index + 5);
    });
    const before = dialed.length;
    connection.nudge();
    await vi.advanceTimersByTimeAsync(1);
    expect(dialed.length).toBeGreaterThan(before);
    expect(
      statuses.filter((status) => status.kind === "offline").length,
    ).toBeGreaterThan(2);
    connection.stop();
  });

  it("computes the backoff bounds", () => {
    expect(backoffDelay(0, 0)).toBe(500);
    expect(backoffDelay(0, 1)).toBe(1_000);
    expect(backoffDelay(3, 1)).toBe(8_000);
    expect(backoffDelay(10, 1)).toBe(30_000);
    expect(backoffDelay(50, 0)).toBe(15_000);
  });

  it("stops for good when the computer removed the phone", async () => {
    const { connection, dialed } = harness((url) =>
      url === lanA
        ? { at: 10, error: new SessionRefused("PHONE_REMOVED") }
        : { at: 5_000 },
    );
    connection.start();
    await vi.advanceTimersByTimeAsync(20);
    expect(connection.status).toEqual({ kind: "removed" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(dialed.map((dial) => dial.url)).toEqual([lanA, lanB]);
    connection.nudge();
    await vi.advanceTimersByTimeAsync(0);
    expect(dialed).toHaveLength(2);
  });

  it("shows the code while pending and becomes connected once approved", async () => {
    const { connection } = harness((url) =>
      url === lanA
        ? { at: 5, welcome: { type: "pending", code: "123456" } }
        : { at: 5_000 },
    );
    connection.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(connection.status).toEqual({
      kind: "pending",
      route: "lan",
      code: "123456",
    });
    expect(connection.readySession).toBeUndefined();
    connection.session?.approve();
    expect(connection.status).toEqual({ kind: "connected", route: "lan" });
    expect(connection.readySession).toBe(connection.session);
  });

  it("wipes only on a refusal inside the handshake, never on a close reason", async () => {
    let refuse = false;
    const { connection, dialed } = harness((url) =>
      url === lanA
        ? refuse
          ? { at: 5, error: new SessionRefused("PHONE_REMOVED") }
          : { at: 5 }
        : { at: 5_000 },
    );
    connection.start();
    await vi.advanceTimersByTimeAsync(10);
    const first = connection.session;
    await vi.advanceTimersByTimeAsync(20_000);
    first?.drop({ code: 1006, reason: "" });
    expect(connection.status).toEqual({ kind: "connecting" });
    await vi.advanceTimersByTimeAsync(10);
    expect(connection.status).toEqual({ kind: "connected", route: "lan" });
    expect(dialed.filter((dial) => dial.url === lanA)).toHaveLength(2);
    refuse = true;
    connection.session?.drop({ code: 4403, reason: "PHONE_REMOVED" });
    expect(connection.status).toEqual({ kind: "connecting" });
    await vi.advanceTimersByTimeAsync(10);
    expect(connection.status).toEqual({ kind: "removed" });
  });

  it("reports a changed key after handshakes against the pinned key keep failing", async () => {
    // A computer whose key no longer matches cannot read the phone's first
    // handshake message and closes with 4400.
    const sockets: string[] = [];
    const socketFactory = (url: string): SocketLike => {
      sockets.push(url);
      const socket: SocketLike = {
        binaryType: "arraybuffer",
        readyState: 0,
        send: () => {
          setTimeout(
            () => socket.onclose?.({ code: 4400, reason: "handshake" }),
            1,
          );
        },
        close: () => undefined,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      };
      setTimeout(() => socket.onopen?.({}), 1);
      return socket;
    };
    const connection = new ComputerConnection({
      computer: { ...computer, relay: null, lan: ["ws://10.0.0.2:7443"] },
      staticKey: generateKeyPair(),
      socketFactory,
      open: PhoneSession.open,
      clock: {
        now: () => Date.now(),
        setTimeout: (callback, ms) => setTimeout(callback, ms),
        clearTimeout: (handle) =>
          clearTimeout(handle as ReturnType<typeof setTimeout>),
        random: () => 0,
      },
    });
    connection.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(connection.status.kind).toBe("offline");
    await vi.advanceTimersByTimeAsync(600);
    expect(connection.status).toEqual({ kind: "keyChanged" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toEqual([lanA, lanA]);
  });
});
