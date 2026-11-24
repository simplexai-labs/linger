import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CredentialStore } from "./computer-credential.js";
import type { DesktopConfig } from "./config.js";
import {
  EnrollmentError,
  EnrollmentModule,
  enrollComputer,
  readDaemonId,
} from "./enrollment.js";
import { EventBus } from "./modules.js";
import { stubModule, tempDirectory, testHost } from "./test-support.js";

const claims = (value: object): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const TOKEN = `sr1.${claims({
  runner_id: "computer_1",
  tenant_owners: [{ tenant_id: "tenant_acme", owner_actor_id: "actor_ann" }],
})}.${"s".repeat(43)}`;

interface Call {
  readonly url: string;
  readonly method: string;
  readonly cookie: string | undefined;
  readonly body: Record<string, unknown> | undefined;
}

// The /v0/me server capability of a TeamHub whose enrollment accepts
// daemon_id; an older TeamHub lists none and rejects the field.
const DAEMON_CAPABLE = ["local_computer_enrollment_daemon_id"];

interface ServerOverrides {
  // The server_capabilities /v0/me lists; null omits the list, as a TeamHub
  // that predates it does.
  readonly capabilities?: readonly string[] | null;
  readonly exchangeStatus?: number;
  readonly bundle?: Record<string, unknown>;
  readonly meActorId?: string;
  // The Computer that holds the daemon's identity, which TeamHub renews when
  // an enrollment names the daemon.
  readonly daemonHeldBy?: string;
  readonly onCreate?: (
    body: Record<string, unknown> | undefined,
  ) => Response | undefined;
  readonly onExchange?: () => Response | undefined;
}

const fakeServer = (
  overrides: ServerOverrides = {},
): { fetch: typeof fetch; calls: Call[] } => {
  const calls: Call[] = [];
  let challenge = "";
  const fetchImpl = (async (input: URL, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const body = init.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    calls.push({
      url: input.pathname,
      method: init.method ?? "GET",
      cookie: headers.cookie,
      body,
    });
    const json = (value: unknown, status = 200): Response =>
      new Response(JSON.stringify(value), { status });
    if (input.pathname === "/v0/me")
      return json({
        actors: [
          {
            kind: "human",
            tenant_id: "tenant_acme",
            ...(overrides.meActorId ? { id: overrides.meActorId } : {}),
          },
        ],
        ...(overrides.capabilities === null
          ? {}
          : { server_capabilities: overrides.capabilities ?? DAEMON_CAPABLE }),
      });
    if (input.pathname.endsWith("/local-computer-enrollments")) {
      const custom = overrides.onCreate?.(body);
      if (custom) return custom;
      challenge = String(body?.code_challenge);
      return json({
        enrollment_id: "enr_1",
        computer_id:
          overrides.daemonHeldBy && body?.daemon_id
            ? overrides.daemonHeldBy
            : typeof body?.computer_id === "string"
              ? body.computer_id
              : "computer_1",
        authorization_code: "code_1",
        expires_at: "2026-10-16T08:00:00Z",
      });
    }
    const exchangeCustom = overrides.onExchange?.();
    if (exchangeCustom) return exchangeCustom;
    if (overrides.exchangeStatus) return json({}, overrides.exchangeStatus);
    const verifier = String(body?.code_verifier);
    if (createHash("sha256").update(verifier).digest("base64url") !== challenge)
      return json({}, 400);
    return json(
      overrides.bundle ?? {
        computer_id: "computer_1",
        tenant_id: "tenant_acme",
        gateway_url: "wss://linger.example.com/v1/runner",
        gateway_token: TOKEN,
        credential_expires_at: "2026-11-16T08:00:00Z",
      },
    );
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
};

const writeDaemonIdentity = (
  file: string,
  publicKey = Buffer.alloc(32, 7),
): string => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      public_key: publicKey.toString("base64").replace(/=+$/, ""),
    }),
  );
  return createHash("sha256").update(publicKey).digest("base64url");
};

const input = {
  serverUrl: "https://linger.example.com",
  cookie: "teamhub_session=abc",
  displayName: "Laptop",
};

describe("enrollComputer", () => {
  it("creates with the session cookie and exchanges as the computer", async () => {
    const server = fakeServer();
    const enrolled = await enrollComputer({ ...input, fetch: server.fetch });
    expect(enrolled).toEqual({
      computerId: "computer_1",
      tenantId: "tenant_acme",
      ownerActorId: "actor_ann",
      gatewayUrl: "wss://linger.example.com/v1/runner",
      credential: TOKEN,
    });
    expect(server.calls.map((c) => [c.method, c.url, !!c.cookie])).toEqual([
      ["GET", "/v0/me", true],
      ["POST", "/v0/tenants/tenant_acme/local-computer-enrollments", true],
      ["POST", "/v0/local-computer-enrollments/enr_1/exchange", false],
    ]);
    expect(server.calls[1]?.body).not.toHaveProperty("computer_id");
  });

  it("keeps the Computer identity when enrolling again", async () => {
    const server = fakeServer();
    await enrollComputer({
      ...input,
      computerId: "computer_1",
      fetch: server.fetch,
    });
    expect(server.calls[1]?.body?.computer_id).toBe("computer_1");
  });

  it("rejects a bundle for another Computer", async () => {
    const server = fakeServer({
      bundle: {
        computer_id: "computer_2",
        tenant_id: "tenant_acme",
        gateway_url: "wss://linger.example.com/v1/runner",
        gateway_token: TOKEN,
        credential_expires_at: "2026-11-16T08:00:00Z",
      },
    });
    await expect(
      enrollComputer({ ...input, fetch: server.fetch }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("rejects a credential scoped to another tenant", async () => {
    const server = fakeServer({
      bundle: {
        computer_id: "computer_1",
        tenant_id: "tenant_acme",
        gateway_url: "wss://linger.example.com/v1/runner",
        gateway_token: `sr1.${claims({
          runner_id: "computer_1",
          tenant_owners: [
            { tenant_id: "tenant_other", owner_actor_id: "actor_ann" },
          ],
        })}.${"s".repeat(43)}`,
        credential_expires_at: "2026-11-16T08:00:00Z",
      },
    });
    await expect(
      enrollComputer({ ...input, fetch: server.fetch }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("reports a removed enrollment", async () => {
    const failure = await enrollComputer({
      ...input,
      fetch: fakeServer({ exchangeStatus: 410 }).fetch,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EnrollmentError);
    expect(failure).toMatchObject({ code: "ENROLLMENT_REMOVED" });
  });

  it("rejects a bundle without a WebSocket gateway", async () => {
    const server = fakeServer({
      bundle: {
        computer_id: "computer_1",
        tenant_id: "tenant_acme",
        gateway_url: "https://linger.example.com/v1/runner",
        gateway_token: TOKEN,
        credential_expires_at: "2026-11-16T08:00:00Z",
      },
    });
    await expect(
      enrollComputer({ ...input, fetch: server.fetch }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("includes daemon_id when provided", async () => {
    const server = fakeServer();
    const enrolled = await enrollComputer({
      ...input,
      daemonId: "A".repeat(43),
      fetch: server.fetch,
    });
    expect(server.calls[1]?.body?.daemon_id).toBe("A".repeat(43));
    expect(enrolled.daemonId).toBe("A".repeat(43));
  });

  it.each([
    ["predates the capability list", null],
    ["does not list the capability", []],
  ] as const)(
    "omits daemon_id for a server that %s",
    async (_name, capabilities) => {
      // TeamHub decodes request bodies strictly, so an older one rejects it.
      const server = fakeServer({ capabilities });
      const enrolled = await enrollComputer({
        ...input,
        daemonId: "A".repeat(43),
        fetch: server.fetch,
      });
      expect(server.calls[1]?.body).not.toHaveProperty("daemon_id");
      expect(enrolled.computerId).toBe("computer_1");
      expect(enrolled).not.toHaveProperty("daemonId");
    },
  );

  it("omits saved computer_id only when another owner signed in", async () => {
    const otherOwner = fakeServer({ meActorId: "actor_bob" });
    await enrollComputer({
      ...input,
      computerId: "computer_1",
      expectedOwnerActorId: "actor_ann",
      daemonId: "A".repeat(43),
      fetch: otherOwner.fetch,
    });
    expect(otherOwner.calls[1]?.body).not.toHaveProperty("computer_id");
    expect(otherOwner.calls[1]?.body?.daemon_id).toBe("A".repeat(43));

    const sameOwner = fakeServer({ meActorId: "actor_ann" });
    await enrollComputer({
      ...input,
      computerId: "computer_1",
      expectedOwnerActorId: "actor_ann",
      daemonId: "A".repeat(43),
      fetch: sameOwner.fetch,
    });
    expect(sameOwner.calls[1]?.body?.computer_id).toBe("computer_1");
  });

  it.each([404, 410])(
    "retries once without computer_id when create returns %i for a saved Computer",
    async (status) => {
      let createCalls = 0;
      const server = fakeServer({
        onCreate: () => {
          createCalls += 1;
          if (createCalls === 1) return new Response("{}", { status });
          return undefined;
        },
      });
      const enrolled = await enrollComputer({
        ...input,
        computerId: "computer_stale",
        daemonId: "D".repeat(43),
        fetch: server.fetch,
      });
      expect(enrolled.computerId).toBe("computer_1");
      const creates = server.calls.filter((call) =>
        call.url.endsWith("/local-computer-enrollments"),
      );
      expect(creates).toHaveLength(2);
      expect(creates[0]?.body?.computer_id).toBe("computer_stale");
      expect(creates[0]?.body?.daemon_id).toBe("D".repeat(43));
      expect(creates[1]?.body).not.toHaveProperty("computer_id");
      expect(creates[1]?.body?.daemon_id).toBe("D".repeat(43));
    },
  );

  it.each([
    ["DAEMON_IDENTITY_IN_USE", "DAEMON_IDENTITY_IN_USE"],
    ["LOCAL_COMPUTER_IDENTITY_MISMATCH", "DAEMON_IDENTITY_MISMATCH"],
  ] as const)(
    "maps 409 %s to EnrollmentError %s",
    async (serverCode, expectedCode) => {
      const server = fakeServer({
        onCreate: () =>
          Response.json(
            { error: { code: serverCode, message: "conflict" } },
            { status: 409 },
          ),
      });
      await expect(
        enrollComputer({
          ...input,
          daemonId: "D".repeat(43),
          fetch: server.fetch,
        }),
      ).rejects.toMatchObject({ code: expectedCode });
    },
  );

  it("invokes onAuthorized before exchange runs", async () => {
    const seen: unknown[] = [];
    const server = fakeServer({
      meActorId: "actor_ann",
      exchangeStatus: 500,
    });
    await expect(
      enrollComputer({
        ...input,
        onAuthorized: (authorized) => seen.push(authorized),
        fetch: server.fetch,
      }),
    ).rejects.toMatchObject({ code: "REJECTED" });
    expect(seen).toEqual([
      {
        computerId: "computer_1",
        tenantId: "tenant_acme",
        ownerActorId: "actor_ann",
      },
    ]);
  });
});

describe("readDaemonId", () => {
  it("computes the 43-char base64url SHA-256 of the daemon public key", () => {
    const dir = tempDirectory();
    const file = path.join(dir, "state", "daemon-identity.json");
    const expected = writeDaemonIdentity(file);
    expect(readDaemonId(file)).toBe(expected);
    expect(expected).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // Padded base64 is accepted identically.
    const key = Buffer.alloc(32, 9);
    const paddedFile = path.join(dir, "state", "padded.json");
    writeFileSync(
      paddedFile,
      JSON.stringify({ public_key: key.toString("base64") }),
    );
    expect(readDaemonId(paddedFile)).toBe(
      createHash("sha256").update(key).digest("base64url"),
    );
  });

  it("returns undefined for missing, malformed, or wrong-length files", () => {
    const dir = tempDirectory();
    expect(readDaemonId(path.join(dir, "missing.json"))).toBeUndefined();

    const invalidJson = path.join(dir, "invalid.json");
    writeFileSync(invalidJson, "{");
    expect(readDaemonId(invalidJson)).toBeUndefined();

    const shortKey = path.join(dir, "short.json");
    writeFileSync(
      shortKey,
      JSON.stringify({ public_key: Buffer.alloc(16, 1).toString("base64") }),
    );
    expect(readDaemonId(shortKey)).toBeUndefined();
  });
});

describe("EnrollmentModule", () => {
  const setupModule = (
    serverOverrides: ServerOverrides = {},
    initialServerUrl = "https://linger.example.com",
    initialConfig: Partial<DesktopConfig> = {},
    ensureDefault: () => Promise<void> = async () => {},
  ) => {
    const dir = tempDirectory();
    const daemonIdentityFile = path.join(dir, "daemon-identity.json");
    const daemonId = writeDaemonIdentity(daemonIdentityFile);
    const server = fakeServer({ meActorId: "actor_ann", ...serverOverrides });
    const credentials = new CredentialStore(path.join(dir, "credential.json"));
    const bus = new EventBus();
    const enrollment = new EnrollmentModule({
      sessionCookie: async () => "teamhub_session=abc",
      defaultDisplayName: "Laptop",
      credentials,
      daemonIdentityFile,
      fetch: server.fetch,
    });
    const host = testHost(
      [
        stubModule("Config"),
        {
          ...stubModule("WorkspaceGrants", ["Config"]),
          ensureDefault,
        } as never,
        enrollment,
      ],
      { serverUrl: initialServerUrl, ...initialConfig },
      bus,
    );
    return { enrollment, host, bus, server, credentials, daemonId };
  };

  // A computer enrolled by a release that did not name its daemon: Set Up
  // Again there paired computer_orphan while the daemon's identity stayed
  // bound to the Computer it had before.
  const enrolledWithoutDaemon = (
    serverOverrides: ServerOverrides = {},
    initialConfig: Partial<DesktopConfig> = {},
  ) => {
    const setup = setupModule(serverOverrides, "https://linger.example.com", {
      computerId: "computer_orphan",
      tenantId: "tenant_acme",
      ownerActorId: "actor_ann",
      ...initialConfig,
    });
    setup.credentials.write({
      computerId: "computer_orphan",
      gatewayUrl: "wss://linger.example.com/v1/runner",
      token: TOKEN,
    });
    return setup;
  };
  const enrollmentCalls = (calls: readonly Call[]): Call[] =>
    calls.filter((call) => call.url.endsWith("/local-computer-enrollments"));

  it("renews once at start an enrollment that did not name the daemon", async () => {
    const { host, server, daemonId } = enrolledWithoutDaemon({
      daemonHeldBy: "computer_1",
    });
    await host.start();
    await vi.waitFor(() =>
      expect(host.ctx.config.get().computerId).toBe("computer_1"),
    );
    const creates = enrollmentCalls(server.calls);
    expect(creates).toHaveLength(1);
    expect(creates[0]?.body).toMatchObject({
      computer_id: "computer_orphan",
      daemon_id: daemonId,
    });
    expect(host.ctx.config.get().daemonId).toBe(daemonId);
    await host.stop("quit");
  });

  it("does not renew at start an enrollment that named the daemon", async () => {
    const { host, server, daemonId } = enrolledWithoutDaemon();
    host.ctx.config.update({ daemonId });
    await host.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.calls).toEqual([]);
    expect(host.ctx.config.get().computerId).toBe("computer_orphan");
    await host.stop("quit");
  });

  it("does not renew at start only to name the daemon to a server that cannot take it", async () => {
    const { host, server } = enrolledWithoutDaemon({ capabilities: null });
    await host.start();
    await vi.waitFor(() =>
      expect(server.calls.map((call) => call.url)).toEqual(["/v0/me"]),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.calls.map((call) => call.url)).toEqual(["/v0/me"]);
    expect(host.ctx.config.get().computerId).toBe("computer_orphan");
    await host.stop("quit");
  });

  it("enrolls without the daemon's identity on a server that does not accept it", async () => {
    const { enrollment, host, server } = setupModule({ capabilities: null });
    await host.start();
    await enrollment.enroll();
    expect(enrollmentCalls(server.calls)[0]?.body).not.toHaveProperty(
      "daemon_id",
    );
    expect(host.ctx.config.get().computerId).toBe("computer_1");
    expect(host.ctx.config.get().daemonId).toBeUndefined();
    await host.stop("quit");
  });

  it("renews the same Computer ID after unenroll using savedEnrollments and daemonId", async () => {
    const { enrollment, host, server, daemonId } = setupModule();
    await host.start();
    const first = await enrollment.enroll();
    expect(first.computerId).toBe("computer_1");

    await enrollment.unenroll();
    expect(host.ctx.config.get().computerId).toBeUndefined();
    expect(host.ctx.config.get().savedEnrollments).toEqual({
      "https://linger.example.com": {
        computerId: "computer_1",
        tenantId: "tenant_acme",
        ownerActorId: "actor_ann",
      },
    });

    const second = await enrollment.enroll();
    expect(second.computerId).toBe("computer_1");
    const creates = server.calls.filter((call) =>
      call.url.endsWith("/local-computer-enrollments"),
    );
    expect(creates[1]?.body?.computer_id).toBe("computer_1");
    expect(creates[1]?.body?.daemon_id).toBe(daemonId);
    await host.stop("quit");
  });

  it("remembers an authorized Computer ID across an interrupted exchange", async () => {
    let failExchange = true;
    const { enrollment, host, server, daemonId } = setupModule({
      onExchange: () =>
        failExchange ? new Response("{}", { status: 500 }) : undefined,
    });
    await host.start();
    await expect(enrollment.enroll()).rejects.toMatchObject({
      code: "REJECTED",
    });
    expect(host.ctx.config.get().computerId).toBeUndefined();
    expect(host.ctx.config.get().savedEnrollments).toEqual({
      "https://linger.example.com": {
        computerId: "computer_1",
        tenantId: "tenant_acme",
        ownerActorId: "actor_ann",
      },
    });

    failExchange = false;
    const recovered = await enrollment.enroll();
    expect(recovered.computerId).toBe("computer_1");
    const creates = server.calls.filter((call) =>
      call.url.endsWith("/local-computer-enrollments"),
    );
    expect(creates[1]?.body?.computer_id).toBe("computer_1");
    expect(creates[1]?.body?.daemon_id).toBe(daemonId);
    await host.stop("quit");
  });

  it("keeps the enrollment when the same server moves to another origin", async () => {
    const { enrollment, host, bus, credentials, server } = setupModule(
      {},
      "http://localhost:3000",
      {
        savedEnrollments: { "https://other.example.com": { computerId: "c" } },
      },
    );
    await host.start();
    await enrollment.enroll();
    const credential = credentials.read();

    host.ctx.config.update({ serverUrl: "http://localhost:3001" });
    bus.emit("server.moved", "http://localhost:3000", "http://localhost:3001");

    const config = host.ctx.config.get();
    expect(config.computerId).toBe("computer_1");
    expect(credentials.read()).toEqual(credential);
    expect(config.savedEnrollments).toEqual({
      "https://other.example.com": { computerId: "c" },
      "http://localhost:3001": {
        computerId: "computer_1",
        tenantId: "tenant_acme",
        ownerActorId: "actor_ann",
      },
    });
    // Unenrolling later saves the enrollment under the new origin.
    await enrollment.unenroll();
    expect(
      Object.keys(host.ctx.config.get().savedEnrollments ?? {}),
    ).not.toContain("http://localhost:3000");
    // Enrolling again at the new origin renews the same Computer.
    await enrollment.enroll();
    const creates = server.calls.filter((call) =>
      call.url.endsWith("/local-computer-enrollments"),
    );
    expect(creates.at(-1)?.body?.computer_id).toBe("computer_1");
    await host.stop("quit");
  });

  it("saves the previous server origin on server.changed without polluting the new origin", async () => {
    const { enrollment, host, bus } = setupModule();
    await host.start();
    await enrollment.enroll();

    host.ctx.config.update({ serverUrl: "https://other.example.com" });
    bus.emit("server.changed", "https://other.example.com");
    await vi.waitFor(() =>
      expect(host.ctx.config.get().computerId).toBeUndefined(),
    );

    expect(host.ctx.config.get().savedEnrollments).toEqual({
      "https://linger.example.com": {
        computerId: "computer_1",
        tenantId: "tenant_acme",
        ownerActorId: "actor_ann",
      },
    });
    expect(
      host.ctx.config.get().savedEnrollments?.["https://other.example.com"],
    ).toBeUndefined();
    await host.stop("quit");
  });

  it("ensures default workspace grant before emitting computer.changed", async () => {
    const order: string[] = [];
    const { enrollment, host, bus } = setupModule(
      {},
      "https://linger.example.com",
      {},
      async () => {
        order.push("ensureDefault");
      },
    );
    bus.on("computer.changed", (computerId) => {
      if (computerId) order.push("computer.changed");
    });

    await host.start();
    await enrollment.enroll();

    expect(order).toEqual(["ensureDefault", "computer.changed"]);
    await host.stop("quit");
  });

  it("updates a saved loopback gateway URL and restarts the daemon when node-services moves ports", async () => {
    const { enrollment, credentials, host, bus } = setupModule(
      {
        bundle: {
          computer_id: "computer_1",
          tenant_id: "tenant_acme",
          gateway_url: "ws://127.0.0.1:62620/v1/runner-gateway",
          gateway_token: TOKEN,
          credential_expires_at: "2026-11-16T08:00:00Z",
        },
      },
      "http://localhost:3000",
    );
    await host.start();
    await enrollment.enroll();
    const original = credentials.read()!;
    const changed = vi.fn();
    bus.on("computer.changed", changed);

    expect(
      enrollment.syncLocalGatewayUrl("ws://127.0.0.1:59894/v1/runner-gateway"),
    ).toBe(true);
    expect(credentials.read()).toEqual({
      ...original,
      gatewayUrl: "ws://127.0.0.1:59894/v1/runner-gateway",
    });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledWith("computer_1");

    // Repeating the same URL is a no-op.
    expect(
      enrollment.syncLocalGatewayUrl("ws://127.0.0.1:59894/v1/runner-gateway"),
    ).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
    await host.stop("quit");
  });

  it("never rewrites a remote gateway URL or accepts a non-loopback target", async () => {
    const { enrollment, credentials, host, bus } = setupModule(
      {
        bundle: {
          computer_id: "computer_1",
          tenant_id: "tenant_acme",
          gateway_url: "wss://linger.example.com/v1/runner-gateway",
          gateway_token: TOKEN,
          credential_expires_at: "2026-11-16T08:00:00Z",
        },
      },
      "https://linger.example.com",
    );
    await host.start();
    await enrollment.enroll();
    const original = credentials.read()!;
    const changed = vi.fn();
    bus.on("computer.changed", changed);

    expect(
      enrollment.syncLocalGatewayUrl("ws://127.0.0.1:59894/v1/runner-gateway"),
    ).toBe(false);
    expect(
      enrollment.syncLocalGatewayUrl(
        "wss://evil.example.com/v1/runner-gateway",
      ),
    ).toBe(false);
    expect(credentials.read()).toEqual(original);
    expect(changed).not.toHaveBeenCalled();
    await host.stop("quit");
  });
});
