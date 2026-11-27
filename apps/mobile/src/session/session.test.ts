// Runs the phone's session against the real Go Mobile Gateway
// (apps/teamhub/internal/mobilegateway/testserver) over a loopback socket.
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { requestJson, sendRequest, subscribe } from "./http";
import { generateKeyPair } from "./noise";
import { PhoneSession, SessionRefused, type SocketLike } from "./session";

const teamHubDirectory = fileURLToPath(
  new URL("../../../teamhub", import.meta.url),
);
const hasGo = spawnSync("go", ["version"]).status === 0;

let server: ChildProcessWithoutNullStreams | undefined;
let endpoint: { url: string; host_key: string };

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (byte) =>
    Number.parseInt(byte, 16),
  );
}

const socketFactory = (url: string) =>
  new WebSocket(url) as unknown as SocketLike;

describe.skipIf(!hasGo)("session against the Go gateway", () => {
  beforeAll(async () => {
    server = spawn("go", ["run", "./internal/mobilegateway/testserver"], {
      cwd: teamHubDirectory,
    });
    const lines = createInterface({ input: server.stdout });
    endpoint = await new Promise((resolve, reject) => {
      server?.on("exit", (code) =>
        reject(new Error(`test server exited with ${code}`)),
      );
      lines.once("line", (line) =>
        resolve(JSON.parse(line) as { url: string; host_key: string }),
      );
    });
  }, 120_000);

  afterAll(() => {
    server?.stdin.end();
    server?.kill();
  });

  it("pairs, resumes, streams events and moves large bodies both ways", async () => {
    const staticKey = generateKeyPair();
    const computerPublicKey = hexBytes(endpoint.host_key);
    const paired = await PhoneSession.open({
      url: endpoint.url,
      computerPublicKey,
      staticKey,
      hello: {
        type: "pair",
        invite: "test-invite",
        name: "Test Phone",
        platform: "android",
      },
      socketFactory,
    });
    expect(paired.welcome).toMatchObject({
      type: "pending",
      phone_id: "phone_test",
      code: "123456",
      name: "Test Computer",
    });
    await new Promise<void>((resolve) => paired.onApproved(resolve));
    expect(paired.pending).toBe(false);
    expect(await requestJson(paired, "GET", "/v0/me")).toEqual({
      phone_session: true,
    });
    paired.close();

    await expect(
      PhoneSession.open({
        url: endpoint.url,
        computerPublicKey,
        staticKey: generateKeyPair(),
        hello: {
          type: "pair",
          invite: "test-invite",
          name: "Other",
          platform: "ios",
        },
        socketFactory,
      }),
    ).rejects.toBeInstanceOf(SessionRefused);

    const session = await PhoneSession.open({
      url: endpoint.url,
      computerPublicKey,
      staticKey,
      hello: { type: "resume" },
      socketFactory,
    });
    expect(await requestJson(session, "GET", "/v0/me")).toEqual({
      phone_session: true,
    });
    expect(
      await requestJson(session, "POST", "/v0/rooms/r1/messages", {
        body: { text: "hello" },
      }),
    ).toEqual({ text: "hello" });

    const upload = new Uint8Array(3 * 1024 * 1024).fill(9);
    const counted = await sendRequest(
      session,
      "POST",
      "/v0/rooms/r1/message-attachment-uploads",
      { body: upload },
    );
    expect(JSON.parse(new TextDecoder().decode(counted.body))).toEqual({
      bytes: upload.length,
    });

    const download = await sendRequest(
      session,
      "GET",
      `/v0/documents/d1/downloads?size=${2 * 1024 * 1024}`,
    );
    expect(download.status).toBe(200);
    expect(download.body.length).toBe(2 * 1024 * 1024);

    const blocked = await sendRequest(session, "POST", "/v0/auth/login", {
      body: "{}",
    });
    expect(blocked.status).toBe(404);

    const events: string[] = [];
    await new Promise<void>((resolve) => {
      const cancel = subscribe(session, "/v0/events", {
        onEvent: (event) => {
          events.push(`${event.event}:${event.data}`);
          if (events.length === 3) cancel();
        },
        onClose: () => resolve(),
      });
    });
    expect(events).toEqual(["tick:0", "tick:1", "tick:2"]);

    // The session still serves requests after a cancelled stream.
    expect(await requestJson(session, "GET", "/v0/me")).toEqual({
      phone_session: true,
    });
    session.close();
  }, 60_000);
});
