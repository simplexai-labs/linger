import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { TeamHubExternalConnection } from "@/features/teamhub/teamhub-types";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { resetLanguageForTest, setLanguage } from "@/i18n/language";
import zhCN from "@/i18n/locales/zh-CN.json";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { DecisionCard, type DecisionMessageCard } from "./decision-card";

type Card = DecisionMessageCard;
const card: Card = {
  card_type: "personal_notice",
  intent: "decision_requested",
  version: 1,
  decision_id: "auth-1",
  kind: "connection_auth",
  status: "pending",
  title: "Please connect and authorize your Notion account so I can continue.",
  connection_auth: { app_key: "notion" },
  expires_at: "2999-01-01T00:00:00Z",
  decision_owner: { id: "alice", display_name: "Alice", kind: "human" },
  requester: {
    id: "writer",
    display_name: "Project Writer",
    kind: "agent",
  },
};
async function setup(
  next: Card = card,
  actorId = "alice",
  hasConnection = true,
  status: "active" | "pending" = "active",
  others: Partial<TeamHubExternalConnection>[] = [],
  canConnectNew = true,
  configure?: (runtime: ReturnType<typeof createTestTeamHubRuntime>) => void,
) {
  const runtime = createTestTeamHubRuntime();
  if (!canConnectNew) {
    const catalog = await runtime.client.listExternalApps();
    vi.spyOn(runtime.client, "listExternalApps").mockResolvedValue({
      ...catalog,
      apps: catalog.apps.map((app) =>
        app.key === "notion"
          ? { ...app, availability: "unavailable" as const }
          : app,
      ),
    });
  }

  const existing = (await runtime.client.listExternalConnections())
    .connections[0]!;
  const connection = {
    ...existing,
    id: "notion-1",
    provider: "notion" as const,
    identity_label: "Alice's Notion",
    status,
  };
  vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
    connections: [
      ...(hasConnection ? [connection] : []),
      ...others.map((other) => ({ ...connection, ...other })),
    ],
  });
  if (next.status === "authorizing")
    vi.spyOn(runtime.client, "getExternalConnection").mockResolvedValue({
      ...connection,
      status: "pending",
      connect_url: "https://connect.example.test/resume",
    });
  configure?.(runtime);
  const decision = vi.fn().mockResolvedValue(undefined);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <DecisionCard
            tenantId="tenant_one"
            card={next}
            currentActorId={actorId}
            messageId="message-1"
            onDecision={decision}
            roomId="room-1"
          />
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { runtime, decision, connection };
}

// Actions render disabled until the connections load, and a click before then
// is ignored; that happens whenever a test is the first to load the card.
async function enabledButton(name: string) {
  const button = await screen.findByRole("button", { name });
  await waitFor(() => expect(button).toBeEnabled());
  return button;
}

describe("Chat connection authorization", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetLanguageForTest();
  });

  it("asks explicit consent for the named general Agent and selected connection", async () => {
    const { decision } = await setup();
    expect(await screen.findByText("Notion")).toBeVisible();
    expect(screen.queryByText("Project Writer")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        level: 3,
        name: "Please connect and authorize your Notion account so I can continue.",
      }),
    ).toBeVisible();
    expect(
      screen.getAllByText(
        "Please connect and authorize your Notion account so I can continue.",
      ),
    ).toHaveLength(1);
    expect(document.querySelector(".card-prompt")).toBeNull();
    expect(screen.queryByText(/Asks you|Authorizing/)).not.toBeInTheDocument();
    fireEvent.click(await enabledButton("Allow Project Writer"));
    await waitFor(() =>
      expect(decision).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: "approve",
          connectionId: "notion-1",
          requestId: "auth-1",
          expectedVersion: 1,
        }),
      ),
    );
  });

  it("shows the long ask as the heading, never on a button", async () => {
    const prompt =
      "Please connect and authorize your Notion account so I can continue.";
    await setup({
      ...card,
      title: prompt,
      requester: {
        ...card.requester,
        display_name: "alex.doe's AnotherMe",
      },
    });
    expect(await screen.findByText("Notion")).toBeVisible();
    expect(screen.queryByText("alex.doe's AnotherMe")).not.toBeInTheDocument();
    const heading = screen.getByRole("heading", { level: 3, name: prompt });
    expect(heading).toHaveClass("[overflow-wrap:anywhere]");
    expect(screen.getAllByText(prompt)).toHaveLength(1);
    expect(document.querySelector(".card-prompt")).toBeNull();
    expect(
      await screen.findByRole("button", {
        name: "Allow alex.doe's AnotherMe",
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", {
        name: /Connect Notion and allow/,
      }),
    ).not.toBeInTheDocument();
  });

  it("does not let another Room member connect or grant", async () => {
    const { runtime } = await setup(card, "bob");
    expect(await screen.findByText("Notion")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Allow|Connect|Not now|Cancel/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Only Alice|Waiting for Alice/),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "App authorization requested" }),
    ).toBeVisible();
    expect(runtime.client.listExternalConnections).not.toHaveBeenCalled();
  });

  it("lets the assignee dismiss the request without connecting", async () => {
    const { decision } = await setup();
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    await waitFor(() =>
      expect(decision).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: "deny",
          requestId: "auth-1",
          expectedVersion: 1,
        }),
      ),
    );
  });

  it("saves pending consent before opening OAuth and recovers a blocked popup", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const { runtime, decision, connection } = await setup(card, "alice", false);
    const create = vi
      .spyOn(runtime.client, "createExternalConnection")
      .mockResolvedValue({
        ...connection,
        status: "pending",
        connect_url: "https://connect.example.test/notion",
      });
    fireEvent.click(await enabledButton("Connect Notion"));
    await waitFor(() =>
      expect(decision).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: connection.id,
          decision: "approve",
        }),
      ),
    );
    expect(create).toHaveBeenCalledWith("notion");
    expect(
      await screen.findByRole("button", { name: "Open authorization window" }),
    ).toBeVisible();
  });

  it("turns missing lark-cli app scopes into steps instead of an error line", async () => {
    const { runtime, decision } = await setup(card, "alice", false);
    vi.spyOn(runtime.client, "createExternalConnection").mockRejectedValue(
      new TeamHubError({
        code: "FEISHU_SCOPES_NOT_ENABLED",
        status: 409,
        message: "The Feishu app your lark-cli uses does not enable them.",
        details: [
          { field: "scope", reason: "mail:user_mailbox:readonly" },
          { field: "scope", reason: "mail:user_mailbox.message:send" },
          {
            field: "permissions_url",
            reason: "https://open.feishu.cn/app/cli_abc/auth",
          },
        ],
      }),
    );
    fireEvent.click(await enabledButton("Connect Notion"));
    expect(
      await screen.findByText(
        "The Feishu app your lark-cli uses needs mail permissions first",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: /Open permissions page/ }),
    ).toHaveAttribute("href", "https://open.feishu.cn/app/cli_abc/auth");
    expect(
      within(screen.getByRole("list", { name: "Mail permissions to add" }))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["mail:user_mailbox:readonly", "mail:user_mailbox.message:send"]);
    expect(screen.getByRole("button", { name: "Copy" })).toBeVisible();
    expect(screen.queryByText(/does not enable them/)).not.toBeInTheDocument();
    expect(decision).not.toHaveBeenCalled();
  });

  it.each([
    {
      code: "LARK_CLI_NOT_INSTALLED",
      title:
        "lark-cli is not installed on the Computer that runs your Another Me",
      commands: ["npm install -g @larksuite/cli"],
    },
    {
      code: "LARK_CLI_NOT_CONFIGURED",
      title:
        "lark-cli on the Computer that runs your Another Me is not set up yet",
      commands: ["lark-cli config init --new"],
    },
    {
      code: "FEISHU_COMPUTER_OFFLINE",
      title: "The Computer that runs your Another Me is offline",
      commands: [],
    },
    {
      code: "FEISHU_COMPUTER_UNAVAILABLE",
      title: "The Computer that runs your Another Me could not check lark-cli",
      commands: [],
    },
  ])(
    "turns $code into steps instead of TeamHub's error line",
    async ({ code, title, commands }) => {
      const { runtime, decision } = await setup(card, "alice", false);
      vi.spyOn(runtime.client, "createExternalConnection").mockRejectedValue(
        new TeamHubError({
          code,
          status: 409,
          message: "TeamHub's own wording of the failure.",
          // TeamHub names the commands; the card writes none of its own.
          details: commands.map((command) => ({
            field: "command",
            reason: command,
          })),
        }),
      );
      fireEvent.click(await enabledButton("Connect Notion"));
      expect(await screen.findByText(title)).toBeVisible();
      for (const command of commands)
        expect(screen.getByText(command)).toBeVisible();
      expect(
        screen.queryAllByRole("button", { name: "Copy command" }),
      ).toHaveLength(commands.length);
      expect(
        screen.queryByText("TeamHub's own wording of the failure."),
      ).not.toBeInTheDocument();
      expect(decision).not.toHaveBeenCalled();
    },
  );

  it("shows the server message when an older server omits the command", async () => {
    const { runtime } = await setup(card, "alice", false);
    vi.spyOn(runtime.client, "createExternalConnection").mockRejectedValue(
      new TeamHubError({
        code: "LARK_CLI_NOT_INSTALLED",
        status: 409,
        message: "Unable to connect.",
        serverMessage: "Install lark-cli and run lark-cli config init.",
      }),
    );
    fireEvent.click(await enabledButton("Connect Notion"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Install lark-cli and run lark-cli config init.",
    );
  });

  it("rechecks setup in the same card before connecting any account", async () => {
    await setLanguage("zh-CN");
    const feishuCard = { ...card, connection_auth: { app_key: "feishu_mail" } };
    const install = "npm install -g @larksuite/cli";
    const init = "lark-cli config init --new";
    let state = 0;
    const { connection, decision, runtime } = await setup(
      feishuCard,
      "alice",
      false,
      "active",
      [],
      true,
      (runtime) => {
        const notion = runtime.seed.externalSources.apps.find(
          (app) => app.key === "notion",
        )!;
        runtime.seed.externalSources.apps.push({
          ...notion,
          key: "feishu_mail",
          display_name: "Feishu Mail",
        });
        runtime.server.on("GET", "/v0/external-apps/feishu-mail/setup", () => {
          if (state === 2) return new Response(null, { status: 204 });
          return Response.json(
            {
              error: {
                code:
                  state === 0
                    ? "LARK_CLI_NOT_INSTALLED"
                    : "LARK_CLI_NOT_CONFIGURED",
                message: "Feishu Mail setup required.",
                request_id: "test-setup",
                details: [
                  { field: "command", reason: state === 0 ? install : init },
                ],
              },
            },
            { status: 409 },
          );
        });
      },
    );
    const recheck = zhCN.connectors.feishuCheckAgain;
    expect(
      await screen.findByText(zhCN.connectors.feishuCliMissingTitle),
    ).toBeVisible();
    expect(screen.getByText(install)).toBeVisible();
    expect(screen.queryByText(init)).not.toBeInTheDocument();

    state = 1;
    fireEvent.click(await enabledButton(recheck));
    expect(
      await screen.findByText(zhCN.connectors.feishuCliNotSetUpTitle),
    ).toBeVisible();
    expect(screen.getByText(init)).toBeVisible();
    expect(screen.queryByText(install)).not.toBeInTheDocument();

    state = 2;
    fireEvent.click(await enabledButton(recheck));
    const connect = await enabledButton(
      zhCN.cards.connectApp.replace("{name}", "Feishu Mail"),
    );
    expect(screen.queryByText(init)).not.toBeInTheDocument();
    expect(
      runtime.server.requestsTo("GET", "/v0/external-apps/feishu-mail/setup"),
    ).toHaveLength(3);
    expect(
      runtime.server.requestsTo("POST", "/v0/external-connections"),
    ).toHaveLength(0);
    expect(decision).not.toHaveBeenCalled();

    const open = vi.spyOn(window, "open").mockReturnValue(null);
    runtime.server.on("POST", "/v0/external-connections", () => ({
      ...connection,
      provider: "feishu_mail",
      status: "pending",
      connect_url: "https://connect.example.test/feishu",
    }));
    fireEvent.click(connect);
    await waitFor(() => expect(decision).toHaveBeenCalledOnce());
    expect(
      runtime.server.requestsTo("POST", "/v0/external-connections"),
    ).toHaveLength(1);
    expect(open).toHaveBeenCalledWith(
      "https://connect.example.test/feishu",
      "linger_composio_oauth",
      expect.any(String),
    );
  });

  it("starts a new authorization when the pending link expired", async () => {
    vi.spyOn(window, "open").mockReturnValue({
      opener: null,
    } as unknown as Window);
    const { runtime, decision, connection } = await setup(
      card,
      "alice",
      true,
      "pending",
    );
    vi.spyOn(runtime.client, "getExternalConnection").mockResolvedValue({
      ...connection,
      connect_url: "https://connect.example.test/expired",
      connect_expires_at: "2026-01-01T00:00:00Z",
    });
    const create = vi
      .spyOn(runtime.client, "createExternalConnection")
      .mockResolvedValue({
        ...connection,
        id: "notion-2",
        connect_url: "https://connect.example.test/notion",
      });
    fireEvent.click(await enabledButton("Connect Notion"));
    await waitFor(() =>
      expect(decision).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: "notion-2",
          decision: "approve",
        }),
      ),
    );
    expect(create).toHaveBeenCalledWith("notion");
    await waitFor(() =>
      expect(window.open).toHaveBeenCalledWith(
        "https://connect.example.test/notion",
        "linger_composio_oauth",
        expect.any(String),
      ),
    );
  });

  it("resumes a pending authorization while its link is open", async () => {
    vi.spyOn(window, "open").mockReturnValue({
      opener: null,
    } as unknown as Window);
    const { runtime, decision, connection } = await setup(
      card,
      "alice",
      true,
      "pending",
    );
    vi.spyOn(runtime.client, "getExternalConnection").mockResolvedValue({
      ...connection,
      connect_url: "https://connect.example.test/resume",
      connect_expires_at: "2999-01-01T00:00:00Z",
    });
    const create = vi.spyOn(runtime.client, "createExternalConnection");
    fireEvent.click(await enabledButton("Connect Notion"));
    await waitFor(() =>
      expect(window.open).toHaveBeenCalledWith(
        "https://connect.example.test/resume",
        "linger_composio_oauth",
        expect.any(String),
      ),
    );
    expect(decision).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: connection.id }),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("lists only usable accounts and offers a new account", async () => {
    vi.spyOn(window, "open").mockReturnValue({
      opener: null,
    } as unknown as Window);
    const { runtime, decision, connection } = await setup(
      card,
      "alice",
      true,
      "active",
      [
        { id: "notion-pending", status: "pending", identity_label: "" },
        {
          id: "notion-duplicate",
          status: "failed",
          status_error_code: "duplicate_remote_principal",
          identity_label: "Duplicate Notion",
        },
        {
          id: "notion-expired",
          status: "expired",
          identity_label: "Old Notion",
        },
      ],
    );
    const create = vi
      .spyOn(runtime.client, "createExternalConnection")
      .mockResolvedValue({
        ...connection,
        id: "notion-new",
        status: "pending",
        connect_url: "https://connect.example.test/new",
      });
    vi.spyOn(runtime.client, "getExternalConnection").mockResolvedValue({
      ...connection,
      id: "notion-pending",
      status: "pending",
      connect_url: "https://connect.example.test/old",
      connect_expires_at: "2026-01-01T00:00:00Z",
    });
    const picker = await screen.findByRole("combobox", {
      name: "Notion account",
    });
    expect(picker).toHaveTextContent("Alice's Notion");
    fireEvent.click(picker);
    const options = (await screen.findAllByRole("option")).map(
      (option) => option.textContent,
    );
    expect(options).toEqual([
      "Alice's Notion",
      "Old Notion (needs reconnecting)",
      "Connect a new account",
    ]);
    fireEvent.click(
      screen.getByRole("option", { name: "Connect a new account" }),
    );
    fireEvent.click(await enabledButton("Connect Notion"));
    await waitFor(() =>
      expect(decision).toHaveBeenCalledWith(
        expect.objectContaining({ connectionId: "notion-new" }),
      ),
    );
    expect(create).toHaveBeenCalledOnce();
  });

  it("hides the picker for a single account when no new account can be added", async () => {
    await setup(card, "alice", true, "active", [], false);
    expect(
      await screen.findByRole("button", { name: "Allow Project Writer" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("combobox", { name: "Notion account" }),
    ).not.toBeInTheDocument();
  });

  it("offers a new account beside a single account", async () => {
    await setup();
    expect(
      await screen.findByRole("combobox", { name: "Notion account" }),
    ).toHaveTextContent("Alice's Notion");
  });

  it("reuses an open pending connection for a new account", async () => {
    vi.spyOn(window, "open").mockReturnValue({
      opener: null,
    } as unknown as Window);
    const { runtime, decision, connection } = await setup(
      card,
      "alice",
      false,
      "active",
      [{ id: "notion-pending", status: "pending" }],
    );
    vi.spyOn(runtime.client, "getExternalConnection").mockResolvedValue({
      ...connection,
      id: "notion-pending",
      status: "pending",
      connect_url: "https://connect.example.test/open",
      connect_expires_at: "2999-01-01T00:00:00Z",
    });
    const create = vi.spyOn(runtime.client, "createExternalConnection");
    expect(
      screen.queryByRole("combobox", { name: "Notion account" }),
    ).not.toBeInTheDocument();
    fireEvent.click(await enabledButton("Connect Notion"));
    await waitFor(() =>
      expect(window.open).toHaveBeenCalledWith(
        "https://connect.example.test/open",
        "linger_composio_oauth",
        expect.any(String),
      ),
    );
    expect(decision).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "notion-pending" }),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("creates a new connection when the open pending one cannot be read", async () => {
    vi.spyOn(window, "open").mockReturnValue({
      opener: null,
    } as unknown as Window);
    const { runtime, decision, connection } = await setup(
      card,
      "alice",
      false,
      "active",
      [{ id: "notion-pending", status: "pending" }],
    );
    vi.spyOn(runtime.client, "getExternalConnection").mockRejectedValue(
      new Error("gone"),
    );
    const create = vi
      .spyOn(runtime.client, "createExternalConnection")
      .mockResolvedValue({
        ...connection,
        id: "notion-new",
        status: "pending",
        connect_url: "https://connect.example.test/new",
      });
    fireEvent.click(await enabledButton("Connect Notion"));
    await waitFor(() =>
      expect(decision).toHaveBeenCalledWith(
        expect.objectContaining({ connectionId: "notion-new" }),
      ),
    );
    expect(create).toHaveBeenCalledOnce();
  });

  it("shows and preselects the account the Agent asked for", async () => {
    await setup(
      {
        ...card,
        connection_auth: { app_key: "notion", account: "WORK@example.com" },
      },
      "alice",
      true,
      "active",
      [
        {
          id: "notion-work",
          status: "active",
          identity_label: "work@example.com",
        },
      ],
    );
    expect(
      await screen.findByText("Requested account: WORK@example.com"),
    ).toBeVisible();
    expect(
      await screen.findByRole("combobox", { name: "Notion account" }),
    ).toHaveTextContent("work@example.com");
  });

  it("shows an Outlook account as the sign-in name in the picker", async () => {
    await setup(
      { ...card, connection_auth: { app_key: "outlook" } },
      "alice",
      false,
      "active",
      [
        {
          id: "outlook-1",
          provider: "outlook",
          identity_label: "me@example.net",
        },
        {
          id: "outlook-2",
          provider: "outlook",
          identity_label: "other@example.net",
        },
      ],
    );
    expect(
      await screen.findByRole("combobox", { name: /account/ }),
    ).toHaveTextContent("Signed in as me@example.net");
  });

  it("shows a non-Outlook account label as it is in the picker", async () => {
    await setup(card, "alice", true, "active", [
      { id: "notion-2", identity_label: "Second Notion" },
    ]);
    expect(
      await screen.findByRole("combobox", { name: "Notion account" }),
    ).not.toHaveTextContent("Signed in as");
  });

  it("offers a new account when the requested one is not connected", async () => {
    await setup({
      ...card,
      connection_auth: { app_key: "notion", account: "home@example.com" },
    });
    expect(
      await screen.findByRole("combobox", { name: "Notion account" }),
    ).toHaveTextContent("Connect a new account");
    expect(
      screen.getByRole("button", { name: "Connect Notion" }),
    ).toBeVisible();
  });

  it("navigates OAuth only after durable consent is accepted", async () => {
    vi.spyOn(window, "open").mockReturnValue({
      opener: null,
    } as unknown as Window);
    const { runtime, decision, connection } = await setup(card, "alice", false);
    vi.spyOn(runtime.client, "createExternalConnection").mockResolvedValue({
      ...connection,
      status: "pending",
      connect_url: "https://connect.example.test/notion",
    });
    let accept!: () => void;
    decision.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          accept = resolve;
        }),
    );
    fireEvent.click(await enabledButton("Connect Notion"));
    await waitFor(() => expect(decision).toHaveBeenCalledOnce());
    expect(window.open).not.toHaveBeenCalled();
    accept();
    await waitFor(() =>
      expect(window.open).toHaveBeenCalledWith(
        "https://connect.example.test/notion",
        "linger_composio_oauth",
        expect.stringContaining("width=560,height=720"),
      ),
    );
  });

  it("retains the server-bound connection and cancellation after reload", async () => {
    const pending: Card = {
      ...card,
      version: 2,
      status: "authorizing",
      connection_auth: { app_key: "notion", connection_id: "notion-1" },
      answer: { decision: "approve", connection_id: "notion-1" },
      decided_by: card.decision_owner,
      decided_at: "2026-09-14T00:00:00Z",
    };
    vi.spyOn(window, "open").mockReturnValue({
      opener: null,
    } as unknown as Window);
    const { decision } = await setup(pending);
    expect(await screen.findByText("Authorizing…")).toBeVisible();
    fireEvent.click(
      await screen.findByRole("button", { name: "Open authorization window" }),
    );
    expect(window.open).toHaveBeenCalledWith(
      "https://connect.example.test/resume",
      "linger_composio_oauth",
      expect.stringContaining("width=560,height=720"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(decision).toHaveBeenCalledWith(
        expect.objectContaining({ decision: "deny", expectedVersion: 2 }),
      ),
    );
  });

  it("puts a done line in place of the actions rather than accepting a client success claim", async () => {
    const complete: Card = {
      ...card,
      status: "succeeded",
      connection_auth: { app_key: "notion", connection_id: "notion-1" },
      decided_by: card.decision_owner,
      decided_at: "2026-09-14T00:00:00Z",
      answer: { decision: "approve", connection_id: "notion-1" },
    };
    await setup(complete);
    const box = await screen.findByRole("region", {
      name: "App authorization requested",
    });
    expect(box).toHaveTextContent("Notion");
    const line = screen.getByText("Connected");
    expect(line.closest("p")?.querySelector("svg")).toHaveClass(
      "text-app-success",
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it.each([
    ["denied", "Not connected", "text-app-muted"],
    ["failed", "Failed: the sign-in did not complete", "text-app-danger"],
    ["expired", "Expired", "text-app-muted"],
  ] as const)(
    "ends a %s authorization with its own done line",
    async (status, done, tone) => {
      await setup({ ...card, status, decided_by: card.decision_owner }, "bob");
      const line = await screen.findByText(done);
      expect(line.closest("p")?.querySelector("svg")).toHaveClass(tone);
      expect(screen.queryByText(/by Alice/)).not.toBeInTheDocument();
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    },
  );
});
