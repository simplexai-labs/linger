import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface BindEvent {
  type: "udp4" | "udp6";
  port: number;
  host: string;
  ipv6Only?: boolean;
  openUdp4Ports: number[];
}

class FakeUdpSocket extends EventEmitter {
  readonly type: "udp4" | "udp6";
  readonly ipv6Only?: boolean;
  boundPort = 0;
  closed = false;

  constructor(type: "udp4" | "udp6", ipv6Only?: boolean) {
    super();
    this.type = type;
    this.ipv6Only = ipv6Only;
  }

  address() {
    return {
      address: this.type === "udp6" ? "::1" : "127.0.0.1",
      family: this.type === "udp6" ? "IPv6" : "IPv4",
      port: this.boundPort,
    };
  }

  bind(port: number, host: string, callback?: () => void) {
    const decision = mockDgram.onBind(this, port, host);
    queueMicrotask(() => {
      if (decision.errorCode) {
        const error = Object.assign(new Error(`bind ${decision.errorCode}`), {
          code: decision.errorCode,
        });
        this.emit("error", error);
        return;
      }
      this.boundPort = decision.assignedPort ?? port;
      if (this.type === "udp4") mockDgram.openUdp4.add(this);
      callback?.();
    });
    return this;
  }

  close(callback?: () => void) {
    if (!this.closed) {
      this.closed = true;
      mockDgram.openUdp4.delete(this);
    }
    queueMicrotask(() => callback?.());
    return this;
  }
}

const mockDgram = vi.hoisted(() => ({
  events: [] as BindEvent[],
  openUdp4: new Set<FakeUdpSocket>(),
  onBind: (
    _socket: FakeUdpSocket,
    _port: number,
    _host: string,
  ): { assignedPort?: number; errorCode?: string } => ({
    assignedPort: 55_000,
  }),
}));

vi.mock("node:dgram", () => ({
  createSocket: (
    typeOrOptions:
      | "udp4"
      | "udp6"
      | { type: "udp4" | "udp6"; ipv6Only?: boolean },
  ) => {
    const type =
      typeof typeOrOptions === "string" ? typeOrOptions : typeOrOptions.type;
    const ipv6Only =
      typeof typeOrOptions === "string" ? undefined : typeOrOptions.ipv6Only;
    return new FakeUdpSocket(type, ipv6Only);
  },
}));

import { PortAllocationError, freePort } from "./ports.js";

beforeEach(() => {
  mockDgram.events = [];
  mockDgram.openUdp4.clear();
  mockDgram.onBind = () => ({ assignedPort: 55_000 });
});

describe("freePort UDP dual-stack probing", () => {
  it("holds the ephemeral udp4 socket while probing ::1 without rebinding 127.0.0.1", async () => {
    mockDgram.onBind = (socket, port, host) => {
      mockDgram.events.push({
        type: socket.type,
        port,
        host,
        ipv6Only: socket.ipv6Only,
        openUdp4Ports: [...mockDgram.openUdp4].map((entry) => entry.boundPort),
      });
      if (socket.type === "udp4" && port === 0) return { assignedPort: 55_123 };
      // Simulate Windows close+rebind failure: an explicit bind on 127.0.0.1:55123 fails.
      if (socket.type === "udp4" && port === 55_123)
        return { errorCode: "EADDRINUSE" };
      return {};
    };

    const reserved = new Set<number>();
    const port = await freePort(reserved, { protocol: "udp" });

    expect(port).toBe(55_123);
    expect(reserved.has(55_123)).toBe(true);
    // Only one udp4 bind (port 0) and one ipv6Only ::1 probe occurred.
    expect(mockDgram.events).toEqual([
      {
        type: "udp4",
        port: 0,
        host: "127.0.0.1",
        ipv6Only: undefined,
        openUdp4Ports: [],
      },
      {
        type: "udp6",
        port: 55_123,
        host: "::1",
        ipv6Only: true,
        openUdp4Ports: [55_123],
      },
    ]);
    // The held udp4 socket is closed before freePort resolves.
    expect(mockDgram.openUdp4.size).toBe(0);
  });

  it("retries when ::1 conflicts on the first ephemeral UDP port", async () => {
    let nextPort = 56_000;
    mockDgram.onBind = (socket, port, host) => {
      mockDgram.events.push({
        type: socket.type,
        port,
        host,
        ipv6Only: socket.ipv6Only,
        openUdp4Ports: [...mockDgram.openUdp4].map((entry) => entry.boundPort),
      });
      if (socket.type === "udp4" && port === 0)
        return { assignedPort: nextPort++ };
      if (socket.type === "udp6" && port === 56_000)
        return { errorCode: "EADDRINUSE" };
      return {};
    };

    const port = await freePort(new Set(), { protocol: "udp" });
    expect(port).toBe(56_001);
    expect(mockDgram.openUdp4.size).toBe(0);
  });

  it("falls back to unprivileged non-ephemeral ports when OS ephemeral UDP binds fail", async () => {
    mockDgram.onBind = (socket, port, host) => {
      mockDgram.events.push({
        type: socket.type,
        port,
        host,
        ipv6Only: socket.ipv6Only,
        openUdp4Ports: [...mockDgram.openUdp4].map((entry) => entry.boundPort),
      });
      if (socket.type === "udp4" && port === 0)
        return { errorCode: "EADDRINUSE" };
      return {};
    };

    const port = await freePort(new Set(), { protocol: "udp" });
    expect(port).toBeGreaterThanOrEqual(10_240);
    expect(port).toBeLessThanOrEqual(49_151);
    expect(mockDgram.events[0]).toMatchObject({
      type: "udp4",
      port: 0,
      host: "127.0.0.1",
    });
    expect(mockDgram.events[1]).toMatchObject({
      type: "udp4",
      port,
      host: "127.0.0.1",
    });
    expect(mockDgram.events[2]).toMatchObject({
      type: "udp6",
      port,
      host: "::1",
      ipv6Only: true,
      openUdp4Ports: [port],
    });
    expect(mockDgram.openUdp4.size).toBe(0);
  });

  it("throws a PortAllocationError with attempted port details when all UDP binds fail", async () => {
    mockDgram.onBind = () => ({ errorCode: "EADDRINUSE" });

    const error = await freePort(new Set(), { protocol: "udp" }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(PortAllocationError);
    expect((error as Error).message).toMatch(
      /No free local port is available on this computer\. UDP: 127\.0\.0\.1 bind: EADDRINUSE \(port \d+\)\./,
    );
    expect(mockDgram.openUdp4.size).toBe(0);
  });
});
