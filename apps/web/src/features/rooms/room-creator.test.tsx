import { onlineManager, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "@/app/query-client";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { defineGlobalProperty } from "@/test/global-properties";
import {
  acceptRoomCreation,
  acceptRoomMembers,
  createTestTeamHubRuntime,
  type TestTeamHubRuntime,
} from "@/test/teamhub-test-runtime";
import {
  teamHubErrorResponse,
  TeamHubTestServer,
  type TestRouteHandler,
} from "@/test/teamhub-test-server";

import { RoomAddMembersDialog } from "./members/room-add-members-dialog";
import { RoomCreator } from "./room-creator";

describe("Room creation", () => {
  beforeEach(() => {
    defineGlobalProperty(HTMLElement.prototype, "showPopover", {
      configurable: true,
      value: function (this: HTMLElement) {
        this.style.display = "flex";
      },
    });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => {
    onlineManager.setOnline(true);
    vi.unstubAllGlobals();
  });

  it("creates a New Room right away and opens it for adding members", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomCreation(runtime);
    const onClose = vi.fn();

    renderCreator(runtime, onClose);

    expect(
      await screen.findByText("New Room room-created-1 opened"),
    ).toBeVisible();
    expect(onClose).toHaveBeenCalledOnce();
    expect(await postedNames(runtime)).toEqual(["New Room"]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("moves to the next numbered name when the default name is taken", async () => {
    const runtime = createTestTeamHubRuntime();
    const rooms = new TeamHubTestServer();
    acceptRoomCreation({ ...runtime, server: rooms });
    runtime.server.on(
      "POST",
      "/v0/tenants/{tenantId}/rooms",
      ({ body, request }) =>
        (body as { name: string }).name === "New Room"
          ? teamHubErrorResponse(409, "ROOM_NAME_TAKEN")
          : rooms.fetch(request),
    );

    renderCreator(runtime);

    expect(
      await screen.findByText("New Room room-created-1 opened"),
    ).toBeVisible();
    expect(await postedNames(runtime)).toEqual(["New Room", "New Room 2"]);
  });

  it("retries the same name after an unconfirmed failure and treats it taken as created", async () => {
    const runtime = createTestTeamHubRuntime();
    const createRoom = vi
      .fn<TestRouteHandler>()
      .mockImplementationOnce(() => {
        throw new Error("Connection closed before confirmation.");
      })
      .mockImplementationOnce(() =>
        teamHubErrorResponse(409, "ROOM_NAME_TAKEN"),
      );
    runtime.server.on("POST", "/v0/tenants/{tenantId}/rooms", createRoom);
    const onClose = vi.fn();

    renderCreator(runtime, onClose);

    const dialog = await screen.findByRole("dialog", {
      name: "Couldn't create the Room",
    });
    expect(
      within(dialog).getByText(/did not confirm whether this Room was created/),
    ).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(await postedNames(runtime)).toEqual(["New Room", "New Room"]);
    expect(screen.queryByText(/ opened$/)).toBeNull();
  });

  it("treats a gateway error as unconfirmed, so a taken retry makes no second Room", async () => {
    const runtime = createTestTeamHubRuntime();
    const createRoom = vi
      .fn<TestRouteHandler>()
      .mockImplementationOnce(() => new Response(null, { status: 504 }))
      .mockImplementationOnce(() =>
        teamHubErrorResponse(409, "ROOM_NAME_TAKEN"),
      );
    runtime.server.on("POST", "/v0/tenants/{tenantId}/rooms", createRoom);
    const onClose = vi.fn();

    renderCreator(runtime, onClose);

    const dialog = await screen.findByRole("dialog", {
      name: "Couldn't create the Room",
    });
    expect(
      within(dialog).getByText(/did not confirm whether this Room was created/),
    ).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(await postedNames(runtime)).toEqual(["New Room", "New Room"]);
  });

  it("shows a definite TeamHub error and tries again on Retry", async () => {
    const runtime = createTestTeamHubRuntime();
    const rooms = new TeamHubTestServer();
    acceptRoomCreation({ ...runtime, server: rooms });
    const createRoom = vi
      .fn<TestRouteHandler>(({ request }) => rooms.fetch(request))
      .mockImplementationOnce(() =>
        teamHubErrorResponse(
          403,
          "FORBIDDEN",
          "You cannot create Rooms in this Tenant.",
        ),
      );
    runtime.server.on("POST", "/v0/tenants/{tenantId}/rooms", createRoom);
    const onClose = vi.fn();

    renderCreator(runtime, onClose);

    const dialog = await screen.findByRole("dialog", {
      name: "Couldn't create the Room",
    });
    expect(
      within(dialog).getByText("You cannot create Rooms in this Tenant."),
    ).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));

    expect(
      await screen.findByText("New Room room-created-1 opened"),
    ).toBeVisible();
    expect(onClose).toHaveBeenCalledOnce();
    expect(await postedNames(runtime)).toEqual(["New Room", "New Room"]);
  });

  it("adds Humans and Agents in a separate dialog after the Room already exists", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomCreation(runtime);
    acceptRoomMembers(runtime);

    const room = await createRoom(runtime, "Team launch");
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={createAppQueryClient()}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <MemoryRouter>
            <RoomAddMembersDialog
              onClose={onClose}
              roomId={room.id}
              tenantId="tenant-northstar"
            />
          </MemoryRouter>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Choose existing members" }),
    );
    const picker = screen.getByRole("dialog", { name: "Choose members" });
    fireEvent.change(screen.getByLabelText("Search members"), {
      target: { value: "Maya" },
    });
    fireEvent.click(
      await within(picker).findByRole("button", { name: /Maya Chen/ }),
    );
    fireEvent.change(screen.getByLabelText("Search members"), {
      target: { value: "Codex" },
    });
    fireEvent.click(
      await within(picker).findByRole("button", { name: /Codex/ }),
    );
    fireEvent.keyDown(screen.getByLabelText("Search members"), {
      key: "Escape",
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Choose existing members" }),
    ).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Remove Maya Chen" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Choose existing members" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Maya Chen avatar/ }),
    );
    fireEvent.keyDown(screen.getByLabelText("Search members"), {
      key: "Escape",
    });
    fireEvent.click(screen.getByRole("button", { name: "Add members" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    const members = await listRoomMembers(runtime, room.id);
    expect(members.items.map((member) => member.actor.display_name)).toEqual(
      expect.arrayContaining(["Maya Chen", "Codex"]),
    );
  });

  it("keeps successful additions and retries only failed members", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomCreation(runtime);
    acceptRoomMembers(runtime);

    const room = await createRoom(runtime, "Retry members");
    const members = new TeamHubTestServer();
    acceptRoomMembers({ ...runtime, server: members });
    let attempts = 0;
    runtime.server.on(
      "PUT",
      "/v0/rooms/{roomId}/members/{actorId}",
      ({ request }) => {
        attempts += 1;
        return attempts === 2
          ? Promise.reject(new Error("Temporary failure"))
          : members.fetch(request);
      },
    );
    const putActorIds = () =>
      runtime.server
        .requestsTo("PUT", "/v0/rooms/{roomId}/members/{actorId}")
        .map((request) => new URL(request.url).pathname.split("/").at(-1));
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={createAppQueryClient()}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <MemoryRouter>
            <RoomAddMembersDialog
              roomId={room.id}
              tenantId="tenant-northstar"
              onClose={onClose}
            />
          </MemoryRouter>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Choose existing members" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Maya Chen avatar/ }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Codex avatar/ }),
    );
    fireEvent.keyDown(screen.getByLabelText("Search members"), {
      key: "Escape",
    });
    fireEvent.click(screen.getByRole("button", { name: "Add members" }));
    await screen.findByRole("alert");
    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Remove Maya Chen" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Remove Codex" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Add members" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(putActorIds()).toHaveLength(3);
    expect(putActorIds()[2]).toBe(putActorIds()[1]);
    expect(
      (await listRoomMembers(runtime, room.id)).items.map(
        (item) => item.actor.display_name,
      ),
    ).toEqual(expect.arrayContaining(["Maya Chen", "Codex"]));
  });

  it("closes the second step directly without a skip confirmation", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomCreation(runtime);
    acceptRoomMembers(runtime);

    const room = await createRoom(runtime, "Skip confirmation");
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={createAppQueryClient()}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <MemoryRouter>
            <RoomAddMembersDialog
              onClose={onClose}
              roomId={room.id}
              tenantId="tenant-northstar"
            />
          </MemoryRouter>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Choose existing members" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Maya Chen avatar/ }),
    );
    fireEvent.keyDown(screen.getByLabelText("Search members"), {
      key: "Escape",
    });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect((await getRoom(runtime, room.id)).name).toBe("Skip confirmation");
  });

  it("allows skipping members without removing the created Room", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomCreation(runtime);
    acceptRoomMembers(runtime);

    const room = await createRoom(runtime, "Skip members");
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={createAppQueryClient()}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <MemoryRouter>
            <RoomAddMembersDialog
              onClose={onClose}
              roomId={room.id}
              tenantId="tenant-northstar"
            />
          </MemoryRouter>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );
    // Closing with nothing queued confirms first, so the Room owner sees where
    // members can be added later.
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(
      await screen.findByRole("button", { name: "Skip for now" }),
    );
    expect(onClose).toHaveBeenCalledOnce();
    expect(
      runtime.server.requestsTo("PUT", "/v0/rooms/{roomId}/members/{actorId}"),
    ).toHaveLength(0);
    expect((await getRoom(runtime, room.id)).name).toBe("Skip members");
  });

  it("attempts Room creation when the browser connectivity hint is offline", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomCreation(runtime);
    onlineManager.setOnline(false);

    renderCreator(runtime);

    expect(
      await screen.findByText("New Room room-created-1 opened"),
    ).toBeVisible();
    expect(await postedNames(runtime)).toEqual(["New Room"]);
  });

  it("rejects a created Room outside the active Tenant before navigation", async () => {
    const runtime = createTestTeamHubRuntime();
    const existingRoom = await getRoom(runtime, "room-all");
    runtime.server.on("POST", "/v0/tenants/{tenantId}/rooms", () => ({
      ...existingRoom,
      id: "room-foreign",
      tenant_id: "tenant-foreign",
    }));
    const onClose = vi.fn();

    renderCreator(runtime, onClose);

    await expect(
      screen.findByText("The requested TeamHub resource is unavailable."),
    ).resolves.toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText(/ opened$/)).toBeNull();
  });
});

function renderCreator(runtime: TestTeamHubRuntime, onClose = vi.fn()) {
  render(
    <QueryClientProvider client={createAppQueryClient()}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter>
          <Routes>
            <Route
              path="/"
              element={
                <RoomCreator onClose={onClose} tenantId="tenant-northstar" />
              }
            />
            <Route
              path="/t/:tenantId/rooms/:roomId/chat"
              element={<OpenedRoomProbe />}
            />
          </Routes>
        </MemoryRouter>
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
}

/** Stands in for the Room shell, which opens add-members from `newRoomId`. */
function OpenedRoomProbe() {
  const location = useLocation();
  const state = location.state as { newRoomId?: string } | null;
  return <p>New Room {state?.newRoomId} opened</p>;
}

function postedNames(runtime: TestTeamHubRuntime) {
  return Promise.all(
    runtime.server
      .requestsTo("POST", "/v0/tenants/{tenantId}/rooms")
      .map(
        async (request) => ((await request.json()) as { name: string }).name,
      ),
  );
}

function createRoom(runtime: TestTeamHubRuntime, name: string) {
  return teamHubData(
    runtime.client.api.POST("/v0/tenants/{tenantId}/rooms", {
      params: { path: { tenantId: "tenant-northstar" } },
      body: { name },
    }),
  );
}

function getRoom(runtime: TestTeamHubRuntime, roomId: string) {
  return teamHubData(
    runtime.client.api.GET("/v0/rooms/{roomId}", {
      params: { path: { roomId } },
    }),
  );
}

function listRoomMembers(runtime: TestTeamHubRuntime, roomId: string) {
  return teamHubData(
    runtime.client.api.GET("/v0/rooms/{roomId}/members", {
      params: { path: { roomId } },
    }),
  );
}
