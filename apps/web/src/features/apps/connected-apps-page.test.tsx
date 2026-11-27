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

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { TeamHubError } from "@/features/teamhub/teamhub-client";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";

import { ConnectedAppsPage } from "./connected-apps-page";

describe("Connected apps", () => {
  afterEach(() => {
    delete (window as { lingerDesktop?: unknown }).lingerDesktop;
    vi.restoreAllMocks();
  });

  it("lists curated apps without a key and explains that an admin must set one", async () => {
    const runtime = await testRuntime();
    vi.spyOn(runtime.client, "listExternalApps").mockResolvedValue(
      await unconfiguredCatalog(runtime, false),
    );
    renderPage(runtime);

    fireEvent.click(
      await screen.findByRole("button", { name: "Connect Slack" }),
    );

    const dialog = await screen.findByRole("dialog", { name: "Connect Slack" });
    expect(dialog).toHaveTextContent("COMPOSIO_API_KEY");
    expect(
      within(dialog).queryByLabelText("Composio API key"),
    ).not.toBeInTheDocument();
  });

  it("asks for the Composio key on Connect, then connects from the dialog", async () => {
    const runtime = await testRuntime();
    const listApps = vi
      .spyOn(runtime.client, "listExternalApps")
      .mockResolvedValue(await unconfiguredCatalog(runtime, true));
    runtime.server.on("PUT", "/v0/external-apps/provider-key", () => ({
      can_save: true,
      source: "stored",
    }));
    const save = vi.spyOn(runtime.client, "saveExternalProviderKey");
    const pending = {
      ...(await runtime.client.listExternalConnections()).connections[0]!,
      provider: "slack" as const,
      status: "pending" as const,
      connect_url: "https://connect.example.test/slack",
    };
    const createConnection = vi
      .spyOn(runtime.client, "createExternalConnection")
      .mockResolvedValue(pending);
    vi.spyOn(window, "open").mockReturnValue({
      close: vi.fn(),
      opener: window,
    } as unknown as Window);
    renderPage(runtime);

    // The app list stays visible without a key.
    fireEvent.click(
      await screen.findByRole("button", { name: "Connect Slack" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Connect Slack" });
    expect(dialog.querySelector(".app-dialog-description")).toBeNull();
    expect(dialog.querySelector("ol")).toBeNull();
    expect(dialog).not.toHaveTextContent("Get your API key");
    expect(dialog).not.toHaveTextContent("securely through Composio");
    expect(dialog).not.toHaveTextContent(
      "Permissions cannot be changed after a key is created",
    );
    expect(dialog).not.toHaveTextContent("stored encrypted");
    expect(
      within(dialog).getByRole("link", { name: "Get a key" }),
    ).toHaveAttribute(
      "href",
      "https://dashboard.composio.dev/~/project/settings/api-keys",
    );
    expect(createConnection).not.toHaveBeenCalled();

    listApps.mockRestore();
    const keyInput = within(dialog).getByLabelText("Composio API key");
    expect(keyInput).toHaveAccessibleDescription(
      "Select Read All and Write All when creating your key.",
    );
    fireEvent.change(keyInput, {
      target: { value: " ck_live " },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save key" }));
    const connectButton = await within(dialog).findByRole("button", {
      name: "Connect Slack",
    });
    expect(dialog).not.toHaveClass("app-dialog-standard");
    expect(dialog).toHaveAttribute("aria-label", "Connect Slack");
    expect(
      within(dialog).getByRole("heading", { level: 2, name: "Connect Slack" }),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("button", { name: "Close" }),
    ).toHaveAttribute("data-voice-close");
    expect(connectButton).toHaveFocus();
    fireEvent.click(connectButton);

    expect(save).toHaveBeenCalledWith("ck_live");
    await waitFor(() => expect(createConnection).toHaveBeenCalledWith("slack"));
    expect(window.open).toHaveBeenCalledWith(
      "https://connect.example.test/slack",
      "linger_composio_oauth",
      expect.any(String),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("asks for the Composio key from the app details dialog too", async () => {
    const runtime = await testRuntime();
    vi.spyOn(runtime.client, "listExternalApps").mockResolvedValue(
      await unconfiguredCatalog(runtime, true),
    );
    const create = vi.spyOn(runtime.client, "createExternalConnection");
    renderPage(runtime, "/apps?app=slack");

    const details = await screen.findByRole("dialog", { name: "Slack" });
    fireEvent.click(
      within(details).getByRole("button", { name: "Connect Slack" }),
    );

    const keyDialog = await screen.findByRole("dialog", {
      name: "Connect Slack",
    });
    expect(within(keyDialog).getByLabelText("Composio API key")).toBeVisible();
    expect(
      within(keyDialog).getByRole("link", { name: "Get a key" }),
    ).toBeVisible();
    expect(create).not.toHaveBeenCalled();
  });

  it("shows a one-line summary on the card and keeps the description out of the dialog", async () => {
    const runtime = await testRuntime();
    const description =
      "Import the last six months, up to 3,000 messages, for Profile and Wiki.";
    vi.spyOn(runtime.client, "listExternalApps").mockResolvedValue({
      provider_configured: true,
      provider_key: { source: "stored", can_save: true },
      apps: [
        {
          key: "gmail",
          display_name: "Gmail",
          description,
          availability: "available",
          capabilities: ["connect", "agent_tools"],
          allows_multiple_connections: true,
          supports_reauthorization: false,
        },
      ],
    });
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [],
    });

    renderPage(runtime);

    const card = await screen.findByRole("button", { name: "Gmail" });
    expect(within(card).getByText("Email")).toHaveClass("truncate");
    expect(within(card).getByText("Email")).toHaveAttribute("title", "Email");
    expect(within(card).queryByText(description)).toBeNull();
    // A saved provider key has no header button on this page.
    expect(screen.queryByRole("button", { name: /Composio key/i })).toBeNull();

    fireEvent.click(card);
    expect(
      await screen.findByRole("dialog", { name: "Gmail" }),
    ).not.toHaveTextContent(description);
  });

  it("renders a concise non-truncating subtitle for Calendly with full title tooltip", async () => {
    const runtime = await testRuntime();
    vi.spyOn(runtime.client, "listExternalApps").mockResolvedValue({
      provider_configured: true,
      provider_key: { source: "stored", can_save: true },
      apps: [
        {
          key: "calendly",
          display_name: "Calendly",
          description: "Manage Calendly scheduling links and events.",
          availability: "available",
          capabilities: ["connect", "agent_tools"],
          allows_multiple_connections: false,
          supports_reauthorization: false,
        },
      ],
    });
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [],
    });

    renderPage(runtime);

    const card = await screen.findByRole("button", { name: "Calendly" });
    const subtitle = within(card).getByText("Scheduling links");
    expect(subtitle).toBeVisible();
    expect(subtitle).toHaveAttribute("title", "Scheduling links");
  });

  it("groups apps into sections, hides ungrouped apps, and filters by group", async () => {
    const runtime = await testRuntime();

    renderPage(runtime);

    expect(await screen.findByRole("button", { name: "Gmail" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Connectors" })).toBeVisible();
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent),
    ).toEqual([
      "Mail & Calendar",
      "Meetings",
      "Productivity",
      "Messaging",
      "Web search",
    ]);
    const sectionApps = (name: string) =>
      within(screen.getByRole("region", { name }))
        .getAllByRole("article")
        .map((card) => within(card).getAllByRole("button")[0]!.ariaLabel);
    expect(sectionApps("Mail & Calendar")).toEqual([
      "Gmail",
      "Google Calendar",
    ]);
    expect(sectionApps("Meetings")).toEqual(["Google Meet"]);
    expect(sectionApps("Productivity")).toEqual(["GitHub", "Notion"]);
    expect(sectionApps("Messaging")).toEqual(["Slack", "Discord"]);
    // Facebook belongs to no group, so the page does not offer it.
    expect(screen.queryByRole("button", { name: "Facebook" })).toBeNull();
    expect(screen.getAllByText("Unavailable")).toHaveLength(3);
    expect(
      within(screen.getByRole("button", { name: "Gmail" })).getByText(
        "Connected",
      ),
    ).toBeVisible();
    // Disconnecting sits in the card's menu, not beside Connect.
    expect(
      screen.queryByRole("button", { name: "Disconnect Gmail" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Actions for Gmail" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Connect Slack" })).toBeVisible();
    expect(screen.queryByText("jenny@linger.test")).not.toBeInTheDocument();

    // One filter row: All, each app group, and Web search.
    const categories = screen.getByRole("group", {
      name: "Connector categories",
    });
    const pill = (name: string) =>
      within(categories).getByRole("button", { name });
    expect(
      within(categories)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual([
      "All",
      "Mail & Calendar",
      "Meetings",
      "Productivity",
      "Messaging",
      "Web search",
    ]);
    expect(pill("All")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("region", { name: "Web search" })).toBeVisible();

    // Web search shows only the search backends.
    fireEvent.click(pill("Web search"));
    expect(pill("Web search")).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.queryByRole("region", { name: "Application connections" }),
    ).toBeNull();

    // A group shows its apps without section headings or Web search.
    fireEvent.click(pill("Messaging"));
    expect(pill("Messaging")).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
    expect(screen.queryByRole("region", { name: "Web search" })).toBeNull();
    expect(
      within(screen.getByRole("region", { name: "Application connections" }))
        .getAllByRole("article")
        .map((card) => within(card).getAllByRole("button")[0]!.ariaLabel),
    ).toEqual(["Slack", "Discord"]);

    // Connected only narrows the open view: empty under Messaging, Gmail
    // alone under All.
    const connectedSwitch = screen.getByRole("switch", {
      name: "Connected only",
    });
    expect(connectedSwitch).not.toBeChecked();
    fireEvent.click(connectedSwitch);
    expect(connectedSwitch).toBeChecked();
    expect(screen.getByText("No connected apps yet.")).toBeVisible();
    fireEvent.click(pill("All"));
    expect(
      within(screen.getByRole("region", { name: "Application connections" }))
        .getAllByRole("article")
        .map((card) => within(card).getAllByRole("button")[0]!.ariaLabel),
    ).toEqual(["Gmail"]);

    fireEvent.click(connectedSwitch);
    expect(connectedSwitch).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Gmail" }));
    expect(await screen.findByText("jenny@linger.test")).toBeVisible();
  });

  it("asks for a new key when Composio rejects the saved one, then connects", async () => {
    const runtime = await testRuntime();
    vi.spyOn(runtime.client, "listExternalApps").mockResolvedValue({
      ...(await runtime.client.listExternalApps()),
      provider_configured: true,
      provider_key: { source: "stored", can_save: true },
    });
    const save = vi
      .spyOn(runtime.client, "saveExternalProviderKey")
      .mockResolvedValue({ source: "stored", can_save: true });
    const pending = {
      ...(await runtime.client.listExternalConnections()).connections[0]!,
      provider: "slack" as const,
      status: "pending" as const,
      connect_url: "https://connect.example.test/slack",
    };
    const create = vi
      .spyOn(runtime.client, "createExternalConnection")
      .mockRejectedValueOnce(
        new TeamHubError({
          code: "COMPOSIO_KEY_REJECTED",
          message: "Composio rejected the configured API key",
          status: 409,
        }),
      )
      .mockResolvedValueOnce(pending);
    renderPage(runtime);

    fireEvent.click(
      await screen.findByRole("button", { name: "Connect Slack" }),
    );

    const dialog = await screen.findByRole("dialog", { name: "Connect Slack" });
    expect(dialog).toHaveTextContent(
      "Composio no longer accepts the saved API key.",
    );
    // The dialog explains the failure, so the card shows no error of its own.
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("Composio API key"), {
      target: { value: "ck_new" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save key" }));
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Connect Slack" }),
    );

    expect(save).toHaveBeenCalledWith("ck_new");
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  });

  it("lists a connected app outside the groups under Connected only", async () => {
    const runtime = await testRuntime();
    const existing = (await runtime.client.listExternalConnections())
      .connections[0]!;
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [
        existing,
        {
          ...existing,
          id: "external-connection-facebook",
          provider: "facebook",
        },
      ],
    });
    renderPage(runtime);

    await screen.findByRole("button", { name: "Gmail" });
    expect(screen.queryByRole("button", { name: "Facebook" })).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Connected only" }));

    expect(
      within(screen.getByRole("region", { name: "Application connections" }))
        .getAllByRole("article")
        .map((card) => within(card).getAllByRole("button")[0]!.ariaLabel),
    ).toEqual(["Gmail", "Facebook"]);
  });

  it("opens the manage dialog for an app the grid does not offer", async () => {
    const runtime = await testRuntime();

    renderPage(runtime, "/apps?app=facebook");

    expect(
      await screen.findByRole("dialog", { name: "Facebook" }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Facebook" })).toBeNull();
  });

  it("shows an Outlook identity as the sign-in name", async () => {
    const runtime = await testRuntime();
    const catalog = await runtime.client.listExternalApps();
    const gmailApp = catalog.apps.find((app) => app.key === "gmail")!;
    vi.spyOn(runtime.client, "listExternalApps").mockResolvedValue({
      ...catalog,
      apps: [
        ...catalog.apps,
        { ...gmailApp, key: "outlook", display_name: "Outlook" },
      ],
    });
    const existing = (await runtime.client.listExternalConnections())
      .connections[0]!;
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [
        existing,
        {
          ...existing,
          id: "outlook-1",
          identity_label: "me@example.net",
          provider: "outlook",
        },
      ],
    });

    renderPage(runtime, "/apps?app=outlook");
    const outlook = await screen.findByRole("dialog", { name: "Outlook" });
    expect(
      await within(outlook).findByText("Signed in as me@example.net"),
    ).toBeVisible();
  });

  it("shows a Gmail identity as the address itself", async () => {
    const runtime = await testRuntime();

    renderPage(runtime, "/apps?app=gmail");
    const gmail = await screen.findByRole("dialog", { name: "Gmail" });
    expect(await within(gmail).findByText("jenny@linger.test")).toBeVisible();
    expect(within(gmail).queryByText(/Signed in as/)).toBeNull();
  });

  it("counts active accounts and those that need reconnecting", async () => {
    const runtime = await testRuntime();
    const existing = (await runtime.client.listExternalConnections())
      .connections[0]!;
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [
        existing,
        {
          ...existing,
          id: "gmail-expired",
          identity_label: "expired@linger.test",
          status: "expired",
        },
        {
          ...existing,
          id: "gmail-failed",
          identity_label: "failed@linger.test",
          status: "failed",
        },
      ],
    });

    renderPage(runtime, "/apps?app=gmail");

    const gmail = await screen.findByRole("button", { name: "Gmail" });
    expect(
      within(gmail).getByText("Connected, 2 need reconnecting"),
    ).toBeVisible();
    const dialog = screen.getByRole("dialog", { name: "Gmail" });
    expect(within(dialog).getByText("expired@linger.test")).toBeVisible();
    expect(within(dialog).getByText("failed@linger.test")).toBeVisible();
    expect(within(dialog).getAllByText("Needs reconnecting")).toHaveLength(2);
  });

  it("hides in-flight pending accounts from the manage dialog", async () => {
    const runtime = await testRuntime();
    const existing = (await runtime.client.listExternalConnections())
      .connections[0]!;
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [
        {
          ...existing,
          id: "gmail-pending",
          identity_label: "gmail pending account",
          status: "pending",
        },
      ],
    });

    renderPage(runtime, "/apps?app=gmail");

    const dialog = await screen.findByRole("dialog", { name: "Gmail" });
    expect(
      within(dialog).queryByText("gmail pending account"),
    ).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Pending")).not.toBeInTheDocument();
    expect(screen.queryByText("Authorizing…")).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Connect Gmail" }).length,
    ).toBeGreaterThan(0);
  });

  it("lets the owner turn auto reminders off for a watchable account, without Agent access", async () => {
    const runtime = await testRuntime();
    const listAccess = vi.spyOn(
      runtime.client,
      "listExternalConnectionAgentAccess",
    );
    const initial = (await runtime.client.listExternalConnections())
      .connections[0]!;
    const off = { ...initial, auto_reminders: false };
    vi.spyOn(runtime.client, "listExternalConnections")
      .mockResolvedValueOnce({ connections: [initial] })
      .mockResolvedValue({ connections: [off] });
    const setAutoReminders = vi
      .spyOn(runtime.client, "setExternalConnectionAutoReminders")
      .mockResolvedValue(off);

    renderPage(runtime, "/apps?app=gmail");

    const dialog = await screen.findByRole("dialog", { name: "Gmail" });
    const toggle = await within(dialog).findByRole("switch", {
      name: "Auto reminders for jenny@linger.test",
    });
    expect(toggle).toBeChecked();
    expect(
      within(dialog).getByText(
        "Agents check this account for things that need your attention.",
      ),
    ).toBeVisible();
    expect(within(dialog).queryByText("Agent access")).toBeNull();
    fireEvent.click(toggle);

    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(setAutoReminders).toHaveBeenCalledWith(
      "external-connection-gmail",
      false,
    );
    expect(listAccess).not.toHaveBeenCalled();
  });

  it("shows no auto reminders switch for an app AnotherMe cannot watch", async () => {
    const runtime = await testRuntime();
    const existing = (await runtime.client.listExternalConnections())
      .connections[0]!;
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [
        {
          ...existing,
          id: "external-connection-notion",
          identity_label: "Jenny's workspace",
          provider: "notion",
        },
      ],
    });

    renderPage(runtime, "/apps?app=notion");

    const dialog = await screen.findByRole("dialog", { name: "Notion" });
    expect(await within(dialog).findByText("Jenny's workspace")).toBeVisible();
    expect(within(dialog).queryByRole("switch")).toBeNull();
    expect(within(dialog).queryByText("Agent access")).toBeNull();
  });

  it("starts a connection through the generic app endpoint", async () => {
    const runtime = await testRuntime();
    const pending = {
      ...(await runtime.client.listExternalConnections()).connections[0]!,
      provider: "slack" as const,
      status: "pending" as const,
      connect_url: "https://connect.example.test/slack",
    };
    const createConnection = vi
      .spyOn(runtime.client, "createExternalConnection")
      .mockResolvedValue(pending);
    vi.spyOn(window, "open").mockReturnValue({
      close: vi.fn(),
      opener: window,
    } as unknown as Window);

    renderPage(runtime);

    fireEvent.click(
      await screen.findByRole("button", { name: "Connect Slack" }),
    );

    await waitFor(() => expect(createConnection).toHaveBeenCalledWith("slack"));
    expect(window.open).toHaveBeenCalledWith(
      "https://connect.example.test/slack",
      "linger_composio_oauth",
      expect.stringContaining("width=560,height=720"),
    );
    expect(screen.queryByText("Authorization in progress")).toBeNull();
  });

  it("keeps unavailable catalog entries visible but not actionable", async () => {
    const runtime = await testRuntime();

    renderPage(runtime);
    fireEvent.click(await screen.findByRole("button", { name: "Discord" }));

    const dialog = await screen.findByRole("dialog", { name: "Discord" });
    expect(
      within(dialog).getByRole("button", { name: "Connect" }),
    ).toBeDisabled();
    expect(
      within(dialog).queryByText("No accounts connected."),
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("button", { name: "Discord" })).getByText(
        "Unavailable",
      ),
    ).toBeVisible();
  });

  it("keeps the pending connection and offers a popup-blocker fallback", async () => {
    const runtime = await testRuntime();
    const pending = {
      ...(await runtime.client.listExternalConnections()).connections[0]!,
      provider: "slack" as const,
      status: "pending" as const,
      connect_url: "https://connect.example.test/slack",
    };
    vi.spyOn(runtime.client, "createExternalConnection").mockResolvedValue(
      pending,
    );
    vi.spyOn(window, "open").mockReturnValue(null);

    renderPage(runtime);
    fireEvent.click(
      await screen.findByRole("button", { name: "Connect Slack" }),
    );

    expect(
      await screen.findByText("Your browser blocked the authorization popup."),
    ).toBeVisible();
    expect(screen.getByText("Authorizing…")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Open authorization window" }),
    ).toBeVisible();
  });

  it("shows an unconfirmed Discord connection and checks it again", async () => {
    const runtime = await testRuntime();
    const template = (await runtime.client.listExternalConnections())
      .connections[0]!;
    const unconfirmed = {
      ...template,
      id: "pending-discord",
      identity_label: "Discord server",
      provider: "discord" as const,
      revision: 4,
      status: "pending" as const,
      status_error_code: "discord_guild_required",
    };
    const duplicate = {
      ...template,
      id: "duplicate-discord",
      identity_label: "Duplicate server",
      provider: "discord" as const,
      status: "pending" as const,
      status_error_code: "duplicate_remote_principal",
    };
    const catalog = await runtime.client.listExternalApps();
    vi.spyOn(runtime.client, "listExternalApps").mockResolvedValue({
      provider_configured: true,
      provider_key: { source: "environment", can_save: false },
      apps: catalog.apps.map((app) =>
        app.key === "discord"
          ? { ...app, availability: "available" as const }
          : app,
      ),
    });
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [unconfirmed, duplicate],
    });
    const check = vi
      .spyOn(runtime.client, "createExternalConnectionStatusCheck")
      .mockResolvedValue({
        ...unconfirmed,
        status_check_requested_at: "2026-11-19T00:00:00.000Z",
      });
    renderPage(runtime);

    const card = await screen.findByRole("button", { name: "Discord" });
    expect(
      await within(card).findByText("Couldn't confirm connection"),
    ).toBeVisible();
    expect(within(card).queryByText("Connected")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Connect Discord" }),
    ).toBeEnabled();

    fireEvent.click(card);
    const dialog = await screen.findByRole("dialog", { name: "Discord" });
    expect(within(dialog).getByText("Discord server")).toBeVisible();
    expect(within(dialog).queryByText("Duplicate server")).toBeNull();
    expect(
      within(dialog).getByText(
        "Discord is authorized, but the Server couldn't be confirmed. Check again, or disconnect and reconnect.",
      ),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("button", { name: "Disconnect Discord server" }),
    ).toBeVisible();
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Check again Discord server",
      }),
    );
    await waitFor(() =>
      expect(check).toHaveBeenCalledWith("pending-discord", 4),
    );
  });

  it("asks to check again when another provider check is unconfirmed", async () => {
    const runtime = await testRuntime();
    const existing = (await runtime.client.listExternalConnections())
      .connections[0]!;
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [
        {
          ...existing,
          status: "pending",
          status_error_code: "provider_identity_unavailable",
        },
      ],
    });

    renderPage(runtime, "/apps?app=gmail");

    const dialog = await screen.findByRole("dialog", { name: "Gmail" });
    expect(
      within(dialog).getByText(
        "The connection couldn't be confirmed yet. Check again.",
      ),
    ).toBeVisible();
  });

  it("lists a Gmail account that failed authorization for reconnecting", async () => {
    const runtime = await testRuntime();
    const existing = (await runtime.client.listExternalConnections())
      .connections[0]!;
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [
        {
          ...existing,
          status: "failed",
          status_error_code: "provider_auth_failed",
        },
      ],
    });

    renderPage(runtime, "/apps?app=gmail");

    const dialog = await screen.findByRole("dialog", { name: "Gmail" });
    expect(
      await within(dialog).findByText(
        "This app did not grant enough permission. Reconnect and approve all requested access.",
      ),
    ).toBeVisible();
    expect(within(dialog).getByText("Needs reconnecting")).toBeVisible();
    expect(
      within(dialog).getByRole("button", {
        name: "Reconnect jenny@linger.test",
      }),
    ).toBeEnabled();
    expect(
      within(dialog).getByRole("button", {
        name: "Disconnect jenny@linger.test",
      }),
    ).toBeEnabled();
    expect(
      within(dialog).getByRole("button", { name: "Connect Gmail" }),
    ).toBeEnabled();
  });

  it("reconnects an expired Gmail account beside an active one only when asked", async () => {
    const runtime = await testRuntime();
    const existing = (await runtime.client.listExternalConnections())
      .connections[0]!;
    const expired = {
      ...existing,
      id: "gmail-expired",
      identity_label: "old@linger.test",
      status: "expired" as const,
    };
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [existing, expired],
    });
    const createReauthorization = vi
      .spyOn(runtime.client, "createExternalConnectionReauthorization")
      .mockResolvedValue({
        ...expired,
        reauthorizing: true,
        reauthorization_connect_expires_at: "2999-01-01T00:00:00Z",
        reauthorization_connect_url:
          "https://connect.example.test/gmail/reauthorize",
      });
    const open = vi
      .spyOn(window, "open")
      .mockReturnValue({ opener: null } as unknown as Window);

    renderPage(runtime, "/apps?app=gmail");

    expect(
      await screen.findByText("Connected, 1 needs reconnecting"),
    ).toBeVisible();
    const dialog = await screen.findByRole("dialog", { name: "Gmail" });
    expect(createReauthorization).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Reconnect old@linger.test" }),
    );
    await waitFor(() =>
      expect(createReauthorization).toHaveBeenCalledWith(
        "gmail-expired",
        expired.revision,
      ),
    );
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        "https://connect.example.test/gmail/reauthorize",
        expect.any(String),
        expect.any(String),
      ),
    );
  });

  it("clears a failed Add account error once Reconnect succeeds", async () => {
    const runtime = await testRuntime();
    const existing = (await runtime.client.listExternalConnections())
      .connections[0]!;
    const expired = {
      ...existing,
      id: "gmail-expired",
      identity_label: "old@linger.test",
      status: "expired" as const,
    };
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [existing, expired],
    });
    vi.spyOn(runtime.client, "createExternalConnection").mockRejectedValue(
      new Error("Add account failed for the test."),
    );
    vi.spyOn(
      runtime.client,
      "createExternalConnectionReauthorization",
    ).mockResolvedValue({
      ...expired,
      reauthorizing: true,
      reauthorization_connect_expires_at: "2999-01-01T00:00:00Z",
      reauthorization_connect_url:
        "https://connect.example.test/gmail/reauthorize",
    });
    vi.spyOn(window, "open").mockReturnValue({
      opener: null,
    } as unknown as Window);

    renderPage(runtime, "/apps?app=gmail");

    const dialog = await screen.findByRole("dialog", { name: "Gmail" });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Add another Gmail account" }),
    );
    expect(
      await within(dialog).findByText("Add account failed for the test."),
    ).toBeVisible();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Reconnect old@linger.test" }),
    );
    await waitFor(() =>
      expect(
        within(dialog).queryByText("Add account failed for the test."),
      ).toBeNull(),
    );
  });

  it("hides a duplicate remote account that failed to connect", async () => {
    const runtime = await testRuntime();
    const existing = (await runtime.client.listExternalConnections())
      .connections[0]!;
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [
        {
          ...existing,
          id: "external-connection-duplicate",
          status: "failed",
          status_error_code: "duplicate_remote_principal",
        },
      ],
    });

    renderPage(runtime, "/apps?app=gmail");

    const dialog = await screen.findByRole("dialog", { name: "Gmail" });
    expect(
      screen.queryByText("This account is already connected."),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
    expect(
      within(dialog).getByRole("button", { name: "Connect Gmail" }),
    ).toBeEnabled();
  });

  it("resumes an open pending account from Add account instead of creating one", async () => {
    const open = vi
      .spyOn(window, "open")
      .mockReturnValue({ opener: null } as unknown as Window);
    const runtime = await testRuntime();
    const existing = (await runtime.client.listExternalConnections())
      .connections[0]!;
    const pending = {
      ...existing,
      id: "external-connection-pending",
      identity_label: "",
      status: "pending" as const,
      connect_url: "https://connect.example.test/open",
      connect_expires_at: "2999-01-01T00:00:00Z",
    };
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [existing, pending],
    });
    vi.spyOn(runtime.client, "getExternalConnection").mockResolvedValue(
      pending,
    );
    const create = vi.spyOn(runtime.client, "createExternalConnection");

    renderPage(runtime, "/apps?app=gmail");

    const dialog = await screen.findByRole("dialog", { name: "Gmail" });
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Add another Gmail account",
      }),
    );
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        "https://connect.example.test/open",
        expect.any(String),
        expect.any(String),
      ),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("confirms what disconnecting stops before disconnecting an account", async () => {
    const runtime = await testRuntime();
    const existing = (await runtime.client.listExternalConnections())
      .connections[0]!;
    const disconnecting = {
      ...existing,
      revision: existing.revision + 1,
      status: "disconnecting" as const,
    };
    const disconnect = vi
      .spyOn(runtime.client, "disconnectExternalConnection")
      .mockResolvedValue(disconnecting);
    vi.spyOn(runtime.client, "getExternalConnection").mockResolvedValue(
      disconnecting,
    );

    renderPage(runtime, "/apps?app=gmail");

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Disconnect jenny@linger.test",
      }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Disconnect account?",
    });
    expect(
      within(dialog).getByText(/Agents lose access to this account/),
    ).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));

    await waitFor(() => expect(disconnect).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(
        within(dialog).queryByRole("button", { name: "Disconnect" }),
      ).toBeNull(),
    );
    expect(
      within(dialog).getAllByRole("button", { name: "Close" }).length,
    ).toBeGreaterThan(0);
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "Disconnected. Revoking access…",
    );
    expect(disconnect.mock.calls[0]?.[1]).toEqual({ expected_revision: 1 });
  });

  it("shows Manage button even when the app is unavailable if an account needs reconnecting", async () => {
    const runtime = await testRuntime();
    const catalog = await runtime.client.listExternalApps();
    vi.spyOn(runtime.client, "listExternalApps").mockResolvedValue({
      ...catalog,
      apps: catalog.apps.map((app) =>
        app.key === "gmail"
          ? { ...app, availability: "unavailable" as const }
          : app,
      ),
    });
    const existing = (await runtime.client.listExternalConnections())
      .connections[0]!;
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [{ ...existing, status: "failed" }],
    });

    renderPage(runtime);

    const cardButton = await screen.findByRole("button", { name: "Gmail" });
    expect(within(cardButton).getByText("Unavailable")).toBeVisible();
    expect(
      cardButton.querySelector(
        'span[aria-hidden][class*="app-status-warning-text"]',
      ),
    ).toBeNull();
    const manageButton = screen.getByRole("button", { name: "Manage Gmail" });
    expect(manageButton).toBeVisible();
    fireEvent.click(manageButton);
    expect(await screen.findByRole("dialog", { name: "Gmail" })).toBeVisible();
  });

  it.each([
    {
      name: "failed with provider_auth_failed",
      status: "failed" as const,
      status_error_code: "provider_auth_failed",
    },
    {
      name: "expired",
      status: "expired" as const,
      status_error_code: undefined,
    },
  ])(
    "shows Needs reconnecting with a warning dot and Manage action when no active account exists ($name)",
    async ({ status, status_error_code }) => {
      const runtime = await testRuntime();
      const existing = (await runtime.client.listExternalConnections())
        .connections[0]!;
      vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
        connections: [
          {
            ...existing,
            status,
            status_error_code,
          },
        ],
      });

      renderPage(runtime);

      const cardButton = await screen.findByRole("button", { name: "Gmail" });
      const subtitle = within(cardButton).getByText("Needs reconnecting");
      expect(subtitle).toBeVisible();
      expect(
        cardButton.querySelector(
          'span[aria-hidden][class*="app-status-warning-text"]',
        ),
      ).not.toBeNull();
      expect(
        screen.queryByRole("button", { name: "Connect Gmail" }),
      ).toBeNull();

      const manageButton = screen.getByRole("button", { name: "Manage Gmail" });
      expect(manageButton).toBeVisible();
      fireEvent.click(manageButton);
      expect(
        await screen.findByRole("dialog", { name: "Gmail" }),
      ).toBeVisible();
    },
  );

  it("shows the plural count needing reconnecting when multiple accounts need attention and none are active", async () => {
    const runtime = await testRuntime();
    const existing = (await runtime.client.listExternalConnections())
      .connections[0]!;
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [
        {
          ...existing,
          id: "gmail-failed",
          identity_label: "failed@linger.test",
          status: "failed",
        },
        {
          ...existing,
          id: "gmail-expired",
          identity_label: "expired@linger.test",
          status: "expired",
        },
      ],
    });

    renderPage(runtime);

    const cardButton = await screen.findByRole("button", { name: "Gmail" });
    expect(within(cardButton).getByText("2 need reconnecting")).toBeVisible();
    expect(
      cardButton.querySelector(
        'span[aria-hidden][class*="app-status-warning-text"]',
      ),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "Manage Gmail" })).toBeVisible();
  });

  it("shows one appropriate auth failure alert for failed and reauthorization-failed rows and none for plain expired rows", async () => {
    const runtime = await testRuntime();
    const existing = (await runtime.client.listExternalConnections())
      .connections[0]!;
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [
        {
          ...existing,
          id: "gmail-failed-generic",
          identity_label: "generic@linger.test",
          status: "failed",
        },
        {
          ...existing,
          id: "gmail-reauth-perm",
          identity_label: "reauth-perm@linger.test",
          status: "expired",
          reauthorizing: false,
          reauthorization_error_code: "provider_auth_failed",
        },
        {
          ...existing,
          id: "gmail-both-perm",
          identity_label: "both-perm@linger.test",
          status: "failed",
          status_error_code: "provider_auth_failed",
          reauthorizing: false,
          reauthorization_error_code: "provider_auth_failed",
        },
        {
          ...existing,
          id: "gmail-reauth-dup",
          identity_label: "reauth-dup@linger.test",
          status: "expired",
          reauthorizing: false,
          reauthorization_error_code: "duplicate_remote_principal",
        },
        {
          ...existing,
          id: "gmail-plain-expired",
          identity_label: "plain-expired@linger.test",
          status: "expired",
        },
      ],
    });

    renderPage(runtime, "/apps?app=gmail");

    const dialog = await screen.findByRole("dialog", { name: "Gmail" });
    expect(
      within(dialog).getByText(
        "Authorization failed. Reconnect this app and approve the requested access.",
      ),
    ).toBeVisible();
    expect(
      within(dialog).getAllByText(
        "This app did not grant enough permission. Reconnect and approve all requested access.",
      ),
    ).toHaveLength(2);
    expect(
      within(dialog).getByText("This account is already connected."),
    ).toBeVisible();
    // Plain expired row has Needs reconnecting pill and Reconnect button, no alert.
    const plainRow = within(dialog)
      .getByText("plain-expired@linger.test")
      .closest("div.flex.min-h-\\[58px\\]")!;
    expect(within(plainRow as HTMLElement).queryByRole("alert")).toBeNull();
    expect(
      within(plainRow as HTMLElement).getByRole("button", {
        name: "Reconnect plain-expired@linger.test",
      }),
    ).toBeVisible();
  });

  it("hides stale reauthorization alerts on active or disconnecting rows and keeps failure alert on failed rows with transient error codes", async () => {
    const runtime = await testRuntime();
    const existing = (await runtime.client.listExternalConnections())
      .connections[0]!;
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [
        {
          ...existing,
          id: "gmail-active-stale",
          identity_label: "active-stale@linger.test",
          status: "active",
          reauthorizing: false,
          reauthorization_error_code: "stale_revision",
        },
        {
          ...existing,
          id: "gmail-active-perm",
          identity_label: "active-perm@linger.test",
          status: "active",
          reauthorizing: false,
          reauthorization_error_code: "provider_auth_failed",
        },
        {
          ...existing,
          id: "gmail-disconnecting-perm",
          identity_label: "disconnecting-perm@linger.test",
          status: "disconnecting",
          reauthorizing: false,
          reauthorization_error_code: "provider_auth_failed",
        },
        {
          ...existing,
          id: "gmail-failed-transient",
          identity_label: "failed-transient@linger.test",
          status: "failed",
          status_error_code: "provider_status_unavailable",
        },
      ],
    });

    renderPage(runtime, "/apps?app=gmail");

    const dialog = await screen.findByRole("dialog", { name: "Gmail" });
    for (const label of [
      "active-stale@linger.test",
      "active-perm@linger.test",
      "disconnecting-perm@linger.test",
    ]) {
      const row = within(dialog)
        .getByText(label)
        .closest("div.flex.min-h-\\[58px\\]") as HTMLElement;
      expect(within(row).queryByRole("alert")).toBeNull();
    }
    const failedRow = within(dialog)
      .getByText("failed-transient@linger.test")
      .closest("div.flex.min-h-\\[58px\\]") as HTMLElement;
    expect(within(failedRow).getByRole("alert")).toHaveTextContent(
      "Authorization failed. Reconnect this app and approve the requested access.",
    );
  });

  it("creates a fresh connection instead of reusing a pending connect_url in desktop mode", async () => {
    const prepare = vi
      .fn()
      .mockResolvedValue(
        "http://127.0.0.1:43210/oauth/connector/" + "a".repeat(48),
      );
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
        prepare,
        onReturn: vi.fn(() => () => {}),
      },
    };
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const runtime = await testRuntime();
    const existing = (await runtime.client.listExternalConnections())
      .connections[0]!;
    const pending = {
      ...existing,
      id: "external-connection-pending",
      identity_label: "",
      status: "pending" as const,
      connect_url: "https://connect.example.test/stale",
      connect_expires_at: "2999-01-01T00:00:00Z",
    };
    const fresh = {
      ...existing,
      id: "external-connection-fresh",
      identity_label: "",
      status: "pending" as const,
      connect_url: "https://connect.example.test/fresh",
      connect_expires_at: "2999-01-01T00:00:00Z",
    };
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [existing, pending],
    });
    const getConnection = vi.spyOn(runtime.client, "getExternalConnection");
    const create = vi
      .spyOn(runtime.client, "createExternalConnection")
      .mockResolvedValue(fresh);

    renderPage(runtime, "/apps?app=gmail");

    const dialog = await screen.findByRole("dialog", { name: "Gmail" });
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Add another Gmail account",
      }),
    );

    await waitFor(() => expect(create).toHaveBeenCalledWith("gmail"));
    expect(getConnection).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(
      "https://connect.example.test/fresh",
      expect.any(String),
      expect.any(String),
    );
  });
});

/** The curated catalog TeamHub lists without a Composio key. */
async function unconfiguredCatalog(
  runtime: Awaited<ReturnType<typeof testRuntime>>,
  canSave: boolean,
) {
  const catalog = await runtime.client.listExternalApps();
  return {
    apps: catalog.apps.map((app) => ({
      ...app,
      availability: "unavailable" as const,
    })),
    provider_configured: false,
    provider_key: { source: "none" as const, can_save: canSave },
  };
}

async function testRuntime() {
  const runtime = createTestTeamHubRuntime();

  return runtime;
}

function renderPage(
  runtime: Awaited<ReturnType<typeof testRuntime>>,
  initialEntry = "/apps",
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <ConnectedAppsPage />
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}
