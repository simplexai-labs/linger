import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DecisionCard, type DecisionMessageCard } from "./decision-card";

type ConnectorView = NonNullable<DecisionMessageCard["connector_write"]>;
type Message = NonNullable<ConnectorView["message"]>;
type AgentView = NonNullable<DecisionMessageCard["agent_change"]>;
interface CardState {
  answer?: { decision: "approve" | "deny"; comment?: string };
  expires_at?: string;
  outcome?: string;
  status?: DecisionMessageCard["status"];
}

const sponsor = {
  display_name: "Leo Xing",
  id: "actor_leo",
  kind: "human" as const,
};
const agent = {
  display_name: "Nova",
  id: "actor_nova",
  kind: "agent" as const,
};
const later = () => new Date(Date.now() + 23 * 3600_000).toISOString();
const longPrompt = Array.from(
  { length: 12 },
  (_, line) => `Step ${line + 1}: review the sources carefully.`,
).join("\n");

function messageDetail(message: Partial<Message> = {}): ConnectorView {
  return {
    account: "alice@example.com",
    app: "gmail",
    input: '{"recipient_email":"bob@example.com","subject":"Launch"}',
    kind: "message",
    message: { body: "Hello Bob", format: "text", ...message },
    title: "Send an email to bob@example.com",
    tool: "GMAIL_SEND_EMAIL",
  };
}

const changeDetail: ConnectorView = {
  account: "ops@example.com",
  app: "notion",
  fields: [
    { label: "Page", value: "page_123" },
    { label: "Property", value: "Status!Done" },
    { label: "Values", value: '[\n  "Name",\n  "Qty"\n]' },
  ],
  input: '{"page_id":"page_123"}',
  kind: "change",
  title: "Update a Notion page",
  tool: "NOTION_UPDATE_PAGE",
};

function createDetail(): AgentView {
  return {
    action: "create",
    agent_name: "Researcher",
    changes: [
      { after: "Researcher", field: "name" },
      { after: "Finds and checks sources.", field: "description" },
      { after: longPrompt, field: "prompt" },
    ],
  };
}

function updateDetail(): AgentView {
  return {
    action: "update",
    agent_name: "Nova",
    changes: [
      { after: "Nova Prime", before: "Nova", field: "name" },
      { after: "Writes release notes.", before: "", field: "description" },
      {
        after: "Write release notes for each launch.",
        before: "Answer questions.",
        field: "prompt",
      },
    ],
    target_actor_id: "actor_nova",
  };
}

function baseCard(title: string, state: CardState) {
  const { answer, expires_at = later(), outcome, status = "pending" } = state;
  return {
    card_type: "personal_notice" as const,
    decision_id: "decision_1",
    decision_owner: sponsor,
    expires_at,
    intent: "decision_requested" as const,
    requester: agent,
    status,
    title,
    version: answer ? 2 : 1,
    ...(outcome ? { outcome } : {}),
    ...(answer
      ? { answer, decided_at: "2026-10-24T02:42:00Z", decided_by: sponsor }
      : {}),
  };
}

function connectorCard(
  view: ConnectorView = messageDetail(),
  state: CardState = {},
): DecisionMessageCard {
  return {
    ...baseCard(view.title, state),
    connector_write: view,
    kind: "connector_write",
  };
}

function agentCard(
  view: AgentView = createDetail(),
  state: CardState = {},
): DecisionMessageCard {
  const title =
    view.action === "create"
      ? `Create Agent “${view.agent_name}”`
      : `Change Agent “${view.agent_name}”`;
  return {
    ...baseCard(title, state),
    agent_change: view,
    kind: "agent_change",
  };
}

function renderCard(
  card: DecisionMessageCard,
  currentActorId = sponsor.id,
  onDecision = vi.fn(),
) {
  const view = render(
    <DecisionCard
      card={card}
      currentActorId={currentActorId}
      messageId="message_1"
      onDecision={onDecision}
      roomId="room_1"
      tenantId="tenant_1"
    />,
  );
  return { ...view, onDecision };
}

function messagePreview() {
  return screen.getByRole("region", { name: "Message preview" });
}

/** Opens the summary row to the kind's full view. */
function openSummary() {
  fireEvent.click(
    within(
      screen.getByRole("region", { name: /request|Room creation/ }),
    ).getAllByRole("button", { expanded: false })[0]!,
  );
}

describe("DecisionCard", () => {
  it("shows the subject and recipient once and expands into a complete email", () => {
    renderCard(
      connectorCard(
        messageDetail({
          attachments: ["plan.pdf", "budget.xlsx"],
          bcc: ["<audit@example.com>"],
          body: "Hello Bob,\n\nThe launch moves to Friday.",
          cc: ["<carol@example.com>", "dan@example.com"],
          subject: "Launch date",
          to: ["<bob@example.com>"],
        }),
      ),
    );

    expect(screen.queryByText(/Asks you|Waiting for/)).not.toBeInTheDocument();
    const box = screen.getByRole("region", { name: "Confirmation request" });
    expect(
      within(box).getByRole("heading", {
        level: 3,
        name: "Launch date",
      }),
    ).toBeVisible();
    expect(screen.getAllByText("Launch date")).toHaveLength(1);
    expect(screen.getAllByText(/bob@example.com/)).toHaveLength(1);
    expect(screen.getByText("To bob@example.com")).toBeVisible();
    expect(screen.queryByText(/alice@example.com/)).not.toBeInTheDocument();
    expect(document.querySelector(".card-prompt")).toBeNull();
    const row = within(box).getByRole("button", { expanded: false });
    expect(row).toHaveAccessibleName("Launch date");
    expect(within(row).getByText("Launch date")).toBeVisible();
    expect(
      within(row).queryByText("To bob@example.com"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add a reason" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Message preview" }),
    ).not.toBeInTheDocument();

    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(row).toHaveAccessibleName("Launch date");
    const preview = messagePreview();
    for (const [label, value] of [
      ["From", "alice@example.com"],
      ["To", "bob@example.com"],
      ["Cc", "carol@example.com, dan@example.com"],
      ["Bcc", "audit@example.com"],
    ] as const) {
      expect(within(preview).getByText(label)).toBeInTheDocument();
      expect(within(preview).getByText(value)).toBeInTheDocument();
    }
    expect(screen.getAllByText("Launch date")).toHaveLength(1);
    expect(
      screen.getByText("To bob@example.com").closest('[aria-hidden="true"]'),
    ).not.toBeNull();
    expect(within(preview).getByTestId("message-body")).not.toHaveClass(
      "max-h-80",
      "overflow-auto",
    );
    expect(within(preview).queryByText("Where")).not.toBeInTheDocument();
    expect(
      within(preview).getByText("Hello Bob,\n\nThe launch moves to Friday.", {
        normalizer: (text) => text,
      }),
    ).toHaveClass("whitespace-pre-wrap");
    const attachments = within(preview).getByRole("list", {
      name: "Attachments",
    });
    expect(
      within(attachments)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["plan.pdf", "budget.xlsx"]);
    // The full call stays under Details.
    expect(screen.queryByText(/Full call/)).not.toBeInTheDocument();

    fireEvent.click(row);
    expect(
      screen.queryByRole("region", { name: "Message preview" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("To bob@example.com")).toBeVisible();
  });

  it("declines email without a reason and blocks repeated decisions while submitting", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { onDecision } = renderCard(
      connectorCard(),
      sponsor.id,
      vi.fn(() => pending),
    );
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add a reason" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Don't send" }));
    expect(onDecision).toHaveBeenCalledExactlyOnceWith({
      decision: "deny",
      expectedVersion: 1,
      feedback: undefined,
      messageId: "message_1",
      requestId: "decision_1",
    });
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Don't send" })).toBeDisabled();
    finish();
    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: "Send" })).toBeEnabled(),
    );
  });

  it("uses the email layout for Outlook and keeps an empty Cc row visible", async () => {
    renderCard(
      connectorCard({
        ...messageDetail({
          to: ["bob@example.com", "Carol <carol@example.com>"],
        }),
        account: "<alice@example.com>",
        app: "outlook",
      }),
    );
    expect(screen.getByRole("heading", { name: /^No subject/ })).toBeVisible();
    expect(
      screen.getByText("To bob@example.com, Carol <carol@example.com>"),
    ).toBeVisible();
    openSummary();
    await vi.waitFor(() => expect(messagePreview()).toBeVisible());
    expect(
      within(messagePreview()).getByText("alice@example.com"),
    ).toBeVisible();
    expect(
      within(messagePreview()).getByText(
        "bob@example.com, Carol <carol@example.com>",
      ),
    ).toBeVisible();
    expect(screen.getByText("Cc")).toBeVisible();
    expect(screen.getByText("None")).toBeVisible();
    expect(screen.queryByText("Bcc")).not.toBeInTheDocument();
  });

  it("names the app by its readable name and falls back to its key", () => {
    const { unmount } = renderCard(
      connectorCard({ ...changeDetail, account: "" }),
    );
    expect(screen.getByText("Notion")).toBeInTheDocument();
    unmount();
    renderCard(connectorCard({ ...changeDetail, account: "me", app: "zoom" }));
    expect(screen.getByText("zoom · me")).toBeInTheDocument();
  });

  it("never repeats the heading's text in the summary row", () => {
    renderCard(connectorCard(changeDetail));
    expect(screen.getAllByText("Update a Notion page")).toHaveLength(1);
    const row = screen.getByRole("button", { expanded: false });
    expect(row).toHaveTextContent("Notion · ops@example.com");
    expect(row).toHaveTextContent("NOTION_UPDATE_PAGE");
  });

  it("renders an HTML body sanitized in a sandboxed frame", () => {
    renderCard(
      connectorCard(
        messageDetail({
          body: '<html><head><style>p{color:red}</style></head><body><p>Hi <b>Bob</b></p><script>alert(1)</script><img src="x" onerror="alert(2)"><a href="javascript:alert(3)">bad</a><a href="https://example.com/doc">doc</a></body></html>',
          format: "html",
        }),
      ),
    );
    openSummary();

    const frame = within(messagePreview()).getByTitle("Message body");
    expect(frame.tagName).toBe("IFRAME");
    const sandbox = frame.getAttribute("sandbox") ?? "";
    expect(sandbox).not.toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-forms");
    const source = frame.getAttribute("srcdoc") ?? "";
    expect(source).toContain("<p>Hi <b>Bob</b></p>");
    expect(source).toContain("p{color:red}");
    expect(source).toContain("Content-Security-Policy");
    expect(source).toContain("padding:16px 0");
    expect(source).not.toMatch(/<script|onerror|javascript:/i);
    expect(source).toContain(
      '<a href="https://example.com/doc" target="_blank" rel="noopener noreferrer">doc</a>',
    );
  });

  it("renders a Markdown body with the Room Markdown renderer", () => {
    renderCard(
      connectorCard({
        ...messageDetail({
          body: "Looks **good** to me.\n\n- first\n- second",
          destination: "Issue #3 in project 12",
          format: "markdown",
        }),
        app: "github",
        title: "Comment on GitHub issue #3",
        tool: "GITHUB_CREATE_AN_ISSUE_COMMENT",
      }),
    );
    openSummary();

    const preview = messagePreview();
    expect(within(preview).getByText("Where")).toBeInTheDocument();
    expect(
      within(preview).getByText("Issue #3 in project 12"),
    ).toBeInTheDocument();
    expect(within(preview).getByText("good").tagName).toBe("STRONG");
    expect(
      within(preview)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["first", "second"]);
    expect(within(preview).queryByText(/\*\*/)).not.toBeInTheDocument();
  });

  it("renders Slack mrkdwn as Slack shows it, not as Markdown", () => {
    renderCard(
      connectorCard({
        ...messageDetail({
          body: [
            "*Deploy* is _done_ ~maybe~ with `v2` &amp; more",
            "See <https://example.com/run?a=1&amp;b=2|the run> or <https://example.com/raw>, cc <@U123|alice> <!here>",
            "# not a heading",
            "**not bold in Slack**",
            "&gt; quoted line",
            "```",
            "npm run *deploy*",
            "```",
          ].join("\n"),
          destination: "Slack #releases",
          format: "mrkdwn",
        }),
        app: "slack",
        title: "Share files in Slack",
        tool: "SLACK_UPLOAD_OR_CREATE_A_FILE_IN_SLACK",
      }),
    );
    openSummary();

    const preview = messagePreview();
    expect(within(preview).getByText("Deploy").tagName).toBe("STRONG");
    expect(within(preview).getByText("done").tagName).toBe("EM");
    expect(within(preview).getByText("maybe").tagName).toBe("DEL");
    expect(within(preview).getByText("v2").tagName).toBe("CODE");
    expect(
      within(preview).getByRole("link", { name: "the run" }),
    ).toHaveAttribute("href", "https://example.com/run?a=1&b=2");
    expect(
      within(preview).getByRole("link", { name: "https://example.com/raw" }),
    ).toHaveAttribute("target", "_blank");
    const body = within(preview).getByTestId("message-body");
    expect(body).toHaveTextContent("with v2 & more");
    expect(body).toHaveTextContent("cc @alice @here");
    expect(
      within(preview).queryByRole("heading", { name: /not a heading/ }),
    ).not.toBeInTheDocument();
    expect(body).toHaveTextContent("# not a heading");
    expect(body).toHaveTextContent("**not bold in Slack**");
    expect(within(preview).getByText("quoted line").tagName).toBe("BLOCKQUOTE");
    const code = within(preview).getByText("npm run *deploy*");
    expect(code.tagName).toBe("CODE");
    expect(code.parentElement?.tagName).toBe("PRE");
  });

  it("shows a change's fields, keeping the lines of multi-line values", () => {
    renderCard(connectorCard(changeDetail));
    openSummary();

    expect(
      screen.queryByRole("region", { name: "Message preview" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Page")).toBeInTheDocument();
    expect(screen.getByText("page_123")).toBeInTheDocument();
    expect(screen.getByText("Status!Done").tagName).toBe("SPAN");
    const values = screen.getByText('[\n  "Name",\n  "Qty"\n]', {
      normalizer: (text) => text,
    });
    expect(values.tagName).toBe("PRE");
    expect(values).toHaveClass("font-mono", "whitespace-pre-wrap");
  });

  it("leaves the raw tool call out when the message or fields show the write", () => {
    renderCard(connectorCard());
    openSummary();
    expect(
      screen.queryByRole("button", { name: "Details" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Full call/)).not.toBeInTheDocument();

    cleanup();
    renderCard(connectorCard(changeDetail));
    openSummary();
    expect(screen.queryByText(/Full call/)).not.toBeInTheDocument();
  });

  it("shows the full call at once for a tool without its own layout", () => {
    renderCard(
      connectorCard({
        account: "octo",
        app: "github",
        input: '{\n  "owner": "linger",\n  "repo": "app"\n}',
        kind: "change",
        title: "Run GITHUB_STAR_A_REPOSITORY_FOR_THE_AUTHENTICATED_USER",
        tool: "GITHUB_STAR_A_REPOSITORY_FOR_THE_AUTHENTICATED_USER",
      }),
    );
    openSummary();
    expect(
      screen.getByText(
        "Full call · GITHUB_STAR_A_REPOSITORY_FOR_THE_AUTHENTICATED_USER",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/"repo": "app"/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Details" }),
    ).not.toBeInTheDocument();
  });

  it("shows a new Agent's name, description, and collapsed instructions", () => {
    renderCard(agentCard());

    expect(
      screen.getByRole("heading", {
        level: 3,
        name: "Create Agent “Researcher”",
      }),
    ).toBeVisible();
    expect(screen.getAllByText("Create Agent “Researcher”")).toHaveLength(1);
    expect(document.querySelector(".card-prompt")).toBeNull();
    const row = screen.getByRole("button", { expanded: false });
    expect(row).toHaveTextContent("New Agent Researcher");
    expect(row).toHaveTextContent("Finds and checks sources.");
    fireEvent.click(row);
    const fields = screen.getByText("Name").closest("dl")!;
    expect(within(fields).getByText("Researcher").tagName).toBe("INS");
    expect(
      within(fields).getByText("Finds and checks sources."),
    ).toBeInTheDocument();
    // A new Agent has nothing to replace.
    expect(fields.querySelector("del")).toBeNull();

    const instructions = screen.getByRole("region", { name: "Instructions" });
    const preview = within(instructions).getByText(/^Step 1:/);
    expect(preview).toHaveClass("line-clamp-4");
    const toggle = screen.getByRole("button", {
      name: "Show full instructions",
    });
    fireEvent.click(toggle);
    expect(preview).not.toHaveClass("line-clamp-4");
    expect(preview).toHaveTextContent("Step 12:");
    expect(screen.getByRole("button", { name: "Create" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Don't create" })).toBeVisible();
  });

  it("shows each current Agent value beside its replacement", () => {
    renderCard(agentCard(updateDetail()));

    expect(
      screen.getByRole("heading", { level: 3, name: "Change Agent “Nova”" }),
    ).toBeVisible();
    expect(screen.getAllByText("Change Agent “Nova”")).toHaveLength(1);
    expect(document.querySelector(".card-prompt")).toBeNull();
    const row = screen.getByRole("button", { expanded: false });
    expect(row).toHaveTextContent("Change Nova");
    expect(row).toHaveTextContent("Name, description, instructions");
    fireEvent.click(row);
    expect(screen.getByText("Nova").tagName).toBe("DEL");
    expect(screen.getByText("Nova Prime").tagName).toBe("INS");
    // An empty description reads as None, not as a blank.
    expect(screen.getByText("None").tagName).toBe("DEL");
    fireEvent.click(
      screen.getByRole("button", { name: "Show full instructions" }),
    );
    expect(
      within(
        screen.getByRole("region", { name: "Current instructions" }),
      ).getByText("Answer questions."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Don't apply" })).toBeVisible();
  });

  it("sends through the decision route", () => {
    const { onDecision } = renderCard(connectorCard());
    expect(screen.getByRole("button", { name: "Send" })).toHaveClass(
      "bg-primary",
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onDecision).toHaveBeenCalledWith({
      decision: "approve",
      expectedVersion: 1,
      feedback: undefined,
      messageId: "message_1",
      requestId: "decision_1",
    });
  });

  it("approves or denies a generic change in plain words", () => {
    const approve = renderCard(connectorCard(changeDetail));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(approve.onDecision).toHaveBeenLastCalledWith(
      expect.objectContaining({ decision: "approve" }),
    );
    approve.unmount();
    const { onDecision } = renderCard(connectorCard(changeDetail));
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onDecision).toHaveBeenLastCalledWith(
      expect.objectContaining({ decision: "deny", feedback: undefined }),
    );
  });

  it("denies with a reason", () => {
    const { onDecision } = renderCard(agentCard());
    fireEvent.click(screen.getByRole("button", { name: "Add a reason" }));
    const reason = screen.getByRole("textbox", { name: "Reason for denying" });
    fireEvent.change(reason, { target: { value: "Wrong recipient" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Deny with this reason" }),
    );
    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "deny",
        expectedVersion: 1,
        feedback: "Wrong recipient",
        requestId: "decision_1",
      }),
    );
  });

  it("shows a failed decision", async () => {
    renderCard(
      connectorCard(),
      sponsor.id,
      vi.fn().mockRejectedValue(new Error("The card changed.")),
    );
    fireEvent.click(screen.getByRole("button", { name: "Don't send" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The card changed.",
    );
  });

  it("shows other members the box without actions or copy", () => {
    renderCard(connectorCard(), "actor_someone_else");
    expect(
      screen.getByRole("region", { name: "Confirmation request" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { expanded: false })).toBeVisible();
    expect(screen.queryByText(/Waiting for|Only /)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "Approval actions" }),
    ).not.toBeInTheDocument();
  });

  it("puts a done line in place of the actions once a request is decided or expired", () => {
    const past = new Date(Date.now() - 3600_000).toISOString();
    const approved = { decision: "approve" as const };
    const cases: {
      card: DecisionMessageCard;
      done: string;
      tone: string;
    }[] = [
      {
        card: connectorCard(messageDetail(), {
          answer: approved,
          status: "approved",
        }),
        done: "Sending…",
        tone: "text-app-muted",
      },
      {
        card: agentCard(createDetail(), {
          answer: approved,
          status: "executing",
        }),
        done: "Creating…",
        tone: "text-app-muted",
      },
      {
        card: agentCard(updateDetail(), {
          answer: approved,
          status: "executing",
        }),
        done: "Applying…",
        tone: "text-app-muted",
      },
      {
        card: connectorCard(messageDetail(), {
          answer: approved,
          status: "succeeded",
        }),
        done: "Sent",
        tone: "text-app-success",
      },
      {
        card: connectorCard(changeDetail, {
          answer: approved,
          status: "succeeded",
        }),
        done: "Done",
        tone: "text-app-success",
      },
      {
        card: agentCard(createDetail(), {
          answer: approved,
          status: "succeeded",
        }),
        done: "Created",
        tone: "text-app-success",
      },
      {
        card: agentCard(updateDetail(), {
          answer: approved,
          status: "succeeded",
        }),
        done: "Applied",
        tone: "text-app-success",
      },
      {
        card: connectorCard(messageDetail(), {
          answer: approved,
          outcome: "The connected account is not active.",
          status: "failed",
        }),
        done: "Failed: The connected account is not active.",
        tone: "text-app-danger",
      },
      {
        card: agentCard(createDetail(), { answer: approved, status: "failed" }),
        done: "Failed",
        tone: "text-app-danger",
      },
      {
        card: connectorCard(messageDetail(), {
          answer: approved,
          outcome: "TeamHub stopped while running this request.",
          status: "unknown",
        }),
        done: "Result unknown: TeamHub stopped while running this request.",
        tone: "text-app-warning",
      },
      {
        card: connectorCard(messageDetail(), {
          answer: { comment: "Wrong recipient", decision: "deny" },
          status: "denied",
        }),
        done: "Not sent · “Wrong recipient”",
        tone: "text-app-muted",
      },
      {
        card: agentCard(createDetail(), {
          answer: { decision: "deny" },
          status: "denied",
        }),
        done: "Not created",
        tone: "text-app-muted",
      },
      {
        card: agentCard(updateDetail(), {
          answer: { decision: "deny" },
          status: "denied",
        }),
        done: "Not applied",
        tone: "text-app-muted",
      },
      {
        card: connectorCard(messageDetail(), {
          expires_at: past,
          status: "expired",
        }),
        done: "Expired",
        tone: "text-app-muted",
      },
      {
        // TeamHub has not expired it yet, but its time is up.
        card: connectorCard(messageDetail(), { expires_at: past }),
        done: "Expired",
        tone: "text-app-muted",
      },
    ];
    for (const { card, done, tone } of cases) {
      const { unmount } = renderCard(card);
      const line = screen.getByText(done);
      expect(line.closest("p")?.querySelector("svg")).toHaveClass(tone);
      // The heading and the collapsed summary row stay.
      expect(
        screen.getByRole("heading", {
          level: 3,
          name: card.connector_write?.message ? "No subject" : card.title,
        }),
      ).toBeVisible();
      expect(document.querySelector(".card-prompt")).toBeNull();
      expect(screen.getByRole("button", { expanded: false })).toBeVisible();
      expect(
        screen.queryByRole("group", { name: "Approval actions" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/approved this|denied this|by Leo/)).toBeNull();
      unmount();
    }
  });

  it("offers Always allow <App> only when connector_write sets can_remember", () => {
    const { onDecision, unmount } = renderCard(
      connectorCard({
        account: "workspace@example.com",
        app: "linear",
        can_remember: true,
        fields: [{ label: "Title", value: "Fix bug" }],
        input: '{"title":"Fix bug"}',
        kind: "change",
        title: "Create Linear issue: Fix bug",
        tool: "LINEAR_CREATE_ISSUE",
      }),
    );

    const alwaysButton = screen.getByRole("button", {
      name: "Always allow Linear",
    });
    expect(alwaysButton).toBeVisible();
    fireEvent.click(alwaysButton);
    expect(onDecision).toHaveBeenCalledWith({
      decision: "approve",
      expectedVersion: 1,
      feedback: undefined,
      messageId: "message_1",
      remember: true,
      requestId: "decision_1",
    });
    unmount();

    renderCard(
      connectorCard({
        account: "workspace@example.com",
        app: "linear",
        can_remember: false,
        fields: [{ label: "Issue", value: "ENG-1" }],
        input: '{"issue_id":"ENG-1"}',
        kind: "change",
        title: "Run LINEAR_DELETE_ISSUE",
        tool: "LINEAR_DELETE_ISSUE",
      }),
    );
    expect(
      screen.queryByRole("button", { name: "Always allow Linear" }),
    ).not.toBeInTheDocument();
  });

  it("renders a 3-button per-app desktop approval card with Window-only capture badge", () => {
    const appCard = (
      overrides: Partial<DecisionMessageCard> = {},
      canRemember = true,
    ): DecisionMessageCard => ({
      card_type: "personal_notice",
      decision_id: "decision_app_1",
      decision_owner: {
        display_name: "Leo",
        id: "actor_leo",
        kind: "human",
      },
      intent: "decision_requested",
      kind: "runtime_permission",
      requester: {
        display_name: "Nova",
        id: "actor_nova",
        kind: "agent",
      },
      runtime_permission: {
        computer_app: {
          app_name: "Safari",
          bundle_id: "com.apple.Safari",
          can_remember: canRemember,
          computer_id: "computer_1",
        },
        input: '{"pid":42}',
        kind: "gui",
        rationale:
          "Window-only capture. Approving lets Nova read and interact with windows belonging to Safari.",
        title: "Allow Nova to control Safari",
        tool: "mcp__computer__get_window_state",
      },
      status: "pending",
      title: "Allow Nova to control Safari",
      version: 1,
      ...overrides,
    });

    const { onDecision, unmount } = renderCard(appCard());
    expect(screen.getByText("Window-only capture")).toBeVisible();
    const taskButton = screen.getByRole("button", {
      name: "Allow for this task",
    });
    const alwaysButton = screen.getByRole("button", {
      name: "Always allow Safari",
    });
    const denyButton = screen.getByRole("button", { name: "Don't allow" });
    expect(taskButton).toBeVisible();
    expect(alwaysButton).toBeVisible();
    expect(denyButton).toBeVisible();

    fireEvent.click(taskButton);
    expect(onDecision).toHaveBeenCalledWith({
      approvalScope: "task",
      decision: "approve",
      expectedVersion: 1,
      feedback: undefined,
      messageId: "message_1",
      remember: undefined,
      requestId: "decision_app_1",
    });
    unmount();

    const { onDecision: onAlwaysDecision, unmount: unmountAlways } =
      renderCard(appCard());
    fireEvent.click(
      screen.getByRole("button", { name: "Always allow Safari" }),
    );
    expect(onAlwaysDecision).toHaveBeenCalledWith({
      approvalScope: "always",
      decision: "approve",
      expectedVersion: 1,
      feedback: undefined,
      messageId: "message_1",
      remember: undefined,
      requestId: "decision_app_1",
    });
    unmountAlways();

    const { unmount: unmountSettled } = renderCard(
      appCard({
        answer: { approval_scope: "always", decision: "approve" },
        expires_at: "2026-12-01T00:00:00Z",
        status: "approved",
      }),
    );
    expect(screen.getByText("Always allowed")).toBeVisible();
    unmountSettled();

    const { unmount: unmountTask } = renderCard(
      appCard({
        answer: { approval_scope: "task", decision: "approve" },
        status: "approved",
      }),
    );
    expect(screen.getByText("Allowed for this task")).toBeVisible();
    unmountTask();

    const { unmount: unmountOnce } = renderCard(
      appCard({
        answer: { approval_scope: "once", decision: "approve" },
        status: "approved",
      }),
    );
    expect(screen.getByText("Allowed once")).toBeVisible();
    unmountOnce();

    const { unmount: unmountLegacy } = renderCard(
      appCard({
        answer: { decision: "approve" },
        status: "approved",
      }),
    );
    expect(screen.getByText("Allowed once")).toBeVisible();
    unmountLegacy();

    renderCard(appCard({}, false));
    expect(
      screen.queryByRole("button", { name: "Always allow Safari" }),
    ).not.toBeInTheDocument();
  });
});
