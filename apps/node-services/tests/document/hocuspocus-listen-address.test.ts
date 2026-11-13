import { Server } from "@hocuspocus/server";
import { afterEach, expect, it } from "vitest";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.destroy();
});

// The Document Runtime binds DOCUMENT_RUNTIME_HTTP_ADDRESS's host through
// Hocuspocus's `address`; a local installation must stay on loopback.
it("listens only on the configured address", async () => {
  const server = new Server({
    address: "127.0.0.1",
    port: 0,
    quiet: true,
    stopOnSignals: false,
  });
  servers.push(server);
  await server.listen();
  expect(server.httpServer.address()).toMatchObject({ address: "127.0.0.1" });
});
