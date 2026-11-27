import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TeamHubError } from "@/features/teamhub/teamhub-client";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubExternalApp } from "@/features/teamhub/teamhub-types";
import {
  createTestTeamHubRuntime,
  type TestTeamHubRuntime,
} from "@/test/teamhub-test-runtime";

import { ConnectAppStatus, useConnectAppFlow } from "./connect-app-flow";

function ConnectFlowHarness({ app }: { app: TeamHubExternalApp }) {
  const flow = useConnectAppFlow();
  return (
    <div>
      <button
        disabled={!flow.canStart(app)}
        onClick={() => flow.start(app)}
        type="button"
      >
        Start connect
      </button>
      <ConnectAppStatus flow={flow} />
    </div>
  );
}

describe("ConnectAppStatus", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows the minimalist Option A Composio key form with inline link, helper, toggle, and Cancel", async () => {
    const { app, runtime } = await setupRuntime({
      canSave: true,
      configured: false,
    });
    mount(runtime, app);

    const startButton = screen.getByRole("button", { name: "Start connect" });
    await waitFor(() => expect(startButton).toBeEnabled());
    fireEvent.click(startButton);

    const dialog = await screen.findByRole("dialog", { name: "Connect Gmail" });
    expect(dialog).toHaveClass("app-dialog-standard");
    expect(dialog).toHaveAttribute("data-size", "sm");
    expect(dialog.querySelector(".app-dialog-description")).toBeNull();
    expect(dialog.querySelector("ol")).toBeNull();
    expect(dialog.querySelector("strong")).toBeNull();
    expect(dialog).not.toHaveTextContent("Get your API key");
    expect(
      within(dialog).getByRole("link", { name: "Get a key" }),
    ).toHaveAttribute(
      "href",
      "https://dashboard.composio.dev/~/project/settings/api-keys",
    );
    // Focus on open is covered with showModal below; jsdom has none.
    const input = within(dialog).getByLabelText("Composio API key");
    expect(input).toHaveAttribute("data-autofocus");
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("placeholder", "Paste your API key");
    expect(input).toHaveAccessibleDescription(
      "Select Read All and Write All when creating your key.",
    );

    const toggle = within(dialog).getByRole("button", { name: "Show API key" });
    fireEvent.click(toggle);
    expect(input).toHaveAttribute("type", "text");
    expect(
      within(dialog).getByRole("button", { name: "Hide API key" }),
    ).toBeVisible();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Hide API key" }),
    );
    expect(input).toHaveAttribute("type", "password");

    expect(
      within(dialog).getByRole("button", { name: "Save key" }),
    ).toBeDisabled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("focuses the key input instead of the Get a key link when showModal opens the dialog", async () => {
    const originalShowModal = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function showModal(
      this: HTMLDialogElement,
    ) {
      this.open = true;
      this.querySelector<HTMLElement>("button, input")?.focus();
    };
    try {
      const { app, runtime } = await setupRuntime({
        canSave: true,
        configured: false,
      });
      mount(runtime, app);

      const startButton = screen.getByRole("button", { name: "Start connect" });
      await waitFor(() => expect(startButton).toBeEnabled());
      fireEvent.click(startButton);

      const dialog = await screen.findByRole("dialog", {
        name: "Connect Gmail",
      });
      const input = within(dialog).getByLabelText("Composio API key");
      await waitFor(() => expect(input).toHaveFocus());
    } finally {
      HTMLDialogElement.prototype.showModal = originalShowModal;
    }
  });

  it("clears a previous save error as soon as the user edits the key", async () => {
    const { app, runtime } = await setupRuntime({
      canSave: true,
      configured: false,
    });
    vi.spyOn(runtime.client, "saveExternalProviderKey").mockRejectedValueOnce(
      new Error("Invalid Composio key."),
    );
    mount(runtime, app);

    const startButton = screen.getByRole("button", { name: "Start connect" });
    await waitFor(() => expect(startButton).toBeEnabled());
    fireEvent.click(startButton);

    const dialog = await screen.findByRole("dialog", { name: "Connect Gmail" });
    const input = within(dialog).getByLabelText("Composio API key");
    fireEvent.change(input, { target: { value: "ck_bad" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save key" }));

    expect(
      await within(dialog).findByText("Invalid Composio key."),
    ).toBeVisible();
    expect(input).toHaveAttribute("aria-invalid", "true");

    fireEvent.change(input, { target: { value: "ck_bad2" } });
    expect(within(dialog).queryByText("Invalid Composio key.")).toBeNull();
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("renders a compact single-row confirmation dialog after saving the key and connects on click", async () => {
    const { app, listApps, runtime } = await setupRuntime({
      canSave: true,
      configured: false,
    });
    runtime.server.on("PUT", "/v0/external-apps/provider-key", () => ({
      can_save: true,
      source: "stored",
    }));
    const pending = {
      ...(await runtime.client.listExternalConnections()).connections[0]!,
      connect_url: "https://connect.example.test/gmail",
      provider: "gmail" as const,
      status: "pending" as const,
    };
    const createConnection = vi
      .spyOn(runtime.client, "createExternalConnection")
      .mockResolvedValue(pending);
    vi.spyOn(window, "open").mockReturnValue({
      close: vi.fn(),
      opener: window,
    } as unknown as Window);

    mount(runtime, app);
    const startButton = screen.getByRole("button", { name: "Start connect" });
    await waitFor(() => expect(startButton).toBeEnabled());
    fireEvent.click(startButton);
    const dialog = await screen.findByRole("dialog", { name: "Connect Gmail" });

    listApps.mockRestore();
    fireEvent.change(within(dialog).getByLabelText("Composio API key"), {
      target: { value: "ck_valid" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save key" }));

    const connectButton = await within(dialog).findByRole("button", {
      name: "Connect Gmail",
    });
    const closeButton = within(dialog).getByRole("button", { name: "Close" });
    expect(dialog).not.toHaveClass("app-dialog-standard");
    expect(dialog).toHaveAttribute("aria-label", "Connect Gmail");
    expect(
      within(dialog).getByRole("heading", { level: 2, name: "Connect Gmail" }),
    ).toBeVisible();
    expect(closeButton).toHaveAttribute("data-voice-close");
    // Connect button comes before Close in DOM order and takes focus.
    expect(
      connectButton.compareDocumentPosition(closeButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(connectButton).toHaveFocus();

    fireEvent.click(connectButton);
    await waitFor(() => expect(createConnection).toHaveBeenCalledWith("gmail"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each(["close", "escape", "backdrop"] as const)(
    "closes the compact confirmation dialog on %s without starting OAuth",
    async (dismissMethod) => {
      const { app, listApps, runtime } = await setupRuntime({
        canSave: true,
        configured: false,
      });
      runtime.server.on("PUT", "/v0/external-apps/provider-key", () => ({
        can_save: true,
        source: "stored",
      }));
      const createConnection = vi.spyOn(
        runtime.client,
        "createExternalConnection",
      );

      mount(runtime, app);
      const startButton = screen.getByRole("button", { name: "Start connect" });
      await waitFor(() => expect(startButton).toBeEnabled());
      fireEvent.click(startButton);
      const dialog = await screen.findByRole("dialog", {
        name: "Connect Gmail",
      });

      listApps.mockRestore();
      fireEvent.change(within(dialog).getByLabelText("Composio API key"), {
        target: { value: "ck_valid" },
      });
      fireEvent.click(within(dialog).getByRole("button", { name: "Save key" }));
      await within(dialog).findByRole("button", { name: "Connect Gmail" });

      if (dismissMethod === "close") {
        fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
      } else if (dismissMethod === "escape") {
        fireEvent(dialog, new Event("cancel", { cancelable: true }));
      } else {
        fireEvent.click(dialog);
      }

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(createConnection).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      true,
      "Composio no longer accepts the saved API key. Save a new key to keep connecting apps.",
    ],
    [false, "Composio rejected this deployment's API key."],
  ] as const)(
    "keeps the rejection description when keyRejected is true (canSave=%s)",
    async (canSave, expectedDescription) => {
      const { app, runtime } = await setupRuntime({
        canSave,
        configured: true,
      });
      const createConnection = vi
        .spyOn(runtime.client, "createExternalConnection")
        .mockRejectedValue(
          new TeamHubError({
            code: "COMPOSIO_KEY_REJECTED",
            message: "Composio rejected the configured API key",
            status: 409,
          }),
        );

      mount(runtime, app);
      const startButton = screen.getByRole("button", { name: "Start connect" });
      await waitFor(() => expect(startButton).toBeEnabled());
      fireEvent.click(startButton);

      const dialog = await screen.findByRole("dialog", {
        name: "Connect Gmail",
      });
      expect(createConnection).toHaveBeenCalledWith("gmail");
      expect(dialog.querySelector(".app-dialog-description")).toHaveTextContent(
        expectedDescription,
      );
      if (canSave) {
        expect(
          within(dialog).getByLabelText("Composio API key"),
        ).toHaveAccessibleDescription(
          "Select Read All and Write All when creating your key.",
        );
      } else {
        expect(dialog).toHaveTextContent("COMPOSIO_API_KEY");
        expect(
          within(dialog).queryByLabelText("Composio API key"),
        ).not.toBeInTheDocument();
      }
    },
  );
});

async function setupRuntime({
  canSave,
  configured,
}: {
  canSave: boolean;
  configured: boolean;
}) {
  const runtime = createTestTeamHubRuntime();
  const catalog = await runtime.client.listExternalApps();
  const app = catalog.apps.find((entry) => entry.key === "gmail")!;
  const listApps = vi
    .spyOn(runtime.client, "listExternalApps")
    .mockResolvedValue({
      ...catalog,
      provider_configured: configured,
      provider_key: {
        can_save: canSave,
        source: configured ? "stored" : "none",
      },
    });
  return { app, listApps, runtime };
}

function mount(runtime: TestTeamHubRuntime, app: TeamHubExternalApp) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TeamHubRuntimeProvider runtime={runtime}>
        <ConnectFlowHarness app={app} />
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
}
