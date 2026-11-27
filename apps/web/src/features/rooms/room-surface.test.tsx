import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// These component tests control panel data readiness. Load the real module
// before their assertions; production E2E covers delayed panel code loading.
import "./task-sidebar/room-task-sidebar";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { act, useEffect } from "react";
import { createMemoryRouter, Outlet } from "react-router";
import { RouterProvider } from "react-router/dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  acceptRoomMessages,
  acceptTenantAgentUpdates,
  createTestTeamHubRuntime,
  type TestTeamHubRuntime,
} from "@/test/teamhub-test-runtime";
import { seedRoomUpload } from "@/test/document-scenarios";
import type { RoomRealtimeStatus } from "@/features/teamhub/event-transport";
import { teamHubData, teamHubDone } from "@/features/teamhub/teamhub-api";
import type { TeamHubMessage } from "@/features/teamhub/teamhub-types";
import type {
  TestRouteHandler,
  TestRouteRequest,
} from "@/test/teamhub-test-server";
import {
  type TeamHubRuntime,
  TeamHubRuntimeProvider,
} from "@/features/teamhub/teamhub-runtime";

import { RoomChat } from "./chat/room-chat";
import {
  roomDocumentsQueryOptions,
  roomMembersQueryOptions,
  roomMessagesInfiniteQueryOptions,
  roomQueryOptions,
  teamHubIdentityQueryOptions,
  tenantActorsQueryOptions,
} from "./room-queries";
import { RoomSurface } from "./room-surface";
import {
  openPanelTab,
  setActivePanelTab,
} from "./task-sidebar/panel-tab-store";
import { panelTabKey } from "./task-sidebar/panel-tab-types";

const realtimeFixture = vi.hoisted(
  (): {
    status: RoomRealtimeStatus;
    onMessageCreated?: (message: TeamHubMessage) => void;
    onTeamMdPublished?: () => void;
  } => ({
    status: "connected",
  }),
);

vi.mock("./chat/room-realtime-sync", () => ({
  RoomRealtimeSync: ({
    onMessageCreated,
    onStatusChange,
    onTeamMdPublished,
  }: {
    onMessageCreated?: (message: TeamHubMessage) => void;
    onStatusChange?: (status: RoomRealtimeStatus) => void;
    onTeamMdPublished?: () => void;
  }) => {
    useEffect(() => onStatusChange?.(realtimeFixture.status), [onStatusChange]);
    useEffect(() => {
      realtimeFixture.onMessageCreated = onMessageCreated;
    }, [onMessageCreated]);
    useEffect(() => {
      realtimeFixture.onTeamMdPublished = onTeamMdPublished;
    }, [onTeamMdPublished]);
    return realtimeFixture.status === "connected" ? null : (
      <div role="status">Room connection status</div>
    );
  },
}));

describe("RoomSurface command availability", () => {
  beforeEach(() => {
    realtimeFixture.status = "connected";
    realtimeFixture.onMessageCreated = undefined;
    realtimeFixture.onTeamMdPublished = undefined;
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        get length() {
          return store.size;
        },
        clear() {
          store.clear();
        },
        getItem(key: string) {
          return store.get(key) ?? null;
        },
        key(index: number) {
          return [...store.keys()][index] ?? null;
        },
        removeItem(key: string) {
          store.delete(key);
        },
        setItem(key: string, value: string) {
          store.set(key, value);
        },
      } satisfies Storage,
    });
  });

  it("shows a closable loading panel and keeps the composer usable while panel data waits", async () => {
    const runtime = surfaceRuntime();
    const documents = await teamHubData(
      runtime.client.api.GET("/v0/rooms/{roomId}/documents", {
        params: { path: { roomId: "room-all" } },
      }),
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime.server.on("GET", "/v0/rooms/{roomId}/documents", async () => {
      await gate;
      return documents;
    });
    const router = await renderRoomSurface(
      "room-all",
      "",
      runtime,
      <RoomChat />,
    );
    try {
      const composer = await screen.findByRole("textbox", {
        name: /^Message Room$/,
      });
      fireEvent.click(
        await screen.findByRole("button", { name: "Show sidebar" }),
      );
      const loading = await screen.findByRole("complementary", {
        name: "Loading panel sidebar",
      });
      expect(loading).toHaveAttribute("data-open", "true");
      expect(loading).toHaveAttribute("aria-busy", "true");
      fireEvent.change(composer, {
        target: { value: "Typing while the panel loads" },
      });
      expect(composer).toHaveValue("Typing while the panel loads");
      fireEvent.click(
        within(loading).getByRole("button", { name: "Hide sidebar" }),
      );
      await waitFor(() =>
        expect(
          screen.queryByRole("complementary", {
            name: "Loading panel sidebar",
          }),
        ).not.toBeInTheDocument(),
      );
      fireEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
      expect(
        await screen.findByRole("complementary", {
          name: "Loading panel sidebar",
        }),
      ).toBeVisible();
      release();
      const panel = await screen.findByRole("complementary", {
        name: "Panel sidebar",
      });
      expect(panel).toHaveAttribute("data-open", "true");
      expect(composer).toHaveValue("Typing while the panel loads");
    } finally {
      release();
      router.dispose();
    }
  });

  it("keeps Room settings available while Room SSE reconnects", async () => {
    realtimeFixture.status = "reconnecting";

    await renderRoomSurface();

    fireEvent.click(
      await screen.findByRole("button", { name: /settings from avatar$/ }),
    );
    // Renaming in place is what proves the panel is still usable.
    fireEvent.click(await screen.findByRole("button", { name: /^Rename / }));
    const name = screen.getByRole("textbox", { name: "Name" });
    expect(name).toBeEnabled();
    fireEvent.change(name, { target: { value: "Reconnected Room" } });
    expect(name).toHaveValue("Reconnected Room");
  });

  it("keeps transient Room connection state inside the header layout", async () => {
    realtimeFixture.status = "reconnecting";

    await renderRoomSurface();

    const status = await screen.findByRole("status");
    expect(status.closest("header")).toBeInTheDocument();
  });

  it("keeps the Chat header fade and action order", async () => {
    await renderRoomSurface();
    const header = await screen.findByRole("banner");

    expect(header).toHaveClass("room-header--chat");
    expect(
      within(header).queryByRole("link", { name: "Chat" }),
    ).not.toBeInTheDocument();
    expect(
      within(header).queryByRole("link", { name: "Files" }),
    ).not.toBeInTheDocument();
    expect(
      within(header).queryByRole("navigation", { name: "Room views" }),
    ).not.toBeInTheDocument();
    expect(
      within(header).queryByRole("button", { name: "Open Room members" }),
    ).not.toBeInTheDocument();
    expect(
      within(header).queryByRole("button", { name: "Room settings" }),
    ).not.toBeInTheDocument();
    const settings = within(header).getByRole("button", {
      name: "Open all settings from avatar",
    });
    const sidebar = within(header).getByRole("button", {
      name: "Show sidebar",
    });
    expect(sidebar.querySelector("svg")).not.toBeNull();
    expect(settings.compareDocumentPosition(sidebar)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("keeps long Room titles inside the Room column when the panel opens", async () => {
    await renderRoomSurface();

    const header = await screen.findByRole("banner");
    fireEvent.click(
      within(header).getByRole("button", { name: "Show sidebar" }),
    );
    expect(
      within(header).queryByRole("button", { name: "Show sidebar" }),
    ).not.toBeInTheDocument();

    const title = within(header).getByRole("heading", { name: "all" });
    const titleRegion = title.parentElement;
    const actions = header.querySelector(
      "[data-panel-trigger-slot]",
    )?.parentElement;

    expect(titleRegion).toHaveClass("min-w-0");
    expect(titleRegion).not.toHaveClass("md:shrink-0");
    expect(title).toHaveClass("truncate");
    expect(actions).toHaveClass("shrink-0");
  });

  it("keeps Room membership commands available while realtime is offline", async () => {
    realtimeFixture.status = "offline";

    await renderRoomSurface("room-gtm-launch");

    fireEvent.click(
      await screen.findByRole("button", { name: /settings from avatar$/ }),
    );
    await screen.findByTestId("panel-room-settings");
    expect(
      await screen.findByRole("button", { name: "Add member" }),
    ).toBeEnabled();
  });

  it("uses the Direct Room adapter in live mode to hide group controls", async () => {
    const runtime = {
      ...surfaceRuntime(),
      mode: "live" as const,
    };

    await renderRoomSurface("room-dm-codex", "", runtime);

    expect(await screen.findByRole("heading", { name: "Codex" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Open Room members" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Room settings" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete Room" }),
    ).not.toBeInTheDocument();
  });

  it("removes the Sponsor's direct Room together with its Agent", async () => {
    const runtime = surfaceRuntime();

    const directRoom = await teamHubData(
      runtime.client.api.GET("/v0/rooms/{roomId}", {
        params: { path: { roomId: "room-dm-codex" } },
      }),
    );
    await teamHubDone(
      runtime.client.api.DELETE("/v0/tenants/{tenantId}/agents/{agentId}", {
        params: {
          path: {
            tenantId: "tenant-northstar",
            agentId: directRoom.direct_peer!.id,
          },
        },
      }),
    );

    await expect(
      teamHubData(
        runtime.client.api.GET("/v0/rooms/{roomId}", {
          params: { path: { roomId: directRoom.id } },
        }),
      ),
    ).rejects.toThrow();
    const rooms = await teamHubData(
      runtime.client.api.GET("/v0/tenants/{tenantId}/rooms", {
        params: { path: { tenantId: "tenant-northstar" } },
      }),
    );
    expect(rooms.items.some((room) => room.id === directRoom.id)).toBe(false);
  });

  it("aligns deleted-Agent Direct Room header and delete dialog names with direct_peer", async () => {
    const runtime = surfaceRuntime();
    const directRoom = await teamHubData(
      runtime.client.api.GET("/v0/rooms/{roomId}", {
        params: { path: { roomId: "room-dm-codex" } },
      }),
    );
    runtime.server.on("GET", "/v0/rooms/{roomId}", () => ({
      ...directRoom,
      direct_peer: {
        ...directRoom.direct_peer!,
        display_name: "Renamed Codex",
      },
      direct_peer_active: false,
      name: "Old Codex",
    }));
    // Revoked Agents are excluded from the active tenant actors catalog.
    runtime.server.on("GET", "/v0/tenants/{tenantId}/actors", () => ({
      items: runtime.seed.actors.filter(
        (actor) => actor.id !== directRoom.direct_peer!.id,
      ),
      page: { has_more: false },
    }));
    const deleteRoom = vi.fn<TestRouteHandler>(() => undefined);
    runtime.server.on("DELETE", "/v0/rooms/{roomId}", deleteRoom);

    const router = await renderRoomSurface("room-dm-codex", "", runtime);

    expect(
      await screen.findByRole("heading", { name: "Renamed Codex" }),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Delete Room" }));

    const dialog = await screen.findByRole("dialog", { name: "Delete Room" });
    expect(dialog).toHaveTextContent(
      "Renamed Codex will be deleted. Its messages, files, and history will no longer be available.",
    );
    expect(dialog).not.toHaveTextContent("Old Codex");
    expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete Room" }),
    );
    await waitFor(() => expect(deleteRoom).toHaveBeenCalledOnce());
    await screen.findByText("Rooms");
    expect(router.state.location.pathname).toBe("/t/tenant-northstar/rooms");
  });

  it("defaults to Agent Info and preserves an explicit close across Room visits", async () => {
    const router = await renderRoomSurface("room-dm-codex", "");
    fireEvent.click(
      await screen.findByRole("button", { name: "Show sidebar" }),
    );
    expect(
      await screen.findByRole("tab", { name: "Agent · Codex" }),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Close Agent · Codex" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Conversation details" }),
    ).toBeVisible();
    await act(async () => {
      await router.navigate("/t/tenant-northstar/rooms/room-all/chat");
    });
    await act(async () => {
      await router.navigate("/t/tenant-northstar/rooms/room-dm-codex/chat");
    });
    const showSidebar = screen.queryByRole("button", { name: "Show sidebar" });
    if (showSidebar) fireEvent.click(showSidebar);
    expect(
      await screen.findByRole("heading", { name: "Conversation details" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("tab", { name: "Agent · Codex" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Agent info" }));
    expect(
      await screen.findByRole("tab", { name: "Agent · Codex" }),
    ).toBeVisible();
  });

  it("opens Collaboration in the closed sidebar when an Agent publishes team.md", async () => {
    await renderRoomSurface("room-all");
    expect(
      await screen.findByRole("button", { name: "Show sidebar" }),
    ).toBeVisible();

    act(() => realtimeFixture.onTeamMdPublished?.());

    const sidebar = await screen.findByRole("complementary", {
      name: "Panel sidebar",
    });
    expect(
      within(sidebar).getByRole("tab", { name: "Collaboration" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(
      await within(sidebar).findByText(
        "Review the launch plan against implementation evidence.",
      ),
    ).toBeVisible();
  });

  it("auto-opens a previewable Agent file in the sidebar and switches to it while keeping earlier tabs", async () => {
    const runtime = surfaceRuntime();
    const htmlDoc = await seedRoomUpload(runtime, "bike-html", {
      file: new File(["<h1>Bike</h1>"], "bike.html", { type: "text/html" }),
      representationFormat: "html",
    });
    const htmlVersion = htmlDoc.current_version!;
    const secondHtmlDoc = await seedRoomUpload(runtime, "summary-html", {
      file: new File(["<h1>Summary</h1>"], "summary.html", {
        type: "text/html",
      }),
      representationFormat: "html",
    });
    const secondHtmlVersion = secondHtmlDoc.current_version!;

    await renderRoomSurface("room-all", "", runtime);
    expect(
      await screen.findByRole("button", { name: "Show sidebar" }),
    ).toBeVisible();

    act(() =>
      realtimeFixture.onMessageCreated?.({
        id: "message-agent-html",
        tenant_id: "tenant-northstar",
        room_id: "room-all",
        author: {
          id: "actor-codex",
          kind: "agent",
          display_name: "Codex",
          tenant_id: "tenant-northstar",
        },
        message_kind: "conversation",
        raw_message: "bike.html",
        segments: [
          {
            type: "file",
            content: "bike.html",
            document_id: htmlDoc.id,
            document_version_id: htmlVersion.id,
            filename: "bike.html",
            media_type: "text/html",
          },
        ],
        attachments: [
          {
            id: "att-bike-html",
            document_id: htmlDoc.id,
            document_version_id: htmlVersion.id,
            filename: "bike.html",
            media_type: "text/html",
            size_bytes: 13,
            sha256: htmlVersion.sha256,
            available: true,
          },
        ],
        created_at: "2026-11-27T10:00:00Z",
      }),
    );

    const sidebar = await screen.findByRole("complementary", {
      name: "Panel sidebar",
    });
    expect(
      await within(sidebar).findByRole("tab", { name: "bike.html" }),
    ).toHaveAttribute("aria-selected", "true");

    // A second delivered file switches the active tab without closing the first.
    act(() =>
      realtimeFixture.onMessageCreated?.({
        id: "message-agent-html-2",
        tenant_id: "tenant-northstar",
        room_id: "room-all",
        author: {
          id: "actor-codex",
          kind: "agent",
          display_name: "Codex",
          tenant_id: "tenant-northstar",
        },
        message_kind: "conversation",
        raw_message: "summary.html",
        segments: [
          {
            type: "file",
            content: "summary.html",
            document_id: secondHtmlDoc.id,
            document_version_id: secondHtmlVersion.id,
            filename: "summary.html",
            media_type: "text/html",
          },
        ],
        attachments: [
          {
            id: "att-summary-html",
            document_id: secondHtmlDoc.id,
            document_version_id: secondHtmlVersion.id,
            filename: "summary.html",
            media_type: "text/html",
            size_bytes: 16,
            sha256: secondHtmlVersion.sha256,
            available: true,
          },
        ],
        created_at: "2026-11-27T10:01:00Z",
      }),
    );

    expect(
      await within(sidebar).findByRole("tab", { name: "summary.html" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(
      within(sidebar).getByRole("tab", { name: "bike.html" }),
    ).toHaveAttribute("aria-selected", "false");
  });

  it("does not auto-open the sidebar for a non-previewable Agent zip or a Human html file", async () => {
    const runtime = surfaceRuntime();
    const htmlDoc = await seedRoomUpload(runtime, "human-html", {
      file: new File(["<p>Hi</p>"], "human.html", { type: "text/html" }),
      representationFormat: "html",
    });
    const htmlVersion = htmlDoc.current_version!;

    await renderRoomSurface("room-all", "", runtime);
    expect(
      await screen.findByRole("button", { name: "Show sidebar" }),
    ).toBeVisible();

    act(() =>
      realtimeFixture.onMessageCreated?.({
        id: "message-agent-zip",
        tenant_id: "tenant-northstar",
        room_id: "room-all",
        author: {
          id: "actor-codex",
          kind: "agent",
          display_name: "Codex",
          tenant_id: "tenant-northstar",
        },
        message_kind: "conversation",
        raw_message: "lev8-gtm-assets.zip",
        segments: [
          {
            type: "file",
            content: "lev8-gtm-assets.zip",
            document_id: "document-lev8-gtm-assets",
            document_version_id: "document-lev8-gtm-assets-version-1",
            filename: "lev8-gtm-assets.zip",
            media_type: "application/zip",
          },
        ],
        attachments: [
          {
            id: "att-zip",
            document_id: "document-lev8-gtm-assets",
            document_version_id: "document-lev8-gtm-assets-version-1",
            filename: "lev8-gtm-assets.zip",
            media_type: "application/zip",
            size_bytes: 45,
            sha256:
              "70b1f586b40a29afa751fe326d68367257655aa296caca0c9a29c52c10c70021",
            available: true,
          },
        ],
        created_at: "2026-11-27T10:00:00Z",
      }),
    );

    expect(
      screen.queryByRole("complementary", { name: "Panel sidebar" }),
    ).not.toBeInTheDocument();

    act(() =>
      realtimeFixture.onMessageCreated?.({
        id: "message-human-html",
        tenant_id: "tenant-northstar",
        room_id: "room-all",
        author: {
          id: "actor-jenny",
          kind: "human",
          display_name: "Jenny",
          tenant_id: "tenant-northstar",
        },
        message_kind: "conversation",
        raw_message: "human.html",
        segments: [
          {
            type: "file",
            content: "human.html",
            document_id: htmlDoc.id,
            document_version_id: htmlVersion.id,
            filename: "human.html",
            media_type: "text/html",
          },
        ],
        attachments: [
          {
            id: "att-human-html",
            document_id: htmlDoc.id,
            document_version_id: htmlVersion.id,
            filename: "human.html",
            media_type: "text/html",
            size_bytes: 9,
            sha256: htmlVersion.sha256,
            available: true,
          },
        ],
        created_at: "2026-11-27T10:01:00Z",
      }),
    );

    expect(
      screen.queryByRole("complementary", { name: "Panel sidebar" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show sidebar" })).toBeVisible();
  });

  it("opens Agent editing from the Direct Room header avatar", async () => {
    await renderRoomSurface("room-dm-codex");
    const avatar = await screen.findByRole("button", {
      name: "Open Codex settings from avatar",
    });
    expect(
      within(avatar).getByRole("img", { name: "Codex avatar" }),
    ).toBeVisible();
    fireEvent.click(avatar);
    const sidebar = await screen.findByRole("complementary", {
      name: "Panel sidebar",
    });
    expect(
      within(sidebar).getByRole("tab", { name: "Agent · Codex" }),
    ).toBeVisible();
    expect(
      await within(sidebar).findByRole("button", {
        name: "Edit instructions",
      }),
    ).toBeVisible();
    // A second click on the header chip folds the panel away again.
    expect(avatar).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(avatar);
    await waitFor(() =>
      expect(avatar).toHaveAttribute("aria-expanded", "false"),
    );
  });

  it("defaults the Agent DM sidebar to Agent info and offers it beside Documents", async () => {
    await renderRoomSurface("room-dm-codex");
    fireEvent.click(
      await screen.findByRole("button", { name: "Show sidebar" }),
    );
    let sidebar = await screen.findByRole("complementary", {
      name: "Panel sidebar",
    });
    const infoTab = await within(sidebar).findByRole("tab", {
      name: "Agent · Codex",
    });
    expect(infoTab).toHaveAttribute("aria-selected", "true");
    expect(within(sidebar).getByLabelText("Agent info")).toBeVisible();
    fireEvent.click(
      within(sidebar).getByRole("button", { name: "Add panel view" }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Agent info" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("menuitem", { name: "Documents" }));
    fireEvent.click(
      within(sidebar).getByRole("button", { name: "Hide sidebar" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Show sidebar" }),
      ).toBeVisible(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
    sidebar = await screen.findByRole("complementary", {
      name: "Panel sidebar",
    });
    await waitFor(() =>
      expect(
        within(sidebar).getByRole("tab", { name: /^(Documents|Files)$/ }),
      ).toHaveAttribute("aria-selected", "true"),
    );
    // Closing every view exposes the same two destinations in the launcher.
    fireEvent.click(
      within(sidebar).getByRole("button", { name: "Close Agent · Codex" }),
    );
    fireEvent.click(
      await within(sidebar).findByRole("button", {
        name: /^Close (Documents|Files)$/,
      }),
    );
    fireEvent.click(
      await within(sidebar).findByRole("button", { name: "Agent info" }),
    );
    expect(await within(sidebar).findByLabelText("Agent info")).toBeVisible();
  });

  it.each(["online", "offline"] as const)(
    "hides runtime configuration when the Local Computer is %s",
    async (status) => {
      const runtime = surfaceRuntime();
      runtime.server.on("GET", "/v0/tenants/{tenantId}/agents", () => ({
        page: { has_more: false },
        items: runtime.seed.tenantAgents.map((item) =>
          item.actor.id === "actor-codex"
            ? {
                ...item,
                runtime: {
                  ...item.runtime,
                  placement: {
                    type: "local" as const,
                    computer_id: "computer-alex",
                    workspace_grant_id: "grant-alex",
                    runtime_type: "codex" as const,
                  },
                },
              }
            : item,
        ),
      }));
      const page = await readAgentAvailability(runtime);
      runtime.server.on(
        "GET",
        "/v0/tenants/{tenantId}/agent-availability",
        () => ({
          ...page,
          items: page.items.map((item) =>
            item.actor_id === "actor-codex"
              ? {
                  ...item,
                  local_runtime_status: {
                    computer_id: "computer-alex",
                    display_name: "Alex development computer",
                    computer_status: status,
                    runtime_type: "codex" as const,
                    status: "ready" as const,
                    version: "0.155.1",
                  },
                }
              : item,
          ),
        }),
      );
      await renderRoomSurface("room-all", "?profile=actor-codex", runtime);
      const profile = await screen.findByTestId(
        "panel-tab-agent-info",
        {},
        { timeout: 10_000 },
      );
      expect(
        within(profile).queryByRole("button", { name: "Runtime" }),
      ).toBeNull();
      expect(
        within(profile).getByRole("tab", { name: "Details" }),
      ).toBeVisible();
    },
  );

  async function busyCodexRuntime() {
    const runtime = surfaceRuntime();
    const page = await readAgentAvailability(runtime);
    runtime.server.on(
      "GET",
      "/v0/tenants/{tenantId}/agent-availability",
      () => ({
        ...page,
        items: page.items.map((item) =>
          item.actor_id === "actor-codex"
            ? {
                ...item,
                availability: { ...item.availability, active_task_count: 1 },
              }
            : item,
        ),
      }),
    );
    return runtime;
  }

  it("keeps the profile editable but locks the Runtime while the Agent works", async () => {
    await renderRoomSurface(
      "room-all",
      "?profile=actor-codex",
      await busyCodexRuntime(),
    );
    const profile = await screen.findByTestId("panel-tab-agent-info");
    expect(
      within(profile).queryByRole("button", { name: "Runtime" }),
    ).toBeNull();
    fireEvent.click(within(profile).getByRole("tab", { name: "Details" }));
    expect(
      within(profile).queryByText(/Name, instructions, and runtime/),
    ).toBeNull();
    fireEvent.click(
      within(profile).getByRole("button", { name: "Edit instructions" }),
    );
    const editor = screen.getByRole("dialog", { name: "Edit instructions" });
    expect(within(editor).getByLabelText("Agent instructions")).toBeEnabled();
  });

  it("opens editable Agent information in the existing Room sidebar", async () => {
    await renderRoomSurface("room-all", "?profile=actor-codex");

    const sidebar = await screen.findByRole("complementary", {
      name: "Panel sidebar",
    });
    const profile = await within(sidebar).findByTestId("panel-tab-agent-info");
    const room = screen.getByRole("region", { name: "Room all" });
    expect(
      within(sidebar).getByRole("tab", { name: "Agent · Codex" }),
    ).toBeVisible();
    expect(
      within(profile).queryByRole("button", { name: "Runtime" }),
    ).toBeNull();
    fireEvent.click(within(profile).getByRole("tab", { name: "Details" }));
    expect(profile).toHaveTextContent(
      "Coding Agent for repository analysis and implementation.",
    );
    expect(room).toHaveClass("min-w-0");
    expect(room).not.toHaveClass("min-w-[640px]");
    expect(
      screen.queryByRole("complementary", { name: "Codex profile" }),
    ).not.toBeInTheDocument();
    expect(within(profile).getByRole("tab", { name: "Details" })).toBeVisible();
    expect(within(profile).queryByRole("tab", { name: "Logs" })).toBeNull();
    fireEvent.click(within(profile).getByRole("tab", { name: "Connectors" }));
    expect(
      within(profile).queryByRole("button", { name: "Activity" }),
    ).toBeNull();
    fireEvent.click(within(profile).getByRole("tab", { name: "Details" }));
    expect(
      within(profile).getByRole("button", { name: "Edit instructions" }),
    ).toBeVisible();
    expect(within(profile).getByRole("tab", { name: "Details" })).toBeVisible();
    expect(
      within(profile).getByRole("button", { name: /Remove Agent/ }),
    ).toBeVisible();
    fireEvent.click(
      within(profile).getByRole("button", { name: "Edit instructions" }),
    );
    const editor = screen.getByRole("dialog", { name: "Edit instructions" });
    expect(editor).toBeVisible();
    expect(
      within(editor).queryByLabelText("Agent name"),
    ).not.toBeInTheDocument();
    expect(within(editor).getByLabelText("Agent instructions")).toBeVisible();
  });

  it("lets the Human rename their Another Me but not edit its instructions", async () => {
    await renderRoomSurface("room-all", "?profile=actor-delegate");

    const profile = await screen.findByTestId("panel-tab-agent-info");
    expect(
      within(profile).queryByRole("button", { name: "Edit instructions" }),
    ).not.toBeInTheDocument();
    fireEvent.click(within(profile).getByRole("button", { name: /Edit name/ }));
    const name = within(profile).getByRole("textbox", { name: "Agent name" });
    fireEvent.change(name, { target: { value: "Jenny's Twin" } });
    fireEvent.keyDown(name, { key: "Enter" });
    expect(
      await within(profile).findByRole("heading", { name: "Jenny's Twin" }),
    ).toBeVisible();
  });

  it("keeps the Figma Room open by default and opens the panel launcher on demand", async () => {
    await renderRoomSurface("room-all", "");

    expect(
      screen.queryByRole("complementary", { name: "Panel sidebar" }),
    ).not.toBeInTheDocument();
    // Room metadata resolves behind Suspense; this checks availability, not a 1s SLA.
    const chat = await screen.findByRole("region", { name: "Room all" });
    expect(chat).toHaveClass("flex", "min-w-0");
    expect(chat).not.toHaveClass("min-w-[640px]");
    expect(chat.parentElement).toHaveClass("min-w-0");
    expect(chat.parentElement).not.toHaveClass("min-w-[912px]");

    fireEvent.click(within(chat).getByRole("button", { name: "Show sidebar" }));
    const sidebar = await screen.findByRole("complementary", {
      name: "Panel sidebar",
    });
    expect(sidebar).not.toHaveTextContent("No views open");
    expect(
      within(sidebar).queryByRole("button", { name: "Agent info" }),
    ).toBeNull();
    expect(
      within(sidebar).getByRole("button", { name: "Documents" }),
    ).toBeVisible();
    expect(
      within(sidebar).queryByRole("button", { name: "Room info" }),
    ).not.toBeInTheDocument();
    expect(
      within(sidebar).getByRole("button", { name: "Add panel view" }),
    ).toBeVisible();
    expect(
      within(chat).queryByRole("button", { name: "Show sidebar" }),
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Room all" })).queryByRole(
        "button",
        { name: "Hide sidebar" },
      ),
    ).not.toBeInTheDocument();
    expect(chat).toHaveClass("flex", "min-w-0");
    expect(chat).not.toHaveClass("hidden");
    expect(chat.parentElement).toHaveClass("w-full", "min-w-0");
    // Clipped rather than hidden: a hidden box scrolls to reveal a focused
    // field in the parked panel, which snapped the panel open with no slide.
    expect(chat.parentElement?.parentElement).toHaveClass(
      "min-w-0",
      "overflow-clip",
    );
    expect(chat.parentElement?.parentElement).toHaveAttribute(
      "data-detail-open",
      "true",
    );

    fireEvent.click(
      within(sidebar).getByRole("button", { name: "Hide sidebar" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", { name: "Panel sidebar" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("restores focus after a Room trigger replaces the default launcher", async () => {
    await renderRoomSurface("room-all", "", surfaceRuntime(), <RoomChat />);

    const message = (await screen.findAllByRole("article")).find((article) =>
      article.textContent?.includes("Keep the first release focused"),
    );
    expect(message).toBeDefined();
    const trigger = within(message!).getByRole("button", {
      name: "More message actions",
    });
    trigger.focus();
    fireEvent.click(trigger);
    const item = screen.getByRole("menuitem", { name: "Reply to thread" });
    item.focus();
    fireEvent.click(item);

    const sidebar = await screen.findByRole("complementary", {
      name: "Panel sidebar",
    });
    // The user chose to write, so the ready Thread composer takes focus.
    await waitFor(() =>
      expect(within(sidebar).getByLabelText("Reply in Thread")).toHaveFocus(),
    );
    fireEvent.click(
      within(sidebar).getByRole("button", { name: "Hide sidebar" }),
    );

    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("opens Documents from the launcher even without a focused file", async () => {
    await renderRoomSurface("room-all", "");

    const sidebar = await openPanelLauncher();
    fireEvent.click(within(sidebar).getByRole("button", { name: "Documents" }));
    expect(
      await within(sidebar).findByTestId("panel-tab-file-library"),
    ).toBeVisible();
  });

  it("resolves a panel root from an older Message page", async () => {
    const runtime = await authenticatedFixtureRuntime();
    const allMessages = await teamHubData(
      runtime.client.api.GET("/v0/rooms/{roomId}/messages", {
        params: { path: { roomId: "room-all" } },
      }),
    );
    let olderAttempts = 0;
    const listMessages = vi.fn(({ query }: TestRouteRequest) => {
      if (query.get("cursor") === "older") {
        olderAttempts += 1;
        if (olderAttempts === 1) {
          throw new Error("Older history is temporarily unavailable.");
        }
        return {
          items: [allMessages.items[1]!],
          page: { has_more: false },
          snapshot_room_seq: allMessages.snapshot_room_seq,
        };
      }
      return {
        items: [allMessages.items.at(-1)!],
        page: { has_more: true, next_cursor: "older" },
        snapshot_room_seq: allMessages.snapshot_room_seq,
      };
    });
    runtime.server.on("GET", "/v0/rooms/{roomId}/messages", listMessages);

    seedPanelTabs({
      openMessageIds: ["message-2"],
      activeMessageId: "message-2",
    });
    await renderRoomSurface("room-all", "", runtime);

    const sidebar = await openPanelLauncher();
    await within(sidebar).findByText("Task could not be loaded");
    fireEvent.click(within(sidebar).getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(
        screen.getByRole("complementary", { name: "Panel sidebar" }),
      ).toHaveTextContent("Reviewed the checklist"),
    );
    expect(olderAttempts).toBeGreaterThanOrEqual(2);
    expect(
      listMessages.mock.calls.some(
        ([request]) =>
          request.params.roomId === "room-all" &&
          request.query.get("cursor") === "older",
      ),
    ).toBe(true);
  });

  it("resolves a valid panel when the Profile URL is invalid", async () => {
    seedPanelTabs({
      openMessageIds: ["message-2"],
      activeMessageId: "message-2",
    });
    await renderRoomSurface("room-all", "?profile=actor-missing");

    const sidebar = await openPanelLauncher();
    expect(sidebar).toHaveTextContent("Reviewed the checklist");
  });

  it("keeps an unknown panel message recoverable instead of blanking the Room", async () => {
    seedPanelTabs({
      openMessageIds: ["message-missing"],
      activeMessageId: "message-missing",
    });
    const router = await renderRoomSurface("room-all");

    const sidebar = await openPanelLauncher();
    expect(sidebar).toHaveTextContent("This message no longer exists");
    expect(
      within(sidebar).getByRole("tablist", { name: "Panel tabs" }),
    ).toBeVisible();
    fireEvent.click(
      within(sidebar).getByRole("button", { name: "Close message-missing" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("complementary", { name: "Panel sidebar" }),
      ).toHaveTextContent("Documents"),
    );
    expect(router.state.location.search).toBe("");
  });

  it("keeps panel tabs mounted when the active message is missing and can switch", async () => {
    seedPanelTabs({
      openMessageIds: ["message-2", "message-missing"],
      activeMessageId: "message-missing",
    });
    await renderRoomSurface("room-all");

    const sidebar = await openPanelLauncher();
    const tablist = within(sidebar).getByRole("tablist", {
      name: "Panel tabs",
    });
    expect(
      within(tablist).getByRole("tab", { name: /Reviewed/ }),
    ).toBeVisible();
    expect(
      within(tablist).getByRole("tab", { name: "message-missing" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(sidebar).toHaveTextContent("This message no longer exists");

    fireEvent.click(within(tablist).getByRole("tab", { name: /Reviewed/ }));
    await waitFor(() =>
      expect(sidebar).toHaveTextContent("Reviewed the checklist"),
    );
    expect(
      within(sidebar).getByRole("tablist", { name: "Panel tabs" }),
    ).toBeVisible();
  });

  it("stays open on a neighbor when closing a missing-message tab", async () => {
    seedPanelTabs({
      openMessageIds: ["message-2", "message-missing"],
      activeMessageId: "message-missing",
    });
    await renderRoomSurface("room-all");

    const sidebar = await openPanelLauncher();
    fireEvent.click(
      within(sidebar).getByRole("button", { name: "Close message-missing" }),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("complementary", { name: "Panel sidebar" }),
      ).toHaveTextContent("Reviewed the checklist"),
    );
  });

  it("shows a Room Run's status only in the Room composer while a Thread is open", async () => {
    await renderRoomSurface("room-all", "", surfaceRuntime(), <RoomChat />);

    const message = (await screen.findAllByRole("article")).find((article) =>
      article.textContent?.includes("Keep the first release focused"),
    );
    fireEvent.click(
      within(message!).getByRole("button", { name: "More message actions" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Reply to thread" }));
    const sidebar = await screen.findByRole("complementary", {
      name: "Panel sidebar",
    });
    await waitFor(() =>
      expect(within(sidebar).getByLabelText("Reply in Thread")).toBeEnabled(),
    );
    const dock = await screen.findByTestId("agent-streaming-status-dock");
    // room-all has an active Run and the Thread has none: the Thread
    // composer shows no status, and the Room's is not repeated there.
    expect(screen.getAllByTestId("agent-streaming-status-dock")).toHaveLength(
      1,
    );
    expect(sidebar).not.toContainElement(dock);
  });

  it("keeps a newly sent structured Mention interactive inside its Thread panel", async () => {
    const runtime = await authenticatedFixtureRuntime();
    const router = await renderRoomSurface(
      "room-all",
      "",
      runtime,
      <RoomChat />,
    );
    const composer = await screen.findByLabelText("Message Room");

    fireEvent.change(composer, { target: { value: "@Cod" } });
    fireEvent.click(screen.getByRole("option", { name: /Codex/ }));
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(screen.queryByText("Sending...")).not.toBeInTheDocument(),
    );
    const mention = screen.getByRole("button", { name: "@Codex" });
    const message = mention.closest("article")!;
    fireEvent.click(
      within(message).getByRole("button", { name: "More message actions" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Reply to thread" }));
    const sidebar = await screen.findByRole("complementary", {
      name: "Panel sidebar",
    });
    fireEvent.click(within(sidebar).getByRole("button", { name: "@Codex" }));

    await waitFor(() =>
      expect(
        within(sidebar).getByRole("tab", { name: "Agent · Codex" }),
      ).toBeVisible(),
    );
    expect(router.state.location.search).toBe("");
  });

  it("opens chat activity in a separate Activity tab", async () => {
    const runtime = await authenticatedFixtureRuntime();
    const router = await renderRoomSurface(
      "room-all",
      "",
      runtime,
      <RoomChat />,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open Agents working activity",
      }),
    );
    const sidebar = await screen.findByRole("complementary", {
      name: "Panel sidebar",
    });
    expect(
      await within(sidebar).findByRole("tab", {
        name: /Activity · Codex/,
      }),
    ).toBeVisible();
    expect(
      within(sidebar).getByRole("heading", { name: "Codex activity" }),
    ).toBeVisible();
    fireEvent.click(
      within(sidebar).getByRole("button", { name: "Back to Activity" }),
    );
    expect(
      (
        await within(sidebar).findAllByRole("button", {
          name: /View Codex activity/,
        })
      ).length,
    ).toBeGreaterThan(0);
    expect(router.state.location.search).toBe("");
    expect(
      screen.queryByRole("complementary", { name: "Codex profile" }),
    ).not.toBeInTheDocument();
  });

  it("opens Agent selection from Room membership in the sidebar", async () => {
    const runtime = surfaceRuntime();
    let releaseActors!: () => void;
    const actorsReady = new Promise<void>((resolve) => {
      releaseActors = resolve;
    });
    runtime.server.on("GET", "/v0/tenants/{tenantId}/actors", async () => {
      await actorsReady;
      return { items: runtime.seed.actors, page: { has_more: false } };
    });
    await renderRoomSurface("room-all", "", runtime);

    fireEvent.click(
      await screen.findByRole("button", { name: /settings from avatar$/ }),
    );
    // The header is ready before the Actors needed by the members section.
    expect(
      screen.queryByRole("region", { name: "Room members" }),
    ).not.toBeInTheDocument();
    releaseActors();
    await screen.findByTestId("panel-room-settings");
    const members = await screen.findByRole("region", { name: "Room members" });
    expect(members).toBeVisible();
    expect(
      within(members).getByRole("button", { name: "Remove Codex" }),
    ).toBeVisible();

    fireEvent.click(
      within(members).getByRole("button", { name: "Open Codex profile" }),
    );
    const sidebar = await screen.findByRole("complementary", {
      name: "Panel sidebar",
    });
    expect(
      within(sidebar).getByRole("tab", { name: "Agent · Codex" }),
    ).toBeVisible();
  });

  it("offers the Figma launcher destinations without a New Thread command", async () => {
    await renderRoomSurface("room-all", "");

    const sidebar = await openPanelLauncher();

    expect(
      within(sidebar).queryByRole("button", { name: "Thread" }),
    ).not.toBeInTheDocument();
    expect(
      within(sidebar).getByRole("button", { name: "Documents" }),
    ).toBeVisible();
    expect(
      within(sidebar).queryByRole("button", { name: "Room info" }),
    ).not.toBeInTheDocument();
  });

  it("opens Documents as a folder browser instead of a picker dialog", async () => {
    await renderRoomSurface("room-all", "");

    const sidebar = await openPanelLauncher();
    fireEvent.click(within(sidebar).getByRole("button", { name: "Documents" }));

    expect(
      await within(sidebar).findByTestId("panel-tab-file-library"),
    ).toBeVisible();
    expect(
      screen.queryByRole("dialog", { name: "Choose a file" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      within(sidebar).getByRole("button", {
        name: "top-level-architecture.svg",
      }),
    );
    expect(
      within(sidebar).queryByRole("button", { name: "All files" }),
    ).not.toBeInTheDocument();
    expect(
      await within(sidebar).findByRole("tab", {
        name: /top-level-architecture.svg/,
      }),
    ).toBeVisible();
    expect(within(sidebar).getByRole("tab", { name: /Files/ })).toBeVisible();
  });
});

async function openPanelLauncher() {
  const room = await screen.findByRole("region", { name: "Room all" });
  fireEvent.click(within(room).getByRole("button", { name: "Show sidebar" }));
  return screen.findByRole("complementary", { name: "Panel sidebar" });
}

function seedPanelTabs({
  activeMessageId,
  openMessageIds,
  roomId = "room-all",
}: {
  activeMessageId: string;
  openMessageIds: string[];
  roomId?: string;
}) {
  const scope = {
    accountId: "account-jenny",
    roomId,
    tenantId: "tenant-northstar",
  };
  for (const id of openMessageIds) {
    openPanelTab(scope, {
      kind: "thread",
      anchorMessageId: id,
      title:
        id === "message-2" ? "Reviewed the checklist. The remaining..." : id,
    });
  }
  setActivePanelTab(
    scope,
    panelTabKey("thread", { anchorMessageId: activeMessageId }),
  );
}

async function renderRoomSurface(
  roomId = "room-all",
  search = "",
  runtime: TeamHubRuntime = surfaceRuntime(),
  roomElement = <div />,
) {
  const router = createMemoryRouter(
    [
      {
        element: <Outlet />,
        path: "/t/:tenantId",
        children: [
          // Deleting a Room navigates here. Without the destination the
          // surface stayed mounted over a Room the runtime had already
          // removed and re-read it, which surfaced as an unhandled
          // "Room is unavailable" under the default ErrorBoundary.
          { element: <div>Rooms</div>, path: "rooms" },
          {
            element: <RoomSurface />,
            path: "rooms/:roomId",
            children: [
              { element: roomElement, path: "chat" },
              { element: roomElement, path: "files" },
            ],
          },
        ],
      },
    ],
    { initialEntries: [`/t/tenant-northstar/rooms/${roomId}/chat${search}`] },
  );

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // Loading what RoomSurface suspends on before rendering skips React's
  // Suspense reveal throttle, which otherwise costs every test a fixed delay.
  // A failed load stays in the cache so RoomSurface surfaces it as before.
  const tenantId = "tenant-northstar";
  await Promise.all([
    queryClient.ensureQueryData(
      roomQueryOptions(runtime.client, tenantId, roomId),
    ),
    queryClient.ensureQueryData(
      roomMembersQueryOptions(runtime.client, tenantId, roomId),
    ),
    queryClient.ensureInfiniteQueryData(
      roomMessagesInfiniteQueryOptions(runtime.client, tenantId, roomId),
    ),
    queryClient.ensureQueryData(teamHubIdentityQueryOptions(runtime.client)),
  ]).catch(() => undefined);
  // The panel sidebar also suspends on these. They are not awaited so a test
  // that holds one back still sees the sidebar's loading state.
  void queryClient.prefetchQuery(
    tenantActorsQueryOptions(runtime.client, tenantId),
  );
  void queryClient.prefetchQuery(
    roomDocumentsQueryOptions(runtime.client, tenantId, roomId),
  );

  render(
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <RouterProvider router={router} />
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );

  return router;
}

async function authenticatedFixtureRuntime() {
  const runtime = surfaceRuntime();

  return runtime;
}

function readAgentAvailability(runtime: TestTeamHubRuntime) {
  return teamHubData(
    runtime.client.api.GET("/v0/tenants/{tenantId}/agent-availability", {
      params: { path: { tenantId: "tenant-northstar" } },
    }),
  );
}

function surfaceRuntime() {
  const runtime = createTestTeamHubRuntime();
  acceptRoomMessages(runtime);
  acceptTenantAgentUpdates(runtime);
  return runtime;
}
