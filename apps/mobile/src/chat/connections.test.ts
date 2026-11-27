import { describe, expect, it, vi } from "vitest";

import type { ExternalApp, ExternalConnection } from "../api/types";
import {
  AppUnavailableForAgents,
  accountChoices,
  connectLink,
  defaultAccount,
  prepareAuthorization,
  usableConnectUrl,
  type ConnectionCalls,
} from "./connections";

const LATER = "2999-01-01T00:00:00Z";
const EARLIER = "2000-01-01T00:00:00Z";

function connection(
  id: string,
  status: ExternalConnection["status"],
  more: Partial<ExternalConnection> = {},
): ExternalConnection {
  return {
    id,
    provider: "gmail",
    status,
    revision: 3,
    auto_reminders: false,
    created_at: EARLIER,
    updated_at: EARLIER,
    ...more,
  };
}

const gmail: ExternalApp = {
  key: "gmail",
  display_name: "Gmail",
  description: "Mail",
  availability: "available",
  capabilities: ["connect", "agent_tools"],
  allows_multiple_connections: true,
};

function calls(overrides: Partial<ConnectionCalls> = {}): ConnectionCalls {
  return {
    get: vi.fn(async (id: string) => connection(id, "pending")),
    create: vi.fn(async () =>
      connection("new", "pending", {
        connect_url: "https://connect.example/new",
        connect_expires_at: LATER,
      }),
    ),
    reauthorize: vi.fn(async (existing: ExternalConnection) => ({
      ...existing,
      reauthorizing: true,
      reauthorization_connect_url: "https://connect.example/again",
      reauthorization_connect_expires_at: LATER,
    })),
    ...overrides,
  };
}

describe("account choices", () => {
  it("offers usable and repairable accounts of the app, not abandoned ones", () => {
    const choices = accountChoices(
      [
        connection("a", "active"),
        connection("b", "expired"),
        connection("c", "pending"),
        connection("d", "failed", {
          status_error_code: "duplicate_remote_principal",
        }),
        connection("e", "active", { provider: "outlook" }),
      ],
      "gmail",
    );
    expect(choices.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("keeps the Connection this card started while it is pending", () => {
    const started = connection("c", "pending");
    expect(
      accountChoices([connection("a", "active")], "gmail", started).map(
        (item) => item.id,
      ),
    ).toEqual(["a", "c"]);
  });

  it("preselects the account the Agent named, else a new one", () => {
    const choices = [
      connection("a", "active", { identity_label: "me@example.com" }),
      connection("b", "active", { identity_label: "Work@Example.com" }),
    ];
    expect(defaultAccount(choices, "work@example.com", true)?.id).toBe("b");
    expect(defaultAccount(choices, "other@example.com", true)).toBeUndefined();
    expect(defaultAccount(choices, "other@example.com", false)?.id).toBe("a");
    expect(defaultAccount(choices, undefined, true)?.id).toBe("a");
  });

  it("prefers an active account over one to repair", () => {
    expect(
      defaultAccount(
        [connection("a", "expired"), connection("b", "active")],
        undefined,
        true,
      )?.id,
    ).toBe("b");
  });
});

describe("connect links", () => {
  it("uses a link only until it expires", () => {
    expect(
      usableConnectUrl({ connect_url: "u", connect_expires_at: LATER }),
    ).toBe("u");
    expect(
      usableConnectUrl({ connect_url: "u", connect_expires_at: EARLIER }),
    ).toBeUndefined();
  });

  it("resumes an open attempt before creating a Connection", async () => {
    const api = calls({
      get: vi.fn(async (id: string) =>
        connection(id, "pending", {
          connect_url: "https://connect.example/open",
          connect_expires_at: LATER,
        }),
      ),
    });
    const result = await connectLink(
      "gmail",
      [connection("p", "pending")],
      api,
    );
    expect(result.connectUrl).toBe("https://connect.example/open");
    expect(api.create).not.toHaveBeenCalled();
  });

  it("creates a Connection when the open attempt's link expired", async () => {
    const api = calls();
    const result = await connectLink(
      "gmail",
      [connection("p", "pending")],
      api,
    );
    expect(result.connection.id).toBe("new");
    expect(result.connectUrl).toBe("https://connect.example/new");
  });
});

describe("preparing a connection authorization", () => {
  it("approves an active account without a sign-in", async () => {
    const api = calls();
    const active = connection("a", "active");
    const prepared = await prepareAuthorization({
      app: gmail,
      chosen: active,
      connections: [active],
      calls: api,
    });
    expect(prepared).toEqual({ connection: active, started: false });
    expect(api.create).not.toHaveBeenCalled();
  });

  it("reauthorizes an account that needs reconnecting", async () => {
    const api = calls();
    const expired = connection("b", "expired");
    const prepared = await prepareAuthorization({
      app: gmail,
      chosen: expired,
      connections: [expired],
      calls: api,
    });
    expect(prepared.connection.id).toBe("b");
    expect(prepared.connectUrl).toBe("https://connect.example/again");
    expect(api.reauthorize).toHaveBeenCalledWith(expired);
  });

  it("starts a new Connection when the app cannot verify the same account", async () => {
    const api = calls();
    const expired = connection("b", "expired");
    const prepared = await prepareAuthorization({
      app: { ...gmail, supports_reauthorization: false },
      chosen: expired,
      connections: [expired],
      calls: api,
    });
    expect(prepared).toMatchObject({
      connection: { id: "new" },
      connectUrl: "https://connect.example/new",
      started: true,
    });
    expect(api.reauthorize).not.toHaveBeenCalled();
  });

  it("starts over when a chosen pending sign-in expired", async () => {
    const api = calls();
    const pending = connection("c", "pending");
    const prepared = await prepareAuthorization({
      app: gmail,
      chosen: pending,
      connections: [pending],
      calls: api,
    });
    expect(prepared.connection.id).toBe("new");
    expect(prepared.started).toBe(true);
  });

  it("refuses a new account of an app Agents cannot use", async () => {
    await expect(
      prepareAuthorization({
        app: { ...gmail, capabilities: ["connect"] },
        chosen: undefined,
        connections: [],
        calls: calls(),
      }),
    ).rejects.toBeInstanceOf(AppUnavailableForAgents);
  });
});
