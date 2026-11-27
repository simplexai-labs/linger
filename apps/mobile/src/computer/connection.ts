// Keeps one session open to the active paired computer. Each round dials
// every stored LAN origin at once and the Relay nodes 300 ms later (the
// fastest one measured first, the others 250 ms after it, or only a pinned
// node), keeps the first session that completes its handshake and closes the
// rest; failed rounds back off from 1 s to 30 s with jitter. A session on a
// Relay keeps trying the LAN in the background and moves to it once it
// answers. docs/mobile.md is the specification.
import {
  HandshakeFailed,
  PhoneSession,
  SessionRefused,
  type Hello,
  type SocketFactory,
  type Welcome,
} from "../session/session";
import type { KeyPair } from "../session/noise";
import { connectUrl } from "./pairing-link";
import { relayDialOrder, relayNodesOf } from "./relay-nodes";
import { hostKeyBytes, type PairedComputer } from "./store";

export type Route = "lan" | "relay";

export type ConnectionStatus =
  | { readonly kind: "connecting" }
  | { readonly kind: "connected"; readonly route: Route }
  /** The phone waits for the Human to approve it; code is shown on both. */
  | { readonly kind: "pending"; readonly route: Route; readonly code: string }
  | { readonly kind: "offline"; readonly retryAt: number }
  /** The computer removed this phone or no longer knows it. */
  | { readonly kind: "removed" }
  /** The computer no longer answers to the pinned key. */
  | { readonly kind: "keyChanged" };

/** The part of PhoneSession the connection manager drives. */
export interface ManagedSession {
  readonly welcome: Welcome;
  readonly pending: boolean;
  readonly closed: boolean;
  readonly closeFrame: { code: number; reason: string } | undefined;
  /** Socket streams open now, such as a voice call; absent counts as none. */
  readonly openSockets?: number;
  onApproved(listener: () => void): () => void;
  onClose(listener: (reason: string) => void): () => void;
  close(): void;
}

export interface OpenInput {
  readonly url: string;
  readonly computerPublicKey: Uint8Array;
  readonly staticKey: KeyPair;
  readonly hello: Hello;
  readonly socketFactory: SocketFactory;
  readonly signal?: AbortSignal;
}

export type OpenSession<S> = (input: OpenInput) => Promise<S>;

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  random(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
  random: () => Math.random(),
};

export const LAN_HEAD_START_MS = 300;
/** The head start the fastest Relay node gets over the others. */
export const RELAY_STAGGER_MS = 250;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;
/** Rounds in a row whose handshake failed before the phone gives up. */
const KEY_CHANGED_ROUNDS = 2;
const TERMINAL_REFUSALS = new Set(["PHONE_REMOVED", "PHONE_UNKNOWN"]);
/** A session that lived this long reconnects at once and resets the backoff. */
const HEALTHY_SESSION_MS = 10_000;
/** How often a session on a Relay tries the LAN without a network event. */
export const LAN_UPGRADE_INTERVAL_MS = 30_000;

/** Delay before retry number `failures` (0-based): 1 s doubling to 30 s, times 0.5-1. */
export function backoffDelay(failures: number, random: number): number {
  const base = Math.min(
    BACKOFF_CAP_MS,
    BACKOFF_BASE_MS * 2 ** Math.min(failures, 16),
  );
  return Math.round(base * (0.5 + random * 0.5));
}

export interface Dial {
  readonly route: Route;
  readonly url: string;
  /** The Relay node's origin, for a Relay dial. */
  readonly relay?: string;
}

export function dialsFor(computer: PairedComputer): Dial[] {
  const dials: Dial[] = computer.lan.map((origin) => ({
    route: "lan",
    url: connectUrl(origin, computer.hostId),
  }));
  for (const node of relayDialOrder(computer))
    dials.push({
      route: "relay",
      url: connectUrl(node.url, computer.hostId),
      relay: node.url,
    });
  return dials;
}

export interface ConnectionOptions<S extends ManagedSession> {
  readonly computer: PairedComputer;
  readonly staticKey: KeyPair;
  readonly socketFactory: SocketFactory;
  readonly open?: OpenSession<S>;
  readonly clock?: Clock;
  /** Runs for every session that opens, so stored LAN origins stay current. */
  readonly onWelcome?: (welcome: Welcome) => void;
}

export class ComputerConnection<S extends ManagedSession = PhoneSession> {
  #computer: PairedComputer;
  readonly #options: ConnectionOptions<S>;
  readonly #open: OpenSession<S>;
  readonly #clock: Clock;
  #status: ConnectionStatus = { kind: "connecting" };
  #session: S | undefined;
  #acceptedAt = 0;
  #route: Route | undefined;
  #relay: string | undefined;
  #listeners = new Set<(status: ConnectionStatus) => void>();
  #failures = 0;
  #handshakeRounds = 0;
  #timer: unknown;
  #round: AbortController | undefined;
  #stopped = true;
  #upgrading: AbortController | undefined;
  #upgradeTimer: unknown;

  constructor(options: ConnectionOptions<S>) {
    this.#options = options;
    this.#computer = options.computer;
    this.#open =
      options.open ?? (PhoneSession.open as unknown as OpenSession<S>);
    this.#clock = options.clock ?? systemClock;
  }

  get computer(): PairedComputer {
    return this.#computer;
  }

  get status(): ConnectionStatus {
    return this.#status;
  }

  /** The open session, also while the phone is pending approval. */
  get session(): S | undefined {
    return this.#session;
  }

  /** The session once the computer approved the phone. */
  get readySession(): S | undefined {
    return this.#status.kind === "connected" ? this.#session : undefined;
  }

  get route(): Route | undefined {
    return this.#route;
  }

  /** The Relay node the open session goes through, if any. */
  get relay(): string | undefined {
    return this.#relay;
  }

  /**
   * Drops the open session so the next round dials again, for example after
   * the Human pinned another Relay node.
   */
  reconnect(): void {
    if (this.#stopped) return;
    const session = this.#session;
    if (!session) {
      this.nudge();
      return;
    }
    this.#session = undefined;
    this.#route = undefined;
    this.#relay = undefined;
    this.#stopUpgrade();
    session.close();
    this.#failures = 0;
    this.#connect();
  }

  /**
   * On a Relay, dials only the stored LAN origins in the background and,
   * once one completes its handshake, makes it the session and closes the
   * Relay one. The open session is untouched while dialing, and a failed
   * dial changes nothing. A voice call in progress keeps its route.
   */
  upgradeToLan(): void {
    const session = this.#session;
    if (
      this.#stopped ||
      this.#upgrading ||
      !session ||
      this.#route !== "relay" ||
      this.#status.kind !== "connected" ||
      (session.openSockets ?? 0) > 0
    )
      return;
    const lan = dialsFor(this.#computer).filter((dial) => dial.route === "lan");
    if (lan.length === 0) return;
    const upgrade = new AbortController();
    this.#upgrading = upgrade;
    let unsettled = lan.length;
    const done = () => {
      if (this.#upgrading === upgrade) this.#upgrading = undefined;
    };
    for (const dial of lan)
      this.#open({
        url: dial.url,
        computerPublicKey: hostKeyBytes(this.#computer),
        staticKey: this.#options.staticKey,
        hello: { type: "resume" },
        socketFactory: this.#options.socketFactory,
        signal: upgrade.signal,
      }).then(
        (next) => {
          unsettled -= 1;
          const current = this.#session;
          if (
            upgrade.signal.aborted ||
            this.#stopped ||
            current !== session ||
            this.#route !== "relay" ||
            next.pending ||
            (current.openSockets ?? 0) > 0
          ) {
            next.close();
            if (unsettled === 0) done();
            return;
          }
          upgrade.abort();
          done();
          // The Relay session is no longer this.#session when it closes, so
          // its close starts no round and no backoff.
          this.#accept(next, "lan");
          session.close();
        },
        () => {
          unsettled -= 1;
          if (unsettled === 0) done();
        },
      );
  }

  /**
   * Opens a short session through every Relay node at once and reports what
   * `measure` finds on it, such as the request round trip; a node that does
   * not answer within `timeoutMs` is absent.
   */
  async probeRelays(
    measure: (session: S) => Promise<number>,
    timeoutMs = 8_000,
  ): Promise<Map<string, number>> {
    const controller = new AbortController();
    const timer = this.#clock.setTimeout(() => controller.abort(), timeoutMs);
    const results = new Map<string, number>();
    // A Human who pinned one node reaches no other, so no other is timed.
    const nodes = relayNodesOf(this.#computer);
    const pinned = nodes.filter(
      (node) => node.id === this.#computer.relayChoice,
    );
    await Promise.all(
      (pinned.length > 0 ? pinned : nodes).map(async (node) => {
        try {
          const session = await this.#open({
            url: connectUrl(node.url, this.#computer.hostId),
            computerPublicKey: hostKeyBytes(this.#computer),
            staticKey: this.#options.staticKey,
            hello: { type: "resume" },
            socketFactory: this.#options.socketFactory,
            signal: controller.signal,
          });
          try {
            // The deadline covers the measurement too, not only the dial.
            const aborted = new Promise<never>((_, reject) => {
              if (controller.signal.aborted) reject(new Error("timed out"));
              controller.signal.addEventListener("abort", () =>
                reject(new Error("timed out")),
              );
            });
            results.set(
              node.url,
              await Promise.race([measure(session), aborted]),
            );
          } finally {
            session.close();
          }
        } catch {
          // An unreachable node has no time.
        }
      }),
    );
    this.#clock.clearTimeout(timer);
    return results;
  }

  subscribe(listener: (status: ConnectionStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Updates the routes the next round dials, for example after a welcome. */
  updateComputer(computer: PairedComputer): void {
    this.#computer = computer;
  }

  start(): void {
    if (!this.#stopped || this.#terminal()) return;
    this.#stopped = false;
    if (!this.#session) this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    this.#clearTimer();
    this.#stopUpgrade();
    this.#round?.abort();
    this.#round = undefined;
    const session = this.#session;
    this.#session = undefined;
    session?.close();
  }

  /**
   * Retries now instead of waiting out the backoff, for example when the app
   * comes to the foreground or the network changed.
   */
  nudge(): void {
    if (this.#stopped || this.#terminal() || this.#session || this.#round)
      return;
    this.#clearTimer();
    this.#failures = 0;
    this.#connect();
  }

  /** Takes over a session pairing opened, so the phone does not dial again. */
  adopt(session: S, route: Route): void {
    this.#stopped = false;
    this.#clearTimer();
    this.#round?.abort();
    this.#round = undefined;
    this.#accept(session, route);
  }

  #terminal(): boolean {
    return (
      this.#status.kind === "removed" || this.#status.kind === "keyChanged"
    );
  }

  #setStatus(status: ConnectionStatus): void {
    this.#status = status;
    for (const listener of [...this.#listeners]) listener(status);
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) this.#clock.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #connect(): void {
    if (this.#status.kind !== "connecting")
      this.#setStatus({ kind: "connecting" });
    const round = new AbortController();
    this.#round = round;
    const dials = dialsFor(this.#computer);
    const lan = dials.filter((dial) => dial.route === "lan");
    const relay = dials.filter((dial) => dial.route === "relay");
    const errors: unknown[] = [];
    let unsettled = dials.length;
    let relayStarted = false;
    let restStarted = false;
    let relayTimer: unknown;
    let restTimer: unknown;
    let finished = false;

    const finish = () => {
      finished = true;
      if (relayTimer !== undefined) this.#clock.clearTimeout(relayTimer);
      if (restTimer !== undefined) this.#clock.clearTimeout(restTimer);
      if (this.#round === round) this.#round = undefined;
    };
    const startRest = () => {
      if (restStarted || finished) return;
      restStarted = true;
      for (const dial of relay.slice(1)) attempt(dial);
    };
    const startRelay = () => {
      if (relayStarted || finished) return;
      relayStarted = true;
      const [first] = relay;
      if (first) attempt(first);
      if (relay.length > 1)
        restTimer = this.#clock.setTimeout(startRest, RELAY_STAGGER_MS);
    };
    const settleFailure = (error: unknown) => {
      errors.push(error);
      unsettled -= 1;
      if (finished) return;
      if (
        error instanceof SessionRefused &&
        TERMINAL_REFUSALS.has(error.code)
      ) {
        finish();
        round.abort();
        this.#removed();
        return;
      }
      // Every LAN dial failed before the head start ran out: go to the Relay.
      if (!relayStarted && errors.length >= lan.length) startRelay();
      // The fastest node failed before its head start ran out: try the rest.
      if (relayStarted && errors.length >= lan.length + 1) startRest();
      if (unsettled === 0) {
        finish();
        this.#roundFailed(errors);
      }
    };
    const attempt = (dial: Dial) => {
      this.#open({
        url: dial.url,
        computerPublicKey: hostKeyBytes(this.#computer),
        staticKey: this.#options.staticKey,
        hello: { type: "resume" },
        socketFactory: this.#options.socketFactory,
        signal: round.signal,
      }).then((session) => {
        unsettled -= 1;
        if (finished || this.#stopped) {
          session.close();
          return;
        }
        finish();
        round.abort();
        this.#accept(session, dial.route, dial.relay);
      }, settleFailure);
    };

    if (dials.length === 0) {
      finish();
      this.#roundFailed([]);
      return;
    }
    for (const dial of lan) attempt(dial);
    if (lan.length === 0) startRelay();
    else if (relay.length > 0)
      relayTimer = this.#clock.setTimeout(startRelay, LAN_HEAD_START_MS);
  }

  #stopUpgrade(): void {
    this.#upgrading?.abort();
    this.#upgrading = undefined;
    if (this.#upgradeTimer !== undefined)
      this.#clock.clearTimeout(this.#upgradeTimer);
    this.#upgradeTimer = undefined;
  }

  /** Tries the LAN every LAN_UPGRADE_INTERVAL_MS while on a Relay. */
  #scheduleUpgrade(session: S): void {
    this.#upgradeTimer = this.#clock.setTimeout(() => {
      this.#upgradeTimer = undefined;
      if (this.#session !== session || this.#route !== "relay") return;
      this.upgradeToLan();
      this.#scheduleUpgrade(session);
    }, LAN_UPGRADE_INTERVAL_MS);
  }

  #accept(session: S, route: Route, relay?: string): void {
    this.#stopUpgrade();
    this.#session = session;
    this.#route = route;
    this.#relay = relay;
    if (route === "relay") this.#scheduleUpgrade(session);
    this.#acceptedAt = this.#clock.now();
    this.#handshakeRounds = 0;
    this.#options.onWelcome?.(session.welcome);
    session.onClose(() => this.#sessionClosed(session));
    if (session.closed) return;
    if (session.pending) {
      this.#setStatus({
        kind: "pending",
        route,
        code: session.welcome.code ?? "",
      });
      session.onApproved(() => {
        if (this.#session === session)
          this.#setStatus({ kind: "connected", route });
      });
    } else {
      this.#setStatus({ kind: "connected", route });
    }
  }

  #sessionClosed(session: S): void {
    if (this.#session !== session) return;
    this.#stopUpgrade();
    this.#session = undefined;
    this.#route = undefined;
    this.#relay = undefined;
    if (this.#stopped) return;
    // A WebSocket close reason is not authenticated: a Relay can write any.
    // A computer that removed the phone closes with PHONE_REMOVED, and the
    // phone dials again at once; the next handshake carries the refusal
    // inside Noise, and only that deletes anything.
    if (TERMINAL_REFUSALS.has(session.closeFrame?.reason ?? "")) {
      this.#failures = 0;
      this.#connect();
      return;
    }
    if (this.#clock.now() - this.#acceptedAt >= HEALTHY_SESSION_MS) {
      this.#failures = 0;
      this.#connect();
      return;
    }
    // A session that closed right after opening backs off like a failed
    // round, so a computer that keeps dropping the phone is not hammered.
    this.#schedule();
  }

  #roundFailed(errors: unknown[]): void {
    if (this.#stopped) return;
    if (errors.some((error) => error instanceof HandshakeFailed)) {
      this.#handshakeRounds += 1;
      if (this.#handshakeRounds >= KEY_CHANGED_ROUNDS) {
        this.#setStatus({ kind: "keyChanged" });
        return;
      }
    } else {
      this.#handshakeRounds = 0;
    }
    this.#schedule();
  }

  #schedule(): void {
    const delay = backoffDelay(this.#failures, this.#clock.random());
    this.#failures += 1;
    this.#setStatus({ kind: "offline", retryAt: this.#clock.now() + delay });
    this.#clearTimer();
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = undefined;
      if (!this.#stopped && !this.#session) this.#connect();
    }, delay);
  }

  #removed(): void {
    this.#clearTimer();
    this.#setStatus({ kind: "removed" });
  }
}
