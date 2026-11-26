import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { LocalRuntimeAuthenticationGuidance } from "./local-runtime-authentication-guidance";

afterEach(cleanup);

it.each([
  ["codex", "Codex", "codex login"],
  ["claude", "Claude Code", "claude auth login"],
  ["pi", "Pi", "pi"],
] as const)(
  "shows %s authentication instructions without claiming expiry",
  (runtimeType, name, command) => {
    render(
      <LocalRuntimeAuthenticationGuidance
        runtimeType={runtimeType}
        computerName="example-computer / acceptance-user"
      />,
    );
    expect(screen.getByText(`${name} sign-in required`)).toBeVisible();
    expect(screen.getByText(command)).toBeVisible();
    expect(screen.getByText(/^Run/)).toHaveTextContent(
      "example-computer / acceptance-user",
    );
    expect(
      screen.queryByText(/expired|recover automatically/),
    ).not.toBeInTheDocument();
    if (runtimeType === "pi")
      expect(screen.getByText("Or enter /login in Pi.")).toBeVisible();
    if (runtimeType !== "claude")
      expect(screen.queryByText("claude auth login")).not.toBeInTheDocument();
  },
);

it.each([
  ["0.59.0", "linger-computer-local-3000 runtime login pi"],
  ["0.58.0", "pi"],
] as const)(
  "shows the sign-in command for a Windows Computer at %s",
  (version, command) => {
    render(
      <LocalRuntimeAuthenticationGuidance
        runtimeType="pi"
        computerName="example-computer"
        computer={{
          computer_id: "c1",
          platform: "win32",
          daemon_version: version,
        }}
      />,
    );
    expect(screen.getByText(command)).toBeVisible();
  },
);
