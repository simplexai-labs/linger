import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { TeamHubMessageActivityRecord } from "@/features/teamhub/teamhub-types";

import { RuntimeTrajectoryView } from "./runtime-trajectory-view";

describe("RuntimeTrajectoryView", () => {
  it("shows each Codex call with what it acted on and opens to its output", () => {
    const records = [
      codex(0, "reasoning", "response_item.reasoning", {
        summary: [{ text: "**Checking the tests**", type: "summary_text" }],
        type: "reasoning",
      }),
      codex(1, "tool_call", "response_item.function_call", {
        arguments: JSON.stringify({ cmd: "pnpm test" }),
        call_id: "c1",
        name: "exec_command",
        type: "function_call",
      }),
      codex(2, "tool_result", "response_item.function_call_output", {
        call_id: "c1",
        output: "12 passed",
        type: "function_call_output",
      }),
      codex(3, "tool_call", "response_item.custom_tool_call", {
        call_id: "c2",
        input:
          "*** Begin Patch\n*** Update File: notes.md\n@@\n-old line\n+new line\n*** End Patch",
        name: "apply_patch",
        type: "custom_tool_call",
      }),
      codex(4, "tool_result", "response_item.custom_tool_call_output", {
        call_id: "c2",
        output: "Success",
        type: "custom_tool_call_output",
      }),
      codex(5, "tool_call", "response_item.web_search_call", {
        action: { query: "vitest docs", type: "search" },
        status: "completed",
        type: "web_search_call",
      }),
      codex(6, "message", "response_item.message", {
        content: [{ text: "All **green**.", type: "output_text" }],
        role: "assistant",
        type: "message",
      }),
    ];

    render(<RuntimeTrajectoryView live records={records} />);

    expect(screen.getByText("Checking the tests")).toBeVisible();
    const ran = screen.getByTitle("Ran pnpm test");
    fireEvent.click(ran);
    expect(ran.closest("details")).toHaveAttribute("open");
    expect(screen.getByText("12 passed")).toBeVisible();
    const edited = screen.getByTitle("Edited notes.md");
    fireEvent.click(edited);
    expect(screen.getByText("-old line")).toHaveClass("text-app-danger");
    expect(screen.getByText("+new line")).toHaveClass("text-app-success");
    expect(screen.queryByText("*** Begin Patch")).not.toBeInTheDocument();
    // A hosted search has no result record; its own status settles it.
    expect(screen.getByTitle("Searched vitest docs")).not.toHaveClass(
      "town-shimmer-text",
    );
    expect(screen.getByText("green").tagName).toBe("STRONG");
    // The reply reads as the turn's prose, not a chat bubble among its steps.
    expect(
      screen.getByText("green").closest(".room-message-bubble"),
    ).toBeNull();
    fireEvent.click(ran);
    expect(ran.closest("details")).not.toHaveAttribute("open");
  });

  it("splits Claude Code messages into calls and leaves private thinking out", () => {
    const records = [
      claude(0, "assistant", [
        { signature: "s", thinking: "private", type: "thinking" },
        {
          id: "t1",
          input: { command: "ls docs" },
          name: "Bash",
          type: "tool_use",
        },
        {
          id: "t2",
          input: {
            file_path: "docs/a.md",
            new_string: "Hello",
            old_string: "Hi",
          },
          name: "Edit",
          type: "tool_use",
        },
        {
          id: "t3",
          input: { path: "src", pattern: "TODO" },
          name: "Grep",
          type: "tool_use",
        },
      ]),
      claude(1, "user", [
        { content: "a.md\nb.md", tool_use_id: "t1", type: "tool_result" },
      ]),
      claude(2, "assistant", [{ text: "Updated a.md.", type: "text" }]),
    ];

    render(<RuntimeTrajectoryView live={false} records={records} />);

    expect(screen.queryByText(/private/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Thinking recorded/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Ran ls docs"));
    expect(screen.getByText(/a\.md\s+b\.md/)).toBeVisible();
    fireEvent.click(screen.getByTitle("Edited docs/a.md"));
    expect(screen.getByText("-Hi")).toBeVisible();
    expect(screen.getByText("+Hello")).toBeVisible();
    expect(screen.getByTitle("Searched TODO in src")).toBeVisible();
    expect(screen.getByText("Updated a.md.")).toBeVisible();
  });

  it("reads Pi tool calls and marks a call without a result pending only while live", () => {
    const records = [
      pi(0, "message", "assistant", {
        content: [
          { text: "Looking first.", type: "text" },
          {
            arguments: { command: "ls" },
            id: "p1",
            name: "bash",
            type: "toolCall",
          },
          {
            arguments: { newText: "two", oldText: "one", path: "notes.md" },
            id: "p2",
            name: "edit",
            type: "toolCall",
          },
        ],
        role: "assistant",
      }),
      pi(1, "tool_result", "toolResult", {
        content: [{ text: "readme.txt", type: "text" }],
        role: "toolResult",
        toolCallId: "p1",
        toolName: "bash",
      }),
    ];

    const { rerender } = render(
      <RuntimeTrajectoryView live records={records} />,
    );

    expect(screen.getByText("Looking first.")).toBeVisible();
    fireEvent.click(screen.getByTitle("Ran ls"));
    expect(screen.getByText("readme.txt")).toBeVisible();
    expect(screen.getByTitle("Ran ls")).not.toHaveClass("town-shimmer-text");
    expect(screen.getByTitle("Edited notes.md")).toHaveClass(
      "town-shimmer-text",
    );
    rerender(<RuntimeTrajectoryView live={false} records={records} />);
    expect(screen.getByTitle("Edited notes.md")).not.toHaveClass(
      "town-shimmer-text",
    );
  });

  it("renders Pi powershell calls as shell commands", () => {
    const records = [
      pi(0, "message", "assistant", {
        content: [
          {
            arguments: { command: "Get-ChildItem" },
            id: "ps1",
            name: "powershell",
            type: "toolCall",
          },
        ],
        role: "assistant",
      }),
      pi(1, "tool_result", "toolResult", {
        content: [{ text: "notes.md", type: "text" }],
        role: "toolResult",
        toolCallId: "ps1",
        toolName: "powershell",
      }),
    ];

    render(<RuntimeTrajectoryView live={false} records={records} />);

    const ran = screen.getByTitle("Ran Get-ChildItem");
    fireEvent.click(ran);
    expect(screen.getByText("notes.md")).toBeVisible();
  });

  it("reads Antigravity PLANNER_RESPONSE tool calls and assistant prose", () => {
    const records: TeamHubMessageActivityRecord[] = [
      {
        category: "message",
        native_record: {
          content: "Inspect the repo",
          step_index: 0,
          type: "USER_INPUT",
        },
        native_type: "USER_INPUT",
        ordinal: 0,
        redacted_fields: [],
        role: "user",
        turn_id: "step-0",
      },
      {
        category: "tool_call",
        native_record: {
          content: "Checking the workspace.",
          step_index: 1,
          tool_calls: [
            {
              args: { CommandLine: JSON.stringify("git status") },
              id: "agy-1",
              name: "run_command",
            },
            {
              args: { AbsolutePath: "docs/guide.md" },
              id: "agy-2",
              name: "view_file",
            },
            {
              args: { DirectoryPath: JSON.stringify("src") },
              id: "agy-3",
              name: "list_dir",
            },
            {
              args: {
                Query: JSON.stringify("antigravity"),
                SearchPath: JSON.stringify("apps"),
              },
              id: "agy-4",
              name: "grep_search",
            },
            {
              args: {
                Path: JSON.stringify("docs/notes.md"),
                Replacement: JSON.stringify("updated line"),
                Target: JSON.stringify("stale line"),
              },
              id: "agy-5",
              name: "edit_file",
            },
            {
              args: {
                Content: JSON.stringify("hello world"),
                Path: JSON.stringify("docs/new.md"),
              },
              id: "agy-6",
              name: "write_file",
            },
          ],
          type: "PLANNER_RESPONSE",
        },
        native_type: "PLANNER_RESPONSE",
        ordinal: 1,
        redacted_fields: [],
        role: "assistant",
        tool_call_id: "agy-1",
        tool_name: "run_command",
        turn_id: "step-1",
      },
      {
        category: "tool_result",
        native_record: {
          content: "nothing to commit",
          step_index: 2,
          tool_call_id: "agy-1",
          type: "GENERIC",
        },
        native_type: "GENERIC",
        ordinal: 2,
        redacted_fields: [],
        tool_call_id: "agy-1",
        turn_id: "step-2",
      },
    ];

    render(<RuntimeTrajectoryView live={false} records={records} />);

    expect(screen.getByText("Checking the workspace.")).toBeVisible();
    expect(screen.getByTitle("Ran git status")).toBeVisible();
    expect(screen.getByTitle("Read docs/guide.md")).toBeVisible();
    expect(screen.getByTitle("Listed src")).toBeVisible();
    expect(screen.getByTitle("Searched antigravity in apps")).toBeVisible();
    fireEvent.click(screen.getByTitle("Edited docs/notes.md"));
    expect(screen.getByText("-stale line")).toHaveClass("text-app-danger");
    expect(screen.getByText("+updated line")).toHaveClass("text-app-success");
    fireEvent.click(screen.getByTitle("Wrote docs/new.md"));
    expect(screen.getByText("+hello world")).toHaveClass("text-app-success");
  });
});

function codex(
  ordinal: number,
  category: TeamHubMessageActivityRecord["category"],
  nativeType: string,
  payload: Record<string, unknown>,
): TeamHubMessageActivityRecord {
  return {
    category,
    native_record: { payload, type: nativeType.split(".")[0] },
    native_type: nativeType,
    ordinal,
    redacted_fields: [],
    turn_id: "turn-codex",
    ...(payload.role ? { role: payload.role as string } : {}),
    ...(typeof payload.call_id === "string"
      ? { tool_call_id: payload.call_id }
      : {}),
    ...(typeof payload.name === "string" ? { tool_name: payload.name } : {}),
  };
}

function claude(
  ordinal: number,
  role: "assistant" | "user",
  content: Record<string, unknown>[],
): TeamHubMessageActivityRecord {
  return {
    category: "message",
    native_record: { message: { content, role }, type: role },
    native_type: role,
    ordinal,
    redacted_fields: [],
    role,
    turn_id: "turn-claude",
  };
}

function pi(
  ordinal: number,
  category: TeamHubMessageActivityRecord["category"],
  role: string,
  message: Record<string, unknown>,
): TeamHubMessageActivityRecord {
  return {
    category,
    native_record: { id: `pi-${ordinal}`, message, type: "message" },
    native_type: "message",
    ordinal,
    redacted_fields: [],
    role,
    turn_id: `pi-${ordinal}`,
    ...(typeof message.toolCallId === "string"
      ? {
          tool_call_id: message.toolCallId,
          tool_name: message.toolName as string,
        }
      : {}),
  };
}
