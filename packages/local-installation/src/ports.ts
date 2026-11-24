import { randomInt } from "node:crypto";
import { createSocket, type Socket } from "node:dgram";
import net from "node:net";
import os from "node:os";

// The addresses a loopback service can be reached on. The product origin is
// `http://localhost:<port>`, which macOS resolves to ::1 first, so a program
// listening on ::1 alone would answer in place of a service that bound
// 127.0.0.1 without an error. A port is free only when both can be bound and
// neither answers.
const LOOPBACK = ["127.0.0.1", "::1"] as const;
// A computer without IPv6 (or a transient non-loopback address) cannot bind it.
const UNAVAILABLE_BIND = new Set(["EADDRNOTAVAIL", "EAFNOSUPPORT", "EINVAL"]);
const MAX_PORT_ATTEMPTS = 100;
const EPHEMERAL_UDP_ATTEMPTS = 50;
// Unprivileged ports outside the Windows dynamic ephemeral range (49152-65535),
// which Hyper-V, WSL2, and VPNs frequently exclude for UDP.
const NON_EPHEMERAL_MIN = 10_240;
const NON_EPHEMERAL_MAX = 49_151;

type Protocol = "tcp" | "udp";

/** Error thrown when no free local port can be allocated. */
export class PortAllocationError extends Error {
  constructor(protocol: Protocol, conflict?: string, port?: number) {
    const detail = conflict
      ? port !== undefined
        ? `${conflict} (port ${port})`
        : conflict
      : "all candidates were reserved";
    super(
      `No free local port is available on this computer. ${protocol.toUpperCase()}: ${detail}.`,
    );
    this.name = "PortAllocationError";
  }
}

export interface PortCheckOptions {
  allInterfaces?: boolean;
}

function nonLoopbackLocalHosts(): string[] {
  const hosts = new Set<string>();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || !entry.address) continue;
      const addr = entry.address.split("%")[0] ?? "";
      if (!addr || addr.toLowerCase().startsWith("fe80:")) continue;
      hosts.add(addr);
    }
  }
  return [...hosts];
}

function closeUdpSocket(socket: Socket): Promise<void> {
  return new Promise((resolve) => {
    try {
      socket.close(() => resolve());
    } catch {
      // A socket that never bound is already closed.
      resolve();
    }
  });
}

function bindUdp(
  port: number,
  host: string,
): Promise<{ socket?: Socket; error?: NodeJS.ErrnoException }> {
  const ipv6 = host.includes(":");
  return new Promise((resolve) => {
    let socket: Socket;
    try {
      socket = ipv6
        ? createSocket({ type: "udp6", ipv6Only: true })
        : createSocket("udp4");
    } catch (error) {
      resolve({ error: error as NodeJS.ErrnoException });
      return;
    }
    const onError = (error: NodeJS.ErrnoException) => {
      void closeUdpSocket(socket).then(() => resolve({ error }));
    };
    socket.once("error", onError);
    socket.bind(port, host, () => {
      socket.off("error", onError);
      resolve({ socket });
    });
  });
}

function formatBindError(
  host: string,
  error: NodeJS.ErrnoException,
  ignoreUnavailable: boolean,
): string | undefined {
  return ignoreUnavailable && UNAVAILABLE_BIND.has(error.code ?? "")
    ? undefined
    : `${host} bind: ${error.code ?? error.name}`;
}

function bindConflict(
  port: number,
  host: string,
  protocol: Protocol,
  ignoreUnavailable = host.includes(":"),
): Promise<string | undefined> {
  if (protocol === "udp") {
    return bindUdp(port, host).then(async ({ socket, error }) => {
      if (error) return formatBindError(host, error, ignoreUnavailable);
      await closeUdpSocket(socket!);
      return undefined;
    });
  }
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (error: NodeJS.ErrnoException) =>
      resolve(formatBindError(host, error, ignoreUnavailable)),
    );
    server.listen({ port, host, exclusive: true }, () =>
      server.close(() => resolve(undefined)),
    );
  });
}

// macOS lets a program bind one address under another program's listener on
// every address, so a successful bind does not prove nobody answers there.
function answers(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host, timeout: 500 });
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

async function portConflict(
  port: number,
  protocol: Protocol,
  options: PortCheckOptions = {},
): Promise<string | undefined> {
  if (protocol === "udp") {
    const ipv4 = await bindUdp(port, "127.0.0.1");
    if (ipv4.error) return formatBindError("127.0.0.1", ipv4.error, false);
    try {
      return await bindConflict(port, "::1", "udp", true);
    } finally {
      await closeUdpSocket(ipv4.socket!);
    }
  }
  for (const host of LOOPBACK) {
    const conflict = await bindConflict(port, host, protocol);
    if (conflict) return conflict;
  }
  const answered = await Promise.all(
    LOOPBACK.map((host) => answers(port, host)),
  );
  const host = LOOPBACK[answered.indexOf(true)];
  if (host) return `${host} already answers TCP connections`;
  if (!options.allInterfaces) return undefined;
  for (const external of nonLoopbackLocalHosts()) {
    const conflict = await bindConflict(port, external, protocol, true);
    if (conflict) return conflict;
  }
  return undefined;
}

/** Whether no program uses `port` on IPv4 or IPv6 loopback (or any local interface when `allInterfaces` is set). */
export async function portFree(
  port: number,
  protocol: Protocol = "tcp",
  options: PortCheckOptions = {},
): Promise<boolean> {
  return (await portConflict(port, protocol, options)) === undefined;
}

function ephemeralTcp(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function freeUdpPort(
  reserved: Set<number>,
  preferred?: number,
): Promise<number> {
  let lastConflict: string | undefined;
  let lastPort: number | undefined;
  if (preferred !== undefined && !reserved.has(preferred)) {
    const conflict = await portConflict(preferred, "udp");
    if (conflict === undefined) {
      reserved.add(preferred);
      return preferred;
    }
    lastConflict = conflict;
    lastPort = preferred;
  }
  // Hold the OS-assigned IPv4 UDP socket open while probing ::1 instead of
  // closing and rebinding 127.0.0.1:port, which fails with EADDRINUSE on
  // Windows under excluded port ranges or firewall/socket-close hooks.
  let ephemeralFailed = false;
  const triedNonEphemeral = new Set<number>();
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    if (!ephemeralFailed && attempt < EPHEMERAL_UDP_ATTEMPTS) {
      const bound = await bindUdp(0, "127.0.0.1");
      if (bound.error) {
        lastConflict = formatBindError("127.0.0.1", bound.error, false);
        lastPort = 0;
        ephemeralFailed = true;
      } else {
        const socket = bound.socket!;
        const { port } = socket.address();
        try {
          if (!reserved.has(port)) {
            const conflict = await bindConflict(port, "::1", "udp", true);
            if (conflict === undefined) {
              reserved.add(port);
              return port;
            }
            lastConflict = conflict;
            lastPort = port;
          }
        } finally {
          await closeUdpSocket(socket);
        }
        continue;
      }
    }
    const candidate = randomInt(NON_EPHEMERAL_MIN, NON_EPHEMERAL_MAX + 1);
    if (reserved.has(candidate) || triedNonEphemeral.has(candidate)) continue;
    triedNonEphemeral.add(candidate);
    const conflict = await portConflict(candidate, "udp");
    if (conflict === undefined) {
      reserved.add(candidate);
      return candidate;
    }
    lastConflict = conflict;
    lastPort = candidate;
  }
  throw new PortAllocationError("udp", lastConflict, lastPort);
}

/**
 * `preferred` when it is free, else a free port the system offers, never one
 * in `reserved` (the ports this home's instances keep); adds it to `reserved`.
 */
export async function freePort(
  reserved: Set<number>,
  options: {
    preferred?: number;
    protocol?: Protocol;
    allInterfaces?: boolean;
  } = {},
): Promise<number> {
  const protocol = options.protocol ?? "tcp";
  if (protocol === "udp") return freeUdpPort(reserved, options.preferred);
  let port = options.preferred;
  let lastConflict: string | undefined;
  let lastPort: number | undefined;
  for (let attempt = 0; ; attempt++) {
    if (port !== undefined && !reserved.has(port)) {
      lastConflict = await portConflict(port, "tcp", options);
      if (lastConflict === undefined) {
        reserved.add(port);
        return port;
      }
      lastPort = port;
    }
    if (attempt >= MAX_PORT_ATTEMPTS)
      throw new PortAllocationError("tcp", lastConflict, lastPort);
    port = await ephemeralTcp();
  }
}
