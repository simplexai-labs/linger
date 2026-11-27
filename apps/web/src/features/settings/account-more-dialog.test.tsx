import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";

import { AccountMoreDialog } from "./account-more-dialog";

describe("AccountMoreDialog", () => {
  afterEach(() => {
    delete (window as { lingerDesktop?: unknown }).lingerDesktop;
    vi.restoreAllMocks();
  });

  it("offers Continue for an open pending connection in browser mode", async () => {
    const runtime = createTestTeamHubRuntime();
    const template = (await runtime.client.listExternalConnections())
      .connections[0]!;
    const pending = {
      ...template,
      connect_expires_at: "2999-01-01T00:00:00Z",
      connect_url: undefined,
      id: "external-connection-notion-pending",
      identity_label: undefined,
      provider: "notion" as const,
      status: "pending" as const,
    };
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [pending],
    });
    vi.spyOn(runtime.client, "getExternalConnection").mockResolvedValue({
      ...pending,
      connect_url: "https://connect.example.test/notion-pending",
    });
    const create = vi.spyOn(runtime.client, "createExternalConnection");
    const open = vi.spyOn(window, "open").mockReturnValue({
      close: vi.fn(),
      opener: window,
    } as unknown as Window);

    renderDialog(runtime, { startWith: "notion" });

    const dialog = await screen.findByRole("dialog", {
      name: "Add profile sources",
    });
    const continueButton = await within(dialog).findByRole("button", {
      name: "Continue Notion authorization",
    });
    expect(create).not.toHaveBeenCalled();

    fireEvent.click(continueButton);
    expect(open).toHaveBeenCalledWith(
      "https://connect.example.test/notion-pending",
      "linger_composio_oauth",
      expect.any(String),
    );
  });

  it("ignores a stale pending connection in desktop mode and creates a fresh one on Choose", async () => {
    installDesktopOAuth();
    const runtime = createTestTeamHubRuntime();
    const template = (await runtime.client.listExternalConnections())
      .connections[0]!;
    const pending = {
      ...template,
      connect_expires_at: "2999-01-01T00:00:00Z",
      connect_url: "https://connect.example.test/stale-notion",
      id: "external-connection-notion-pending",
      identity_label: undefined,
      provider: "notion" as const,
      status: "pending" as const,
    };
    const fresh = {
      ...pending,
      id: "external-connection-notion-fresh",
      connect_url: "https://connect.example.test/fresh-notion",
    };
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [pending],
    });
    const getConnection = vi.spyOn(runtime.client, "getExternalConnection");
    const create = vi
      .spyOn(runtime.client, "createExternalConnection")
      .mockResolvedValue(fresh);
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    renderDialog(runtime);

    const dialog = await screen.findByRole("dialog", {
      name: "Add profile sources",
    });
    const chooseButton = await within(dialog).findByRole("button", {
      name: "Choose Notion",
    });
    expect(
      within(dialog).queryByRole("button", {
        name: "Continue Notion authorization",
      }),
    ).toBeNull();
    expect(getConnection).not.toHaveBeenCalled();

    fireEvent.click(chooseButton);
    await waitFor(() => expect(create).toHaveBeenCalledWith("notion"));
    expect(open).toHaveBeenCalledWith(
      "https://connect.example.test/fresh-notion",
      "linger_composio_oauth",
      expect.any(String),
    );
  });

  it("starts a fresh connection on startWith in desktop mode even when a pending connection exists", async () => {
    installDesktopOAuth();
    const runtime = createTestTeamHubRuntime();
    const template = (await runtime.client.listExternalConnections())
      .connections[0]!;
    const pending = {
      ...template,
      connect_expires_at: "2999-01-01T00:00:00Z",
      connect_url: "https://connect.example.test/stale-gmail",
      id: "external-connection-gmail-pending",
      identity_label: undefined,
      provider: "gmail" as const,
      status: "pending" as const,
    };
    const fresh = {
      ...pending,
      id: "external-connection-gmail-fresh",
      connect_url: "https://connect.example.test/fresh-gmail",
    };
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [pending],
    });
    const create = vi
      .spyOn(runtime.client, "createExternalConnection")
      .mockResolvedValue(fresh);
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    renderDialog(runtime, { startWith: "gmail" });

    await waitFor(() => expect(create).toHaveBeenCalledWith("gmail"));
    expect(open).toHaveBeenCalledWith(
      "https://connect.example.test/fresh-gmail",
      "linger_composio_oauth",
      expect.any(String),
    );
  });
});

function installDesktopOAuth() {
  (
    window as {
      lingerDesktop?: {
        connectorOAuth?: {
          prepare: () => Promise<string>;
          onReturn: () => () => void;
        };
      };
    }
  ).lingerDesktop = {
    connectorOAuth: {
      prepare: vi
        .fn()
        .mockResolvedValue(
          "http://127.0.0.1:43210/oauth/connector/" + "d".repeat(48),
        ),
      onReturn: vi.fn(() => () => {}),
    },
  };
}

function renderDialog(
  runtime: ReturnType<typeof createTestTeamHubRuntime>,
  { startWith }: { startWith?: string } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <AccountMoreDialog
            client={runtime.client}
            onClose={vi.fn()}
            startWith={startWith}
            tenantId="tenant_one"
          />
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}
