import { describe, expect, it } from "vitest";
import { parseTaskCommand } from "./task-command";

describe("parseTaskCommand", () => {
  it("reads the message of task send from --message", () => {
    expect(
      parseTaskCommand(
        'teamhub task send --task-id workitem_1 --message "Add pricing"',
      ),
    ).toEqual({
      message: "Add pricing",
      operation: "send",
      taskId: "workitem_1",
    });
  });

  it("reads a --message-file - message from its quoted heredoc, literally", () => {
    expect(
      parseTaskCommand(
        "teamhub task send --task-id workitem_1 --message-file - --steer <<'EOF'\nKeep $180/store as typed.\n--json is text here.\nEOF",
      ),
    ).toEqual({
      message: "Keep $180/store as typed.\n--json is text here.",
      operation: "send",
      taskId: "workitem_1",
    });
  });

  it("names a Task created from a heredoc requirement", () => {
    expect(
      parseTaskCommand(
        'teamhub task create --name "Rivals" --requirement-file - <<\'EOF\'\nCompare --name "Other"\nEOF',
      ),
    ).toEqual({ name: "Rivals", operation: "create" });
  });

  it("parses Windows teamhub.cmd, teamhub.exe, and full Windows paths", () => {
    expect(parseTaskCommand("teamhub.cmd task create --name 'Check'")).toEqual({
      name: "Check",
      operation: "create",
    });
    expect(
      parseTaskCommand(
        "C:\\Users\\alice\\cli\\teamhub.exe task create --name 'Check'",
      ),
    ).toEqual({
      name: "Check",
      operation: "create",
    });
  });

  it("reads a --message-file - message from a PowerShell single-quoted here-string", () => {
    expect(
      parseTaskCommand(
        "@'\nCheck logs\nKeep $180 & check\n'@ | teamhub.cmd task send --task-id workitem_1 --message-file -",
      ),
    ).toEqual({
      message: "Check logs\nKeep $180 & check",
      operation: "send",
      taskId: "workitem_1",
    });
    expect(
      parseTaskCommand(
        "@'\r\nCheck logs\r\n'@ | teamhub.cmd task send --task-id workitem_1 --message-file -",
      ),
    ).toEqual({
      message: "Check logs",
      operation: "send",
      taskId: "workitem_1",
    });
  });
});
