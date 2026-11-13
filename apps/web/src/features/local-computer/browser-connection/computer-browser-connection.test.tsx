import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubBrowserConnectionStatus,
  TeamHubLocalComputerPage,
} from "@/features/teamhub/teamhub-types";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { teamHubErrorResponse } from "@/test/teamhub-test-server";

import { ComputerBrowserConnection } from "./computer-browser-connection";
import { BrowserConnectionDialog } from "./browser-connection-dialog";

const path =
  "/v0/tenants/{tenantId}/local-computers/{computerId}/browser-connection";

function setup({
  platform,
  variant = "row",
  outdated = false,
  errorCode = "BROWSER_CONNECTION_UNSUPPORTED",
  dialog = false,
  browserState,
}: {
  platform: "linux" | "win32" | "darwin";
  variant?: "chip" | "row";
  outdated?: boolean;
  errorCode?: string;
  dialog?: boolean;
  browserState?: TeamHubBrowserConnectionStatus;
}) {
  const runtime = createTestTeamHubRuntime();
  const computer: TeamHubLocalComputerPage["items"][number] = {
    active_operations: 0,
    available_capacity: 1,
    capacity: 1,
    computer_id: "computer-current",
    daemon_version: outdated ? "0.49.0" : "0.51.0",
    display_name: "Current Computer",
    platform,
    recommended_version: "0.51.0",
    runtimes: [],
    status: "online",
    upgrade_required: false,
    workspace_grants: [],
  };
  runtime.seed.localComputers = [computer];
  runtime.server.on(
    "GET",
    path,
    () => browserState ?? teamHubErrorResponse(409, errorCode),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={runtime}>
        {dialog ? (
          <BrowserConnectionDialog
            computerId={computer.computer_id}
            onClose={() => {}}
            tenantId="tenant-northstar"
          />
        ) : (
          <ComputerBrowserConnection
            computer={computer}
            computerId={computer.computer_id}
            online
            tenantId="tenant-northstar"
            variant={variant}
          />
        )}
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
  return { computer, queryClient, runtime };
}

describe("ComputerBrowserConnection capability failures", () => {
  it.each(["win32", "darwin"] as const)(
    "does not call a current %s Computer outdated or offer an impossible Connect",
    async (platform) => {
      setup({ platform });
      expect(
        await screen.findByText(/Browser connection is not available/),
      ).toBeVisible();
      expect(screen.queryByText(/out of date/i)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    },
  );

  it("explains the Linux platform limit instead of requesting an update", async () => {
    setup({ platform: "linux" });
    expect(await screen.findByText(/not supported on Linux/)).toBeVisible();
    expect(screen.queryByText(/out of date/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  });

  it("does not advertise Connect Chrome after an unsupported capability response", async () => {
    const { queryClient } = setup({ platform: "win32", variant: "chip" });
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(screen.queryByRole("button", { name: "Connect Chrome" })).toBeNull();
  });

  it("keeps genuine version update guidance actionable", async () => {
    setup({ outdated: true, platform: "darwin" });
    expect(await screen.findByText(/Advanced.*Update/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  });

  it("rechecks a transient status failure before offering connection", async () => {
    const { runtime } = setup({
      platform: "darwin",
      errorCode: "BROWSER_CONNECTION_TIMEOUT",
    });
    const retry = await screen.findByRole("button", { name: "Check again" });
    runtime.server.on("GET", path, () => ({
      mode: "isolated",
      platform: "darwin",
      state: "isolated",
    }));
    fireEvent.click(retry);
    expect(
      await screen.findByRole("button", { name: "Connect" }),
    ).toBeVisible();
  });

  it("keeps the repair flow available for a damaged saved connection", async () => {
    setup({ platform: "darwin", errorCode: "BROWSER_CONNECTION_INVALID" });
    expect(
      await screen.findByRole("button", { name: "Connect" }),
    ).toBeVisible();
  });

  it("explains an unsupported success response without offering connection", async () => {
    setup({
      platform: "linux",
      browserState: {
        mode: "isolated",
        platform: "linux",
        state: "unsupported",
      },
    });
    expect(await screen.findByText(/not supported on Linux/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  });

  it("lets a direct connection dialog recheck capability after an update", async () => {
    const { runtime } = setup({ dialog: true, platform: "win32" });
    expect(
      await screen.findByText(/Browser connection is not available/),
    ).toBeVisible();
    expect(screen.queryByLabelText("Extension token")).toBeNull();
    runtime.server.on("GET", path, () => ({
      mode: "isolated",
      platform: "win32",
      state: "isolated",
    }));
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByLabelText("Extension token")).toBeVisible();
  });
});
