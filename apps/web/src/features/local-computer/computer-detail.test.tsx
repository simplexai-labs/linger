import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { TeamHubLocalComputerPage } from "@/features/teamhub/teamhub-types";
import { ComputerDetail } from "./computer-detail";

afterEach(() => {
  cleanup();
  delete (window as { lingerDesktop?: unknown }).lingerDesktop;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("uses the target Computer platform for the required update", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  const computer: TeamHubLocalComputerPage["items"][number] = {
    computer_id: "windows",
    display_name: "Windows PC",
    status: "online",
    platform: "win32",
    upgrade_required: true,
    active_operations: 0,
    workspace_grants: [],
    runtimes: [],
  };
  const props = {
    agents: [],
    agentAvailabilities: new Map(),
    onOpenAgent: vi.fn(),
    onRemove: vi.fn(),
  };
  const { unmount } = render(<ComputerDetail {...props} computer={computer} />);
  fireEvent.click(screen.getAllByRole("button", { name: "Update" })[0]!);
  expect(
    screen.getByText(
      "irm 'http://localhost:3000/install/linger-computer.ps1' | iex",
    ),
  ).toBeVisible();
  unmount();

  render(
    <ComputerDetail
      {...props}
      computer={{ ...computer, computer_id: "legacy", platform: undefined }}
    />,
  );
  fireEvent.click(screen.getAllByRole("button", { name: "Update" })[0]!);
  expect(screen.getByRole("combobox")).toHaveValue("");
  expect(screen.queryByText(/linger-computer.ps1/)).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox"), {
    target: { value: "linux" },
  });
  expect(screen.getByText(/curl -fsSL/)).toBeVisible();
});

it("keeps the last reported presentation stable throughout reconnect churn", () => {
  vi.useFakeTimers();
  const computer: TeamHubLocalComputerPage["items"][number] = {
    computer_id: "legacy",
    display_name: "Legacy Computer",
    status: "online",
    upgrade_required: false,
    daemon_version: "0.1.0",
    recommended_version: "0.2.0",
    active_operations: 0,
    capacity: 2,
    workspace_grants: [],
    runtimes: [{ type: "codex", status: "ready", models: [] }],
  };
  const props = {
    agents: [],
    agentAvailabilities: new Map(),
    onOpenAgent: vi.fn(),
    onRemove: vi.fn(),
  };
  const { rerender } = render(
    <ComputerDetail {...props} computer={computer} />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Ready");
  const offline = {
    ...computer,
    status: "offline" as const,
    daemon_version: undefined,
    recommended_version: undefined,
    runtimes: [
      { type: "codex" as const, status: "error" as const, models: [] },
    ],
  };
  for (let iteration = 0; iteration < 3; iteration++) {
    rerender(<ComputerDetail {...props} computer={offline} />);
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    rerender(<ComputerDetail {...props} computer={computer} />);
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Reconnecting");
  }
  rerender(<ComputerDetail {...props} computer={offline} />);
  act(() => {
    vi.advanceTimersByTime(15_000);
  });
  expect(screen.getByRole("status")).toHaveTextContent("Offline");
  // An offline Computer keeps the AI apps and version it last reported.
  expect(screen.getByText("Last seen ready")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
  expect(screen.getByText("0.1.0")).toBeVisible();
  expect(screen.getByText("0.2.0 available")).toBeVisible();
});

it("shows the desktop Prevent sleep switch only for this computer", async () => {
  Object.assign(window, {
    lingerDesktop: {
      computer: {
        getStatus: vi.fn(async () => ({
          bridge: "online",
          runtime: "ready",
          computerId: "this-mac",
          activeOperations: 0,
        })),
        onStatus: vi.fn(() => () => {}),
        enroll: vi.fn(),
      },
      settings: {
        get: vi.fn(async () => ({ preventSleep: false })),
        set: vi.fn(async (patch: { preventSleep: boolean }) => patch),
        onChange: vi.fn(() => () => {}),
      },
    },
  });
  const baseComputer: TeamHubLocalComputerPage["items"][number] = {
    computer_id: "this-mac",
    display_name: "Studio Mac",
    status: "online",
    platform: "darwin",
    upgrade_required: false,
    active_operations: 0,
    workspace_grants: [],
    runtimes: [{ type: "codex", status: "ready", models: [] }],
  };
  const props = {
    agents: [],
    agentAvailabilities: new Map(),
    onOpenAgent: vi.fn(),
  };

  const { rerender } = render(
    <ComputerDetail {...props} computer={baseComputer} />,
  );
  expect(
    await screen.findByRole("switch", { name: "Prevent sleep" }),
  ).toBeVisible();

  rerender(
    <ComputerDetail
      {...props}
      computer={{ ...baseComputer, computer_id: "other-mac" }}
    />,
  );
  expect(screen.queryByRole("switch", { name: "Prevent sleep" })).toBeNull();
});

it("shows agy update instead of the install script when updating an outdated Antigravity CLI", () => {
  const computer: TeamHubLocalComputerPage["items"][number] = {
    computer_id: "mac-1",
    display_name: "Studio Mac",
    status: "online",
    platform: "darwin",
    upgrade_required: false,
    active_operations: 0,
    workspace_grants: [],
    runtimes: [
      {
        type: "antigravity",
        status: "incompatible",
        version: "1.5.9",
        error_code: "RUNTIME_INCOMPATIBLE",
        message: "antigravity version 1.5.9 is below minimum 1.5.12",
        models: [],
      },
    ],
  };
  render(
    <ComputerDetail
      agents={[]}
      agentAvailabilities={new Map()}
      computer={computer}
      onOpenAgent={vi.fn()}
      onRemove={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Update Antigravity" }));
  expect(
    screen.getByRole("dialog", { name: /Update Antigravity/ }),
  ).toBeVisible();
  expect(screen.getAllByText("agy update").length).toBeGreaterThan(0);
  expect(
    screen.queryByText(/antigravity\.google\/cli\/install\.sh/),
  ).not.toBeInTheDocument();
});
