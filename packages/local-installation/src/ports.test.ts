import { createSocket } from "node:dgram";
import net from "node:net";
import os from "node:os";
import { afterEach, expect, it } from "vitest";
import { PortAllocationError, freePort, portFree } from "./ports.js";

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((close) => close()));
});
// Another program's listener on one address only; undefined when the
// computer has no such address.
async function listen(host: string, port = 0): Promise<number | undefined> {
  const server = net.createServer((socket) => socket.end());
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ port, host }, resolve);
    });
  } catch {
    return undefined;
  }
  open.push(() => new Promise((resolve) => server.close(() => resolve())));
  return (server.address() as net.AddressInfo).port;
}

it("treats a port taken on IPv4 loopback only as used", async () => {
  const port = (await listen("127.0.0.1"))!;
  expect(await portFree(port)).toBe(false);
});

it("treats a port taken on IPv6 loopback only as used", async (context) => {
  const port = await listen("::1");
  if (port === undefined) return context.skip("This computer has no ::1.");
  expect(await portFree(port)).toBe(false);
});

it("finds a port that is free on both loopback addresses", async () => {
  const port = await freePort(new Set());
  expect(await portFree(port)).toBe(true);
  // Both addresses accept it, so nothing else answers on `localhost`.
  expect(await listen("127.0.0.1", port)).toBe(port);
});

it("keeps the preferred port when it is free and moves off it when it is taken", async () => {
  const preferred = await freePort(new Set());
  const reserved = new Set<number>();
  expect(await freePort(reserved, { preferred })).toBe(preferred);
  expect(reserved).toEqual(new Set([preferred]));

  const taken = (await listen("::1")) ?? (await listen("127.0.0.1"))!;
  const moved = await freePort(reserved, { preferred: taken });
  expect(moved).not.toBe(taken);
  expect(moved).not.toBe(preferred);
  expect(reserved.has(moved)).toBe(true);
});

it("never returns a reserved port", async () => {
  const preferred = await freePort(new Set());
  expect(await freePort(new Set([preferred]), { preferred })).not.toBe(
    preferred,
  );
});

it("reports the loopback bind error if it cannot find an alternative", async () => {
  const taken = (await listen("127.0.0.1"))!;
  const reserved = new Set(Array.from({ length: 65536 }, (_, port) => port));
  reserved.delete(taken);
  const error = await freePort(reserved, { preferred: taken }).catch(
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(PortAllocationError);
  expect((error as Error).message).toContain(
    `TCP: 127.0.0.1 bind: EADDRINUSE (port ${taken})`,
  );
});

it("checks UDP ports separately", async () => {
  const socket = createSocket("udp4");
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  open.push(() => new Promise((resolve) => socket.close(() => resolve())));
  const { port } = socket.address();
  expect(await portFree(port, "udp")).toBe(false);
  const moved = await freePort(new Set(), { preferred: port, protocol: "udp" });
  expect(moved).not.toBe(port);
  expect(await portFree(moved, "udp")).toBe(true);
});

it("treats a UDP port taken on IPv6 loopback only as used", async (context) => {
  const socket = createSocket({ type: "udp6", ipv6Only: true });
  const bound = await new Promise<boolean>((resolve) => {
    socket.once("error", () => {
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      resolve(false);
    });
    socket.bind(0, "::1", () => resolve(true));
  });
  if (!bound) return context.skip("This computer has no ::1 UDP.");
  open.push(() => new Promise((resolve) => socket.close(() => resolve())));
  const { port } = socket.address();
  expect(await portFree(port, "udp")).toBe(false);
  const moved = await freePort(new Set(), { preferred: port, protocol: "udp" });
  expect(moved).not.toBe(port);
  expect(await portFree(moved, "udp")).toBe(true);
});

it("treats a port taken on a non-loopback local interface as used when allInterfaces is enabled", async (context) => {
  let taken: number | undefined;
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || !entry.address) continue;
      const addr = entry.address.split("%")[0] ?? "";
      if (!addr || addr.toLowerCase().startsWith("fe80:")) continue;
      taken = await listen(addr);
      if (taken !== undefined) break;
    }
    if (taken !== undefined) break;
  }
  if (taken === undefined)
    return context.skip("This computer has no bindable non-loopback address.");
  expect(await portFree(taken, "tcp", { allInterfaces: true })).toBe(false);
  const moved = await freePort(new Set(), {
    preferred: taken,
    allInterfaces: true,
  });
  expect(moved).not.toBe(taken);
  expect(await portFree(moved, "tcp", { allInterfaces: true })).toBe(true);
});
