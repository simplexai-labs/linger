import { defineGlobalProperty } from "@/test/global-properties";
import { acceptRoomCreation } from "@/test/teamhub-test-runtime";
import { teamHubErrorResponse } from "@/test/teamhub-test-server";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { teamHubData } from "@/features/teamhub/teamhub-api";

import { tenantAgentAvailabilityQueryKey } from "../room-queries";

import { roomMessageSender } from "./room-message-sender";
import { browserRoomMessageOutbox } from "./room-message-outbox";
import {
  renderRoomChat,
  createTestStorage,
  testQueryClient,
  createTestTeamHubRuntime,
  servePeerActive,
  readTenantAgents,
  readAgentAvailability,
  openPanelTab,
} from "./room-chat.fixtures";

beforeEach(() => {
  defineGlobalProperty(window, "localStorage", {
    configurable: true,
    value: createTestStorage(),
  });
});

describe("Room Chat", () => {
  beforeEach(async () => {
    openPanelTab.mockReset();
    await browserRoomMessageOutbox.clearAccount("account-jenny");
  });

  it("invokes the Direct Room Agent without showing the synthetic Mention", async () => {
    const runtime = createTestTeamHubRuntime();

    const createMessage = vi.spyOn(
      roomMessageSender(runtime.client),
      "createMessage",
    );

    await renderRoomChat(
      runtime,
      testQueryClient(),
      "/t/tenant-northstar/rooms/room-dm-codex/chat",
    );

    await screen.findByText(/I can continue the Room V0 implementation/);
    fireEvent.change(await screen.findByLabelText("Message Room"), {
      target: { value: "Continue with the route tests" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(createMessage).toHaveBeenCalledOnce());
    expect(createMessage.mock.calls[0]?.[0]).toMatchObject({
      body: "@Codex Continue with the route tests",
      mentions: [expect.objectContaining({ id: "actor-codex", kind: "agent" })],
      roomId: "room-dm-codex",
    });
    await waitFor(() =>
      expect(screen.getByText("Continue with the route tests")).toBeVisible(),
    );
    expect(
      screen.queryByText("@Codex Continue with the route tests"),
    ).not.toBeInTheDocument();
  });

  it("does not project hardware Capture into a non-AnotherMe Direct Room", async () => {
    const runtime = createTestTeamHubRuntime();

    await renderRoomChat(
      runtime,
      testQueryClient(),
      "/t/tenant-northstar/rooms/room-dm-codex/chat",
    );

    await screen.findByText(/I can continue the Room V0 implementation/);
    expect(
      screen.queryByRole("region", { name: "Voice capture" }),
    ).not.toBeInTheDocument();
    cleanup();

    await renderRoomChat(
      runtime,
      testQueryClient(),
      "/t/tenant-northstar/rooms/room-all/chat",
    );
    await screen.findByText(/Reviewed the checklist/);

    expect(
      screen.queryByRole("region", { name: "Voice capture" }),
    ).not.toBeInTheDocument();
  });

  it("keeps a deleted Agent DM history visible and replaces the composer with a read-only notice", async () => {
    const fixture = createTestTeamHubRuntime();

    const directRoom = await teamHubData(
      fixture.client.api.GET("/v0/rooms/{roomId}", {
        params: { path: { roomId: "room-dm-codex" } },
      }),
    );
    fixture.server.on("GET", "/v0/rooms/{roomId}", () => ({
      ...directRoom,
      direct_peer_active: false,
    }));

    await renderRoomChat(
      fixture,
      testQueryClient(),
      "/t/tenant-northstar/rooms/room-dm-codex/chat",
    );

    expect(await screen.findByText("This Agent was deleted.")).toBeVisible();
    expect(screen.getByLabelText("Room timeline").textContent).toContain(
      "I can continue the Room V0 implementation",
    );
    expect(screen.queryByLabelText("Message Room")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Send message" }),
    ).not.toBeInTheDocument();
  });

  it("shows Runtime status for an offline Local Computer", async () => {
    const fixture = createTestTeamHubRuntime();
    const agents = await readTenantAgents(fixture);
    fixture.server.on("GET", "/v0/tenants/{tenantId}/agents", () => ({
      ...agents,
      items: agents.items.map((agent) =>
        agent.actor.id === "actor-codex"
          ? {
              ...agent,
              created_by: { ...agent.created_by, id: "actor-jenny" },
              runtime: {
                ...agent.runtime,
                placement: {
                  type: "local",
                  computer_id: "computer-offline",
                },
              },
            }
          : agent,
      ),
    }));
    const snapshots = await readAgentAvailability(fixture);
    fixture.server.on(
      "GET",
      "/v0/tenants/{tenantId}/agent-availability",
      () => ({
        ...snapshots,
        items: snapshots.items.map((item) =>
          item.actor_id === "actor-codex"
            ? {
                ...item,
                availability: {
                  ...item.availability,
                  status: "offline",
                  label: "Offline",
                },
                local_runtime_status: {
                  computer_id: "computer-offline",
                  computer_status: "offline",
                  connection_status: "offline",
                  display_name: "Offline computer",
                  message: "Local Computer is offline",
                  runtime_type: "codex",
                  status: "error",
                  error_code: "LOCAL_COMPUTER_OFFLINE",
                },
              }
            : item,
        ),
      }),
    );
    await renderRoomChat(
      fixture,
      testQueryClient(),
      "/t/tenant-northstar/rooms/room-dm-codex/chat",
    );
    expect(
      await screen.findByText("Offline computer is offline."),
    ).toBeVisible();
    expect(screen.getByLabelText("Message Room")).toBeEnabled();
  });

  it.each([
    ["codex", "Codex", "codex login"],
    ["claude", "Claude Code", "claude auth login"],
  ] as const)(
    "allows messages to an unauthenticated %s Local Agent with recovery guidance",
    async (runtimeType, runtimeName, command) => {
      const fixture = createTestTeamHubRuntime();

      const agents = await readTenantAgents(fixture);
      fixture.server.on(
        "GET",
        "/v0/tenants/{tenantId}/agent-availability",
        () => ({
          items: agents.items.map((agent) => ({
            actor_id: agent.actor.id,
            availability: {
              active_task_count: 0,
              label: "Online",
              status: "online" as const,
            },
            ...(agent.actor.id === "actor-codex"
              ? {
                  local_runtime_status: {
                    computer_id: "computer-jenny-mac",
                    computer_status: "online" as const,
                    display_name: "Jenny's Mac",
                    error_code: "RUNTIME_AUTHENTICATION_REQUIRED" as const,
                    message: "Claude authentication is required",
                    runtime_type: runtimeType,
                    status: "authentication_required" as const,
                    version: "2.1.227",
                  },
                }
              : {}),
          })),
          page: { has_more: false },
        }),
      );

      await renderRoomChat(
        fixture,
        testQueryClient(),
        "/t/tenant-northstar/rooms/room-dm-codex/chat",
      );

      expect(
        await screen.findByText(
          `${runtimeName} on Jenny's Mac needs you to sign in.`,
        ),
      ).toBeVisible();
      expect(screen.getByText(command)).toBeVisible();
      expect(screen.getByLabelText("Room timeline").textContent).toContain(
        "I can continue the Room V0 implementation",
      );
      const createMessage = vi.spyOn(
        roomMessageSender(fixture.client),
        "createMessage",
      );
      fireEvent.change(await screen.findByLabelText("Message Room"), {
        target: {
          value: "Save this message while authentication is unavailable",
        },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() => expect(createMessage).toHaveBeenCalledOnce());
      expect(createMessage.mock.calls[0]?.[0]).toMatchObject({
        body: "@Codex Save this message while authentication is unavailable",
        roomId: "room-dm-codex",
      });
      expect(
        screen.getByText(`${runtimeName} on Jenny's Mac needs you to sign in.`),
      ).toBeVisible();
      expect(
        screen.queryByText(/authentication expired/),
      ).not.toBeInTheDocument();
    },
  );

  it("preserves the DM draft across authentication recovery and diagnostic failures", async () => {
    const fixture = createTestTeamHubRuntime();

    const original = await readAgentAvailability(fixture);
    const availability = (
      status: "ready" | "authentication_required" | "error" | "unknown",
    ) => ({
      ...original,
      items: original.items.map((item) =>
        item.actor_id === "actor-codex"
          ? {
              ...item,
              local_runtime_status: {
                computer_id: "computer-local",
                computer_status:
                  status === "unknown"
                    ? ("unknown" as const)
                    : ("online" as const),
                display_name: "Acceptance server",
                runtime_type: "codex" as const,
                status,
                ...(status === "error"
                  ? { message: "Runtime diagnostic timed out" }
                  : {}),
              },
            }
          : item,
      ),
    });
    const listAvailability = vi.fn(() =>
      availability("authentication_required"),
    );
    fixture.server.on(
      "GET",
      "/v0/tenants/{tenantId}/agent-availability",
      listAvailability,
    );
    const queryClient = testQueryClient();
    await renderRoomChat(
      fixture,
      queryClient,
      "/t/tenant-northstar/rooms/room-dm-codex/chat",
    );
    await screen.findByText("codex login");
    const editor = await screen.findByLabelText("Message Room");
    fireEvent.change(editor, { target: { value: "Keep my unsent draft" } });
    for (const status of [
      "ready",
      "error",
      "unknown",
      "ready",
      "authentication_required",
    ] as const) {
      listAvailability.mockReturnValue(availability(status));
      await act(async () => {
        queryClient.setQueryData(
          tenantAgentAvailabilityQueryKey("tenant-northstar"),
          availability(status),
        );
      });
      expect(screen.getByLabelText("Message Room")).toBe(editor);
      expect(editor).toHaveValue("Keep my unsent draft");
      if (status === "unknown") {
        expect(
          await screen.findByText("Checking Acceptance server…"),
        ).toBeVisible();
        expect(
          screen.getByRole("button", { name: "Send message" }),
        ).toBeEnabled();
        expect(screen.queryByText("Agent unavailable")).not.toBeInTheDocument();
      }
      if (status === "error") {
        expect(
          await screen.findByText("Runtime diagnostic timed out"),
        ).toBeVisible();
        expect(screen.queryByText("codex login")).not.toBeInTheDocument();
      }
      if (status === "ready")
        await waitFor(() =>
          expect(screen.queryByText("codex login")).not.toBeInTheDocument(),
        );
      if (status === "authentication_required")
        await screen.findByText("codex login");
      expect(screen.getByLabelText("Message Room")).toBe(editor);
      expect(editor).toHaveValue("Keep my unsent draft");
    }
  });

  it("keeps the draft and history while the last ready Local Runtime reconnects", async () => {
    const runtime = createTestTeamHubRuntime();

    const original = await readAgentAvailability(runtime);
    const snapshot = {
      ...original,
      items: original.items.map((item) =>
        item.actor_id === "actor-codex"
          ? {
              ...item,
              local_runtime_status: {
                computer_id: "local",
                display_name: "Computer",
                computer_status: "unknown" as const,
                runtime_type: "codex" as const,
                status: "ready" as const,
                connection_status: "reconnecting" as const,
                observed_at: "2026-09-28T01:00:00Z",
              },
            }
          : item,
      ),
    };
    runtime.server.on(
      "GET",
      "/v0/tenants/{tenantId}/agent-availability",
      () => snapshot,
    );
    const queryClient = testQueryClient();
    await renderRoomChat(
      runtime,
      queryClient,
      "/t/tenant-northstar/rooms/room-dm-codex/chat",
    );
    const editor = await screen.findByLabelText("Message Room");
    fireEvent.change(editor, { target: { value: "Keep this draft" } });
    const notice = await screen.findByText("Reconnecting to Computer…");
    expect(notice.closest('[role="status"]')).not.toHaveClass("border-t");
    expect(notice.closest('[role="status"]')).toHaveAttribute(
      "title",
      expect.stringMatching(/^Last confirmed at /),
    );
    expect(screen.queryByText("Agent unavailable")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
    expect(screen.getByLabelText("Room timeline").textContent).toContain(
      "I can continue the Room V0 implementation",
    );
    await act(async () => {
      queryClient.setQueryData(
        tenantAgentAvailabilityQueryKey("tenant-northstar"),
        {
          ...snapshot,
          items: snapshot.items.map((item) =>
            item.local_runtime_status
              ? {
                  ...item,
                  local_runtime_status: {
                    ...item.local_runtime_status,
                    connection_status: "connected",
                    computer_status: "online",
                  },
                }
              : item,
          ),
        },
      );
    });
    await waitFor(() =>
      expect(
        screen.queryByText("Reconnecting to Computer…"),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText("Message Room")).toBe(editor);
    expect(editor).toHaveValue("Keep this draft");
  });

  it("focuses the composer once when an Agent DM entry requests it", async () => {
    const runtime = createTestTeamHubRuntime();

    const router = await renderRoomChat(
      runtime,
      testQueryClient(),
      "/t/tenant-northstar/rooms/room-dm-codex/chat",
      true,
    );

    const editor = await screen.findByLabelText("Message Room");
    await waitFor(() => expect(editor).toHaveFocus());
    await waitFor(() => expect(router.state.location.state).toBeNull());
  });

  it("does not offer Humans or Agents who are not Room members", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomCreation(runtime);

    const room = await teamHubData(
      runtime.client.api.POST("/v0/tenants/{tenantId}/rooms", {
        params: { path: { tenantId: "tenant-northstar" } },
        body: { name: "Private planning" },
      }),
    );

    await renderRoomChat(
      runtime,
      testQueryClient(),
      `/t/tenant-northstar/rooms/${room.id}/chat`,
    );

    const editor = await screen.findByLabelText("Message Room");
    fireEvent.change(editor, { target: { selectionStart: 1, value: "@" } });

    expect(
      await screen.findByRole("option", { name: /Jenny Bin/ }),
    ).toBeVisible();
    expect(screen.queryByRole("option", { name: /Maya Chen/ })).toBeNull();
    expect(
      screen.queryByRole("option", { name: /Jenny's Delegate/ }),
    ).toBeNull();
    expect(screen.queryByRole("option", { name: /Codex/ })).toBeNull();
    expect(screen.queryByText("Adds to Room")).not.toBeInTheDocument();
  });

  it("keeps Room composition available when the Agent directory fails", async () => {
    const runtime = createTestTeamHubRuntime();

    const listTenantAgents = vi
      .fn()
      .mockReturnValueOnce(
        teamHubErrorResponse(
          500,
          "AGENT_DIRECTORY_UNAVAILABLE",
          "Directory unavailable.",
        ),
      )
      .mockReturnValue({ items: [], page: { has_more: false } });
    runtime.server.on("GET", "/v0/tenants/{tenantId}/agents", listTenantAgents);
    const createMessage = vi.spyOn(
      roomMessageSender(runtime.client),
      "createMessage",
    );

    await renderRoomChat(runtime, testQueryClient());

    const editor = await screen.findByLabelText("Message Room");
    expect(
      await screen.findByText("Your agents are unavailable"),
    ).toBeVisible();
    fireEvent.change(editor, { target: { selectionStart: 4, value: "@Cod" } });
    expect(screen.queryByRole("option", { name: /Codex/ })).toBeNull();
    fireEvent.change(editor, { target: { value: "Still deliver this" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(createMessage).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(listTenantAgents).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.queryByText("Your agents are unavailable"),
      ).not.toBeInTheDocument(),
    );
  });

  it.each(["pending", "failed"])(
    "allows typing with an active peer while the Agent directory is %s",
    async (directoryState) => {
      const runtime = createTestTeamHubRuntime();

      servePeerActive(runtime, true);
      runtime.server.on("GET", "/v0/tenants/{tenantId}/agents", () =>
        directoryState === "pending"
          ? new Promise(() => {})
          : teamHubErrorResponse(
              500,
              "AGENT_DIRECTORY_UNAVAILABLE",
              "Directory unavailable.",
            ),
      );
      await renderRoomChat(
        runtime,
        testQueryClient(),
        "/t/tenant-northstar/rooms/room-dm-codex/chat",
      );
      const composer = await screen.findByLabelText("Message Room");
      fireEvent.change(composer, {
        target: { value: "typing without directory" },
      });
      expect(composer).toHaveValue("typing without directory");
      if (directoryState === "failed") {
        expect(
          await screen.findByText("Your agents are unavailable"),
        ).toBeVisible();
        expect(composer).toHaveValue("typing without directory");
      }
    },
  );

  it.each([false, undefined])(
    "does not unlock an unconfirmed peer while directory is pending (active=%s)",
    async (active) => {
      const runtime = createTestTeamHubRuntime();

      servePeerActive(runtime, active);
      runtime.server.on(
        "GET",
        "/v0/tenants/{tenantId}/agents",
        () => new Promise(() => {}),
      );
      await renderRoomChat(
        runtime,
        testQueryClient(),
        "/t/tenant-northstar/rooms/room-dm-codex/chat",
      );
      await screen.findByText(
        active === false
          ? "This Agent was deleted."
          : "Can't load this Agent right now.",
      );
      expect(screen.queryByLabelText("Message Room")).not.toBeInTheDocument();
    },
  );

  it("keeps a peer missing from the completed directory read-only", async () => {
    const runtime = createTestTeamHubRuntime();

    servePeerActive(runtime, true);
    runtime.server.on("GET", "/v0/tenants/{tenantId}/agents", () => ({
      items: [],
      page: { has_more: false },
    }));
    await renderRoomChat(
      runtime,
      testQueryClient(),
      "/t/tenant-northstar/rooms/room-dm-codex/chat",
    );
    await screen.findByText("Can't load this Agent right now.");
    expect(screen.queryByLabelText("Message Room")).not.toBeInTheDocument();
  });

  it("keeps a legacy Agent DM without authoritative peer state read-only until directory retry", async () => {
    const runtime = createTestTeamHubRuntime();

    servePeerActive(runtime, undefined);
    const agents = await readTenantAgents(runtime);
    const listTenantAgents = vi
      .fn()
      .mockReturnValueOnce(
        teamHubErrorResponse(
          500,
          "AGENT_DIRECTORY_UNAVAILABLE",
          "Directory unavailable.",
        ),
      )
      .mockReturnValue(agents);
    runtime.server.on("GET", "/v0/tenants/{tenantId}/agents", listTenantAgents);

    await renderRoomChat(
      runtime,
      testQueryClient(),
      "/t/tenant-northstar/rooms/room-dm-codex/chat",
    );

    expect(
      await screen.findByText("Can't load this Agent right now."),
    ).toBeVisible();
    expect(screen.queryByLabelText("Message Room")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(listTenantAgents).toHaveBeenCalledTimes(2));
    expect(await screen.findByLabelText("Message Room")).toBeVisible();
  });
});
