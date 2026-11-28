import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";

import { ComputerAppGrants } from "./computer-app-grants";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("lists Allowed Desktop Apps and revokes a grant", async () => {
  let grants = [
    {
      agent_actor_id: "actor_nova",
      agent_display_name: "Nova",
      app_name: "Safari",
      bundle_id: "com.apple.Safari",
      computer_id: "computer_1",
      created_at: "2026-11-28T03:00:00Z",
      id: "grant_1",
    },
  ];
  const revoked: string[] = [];
  const client = {
    api: {
      GET: vi.fn(async () => ({
        data: { items: grants },
        response: new Response(null, { status: 200 }),
      })),
      DELETE: vi.fn(
        async (
          _path: string,
          init: { params: { path: { grantId: string } } },
        ) => {
          revoked.push(init.params.path.grantId);
          grants = grants.filter(
            (item) => item.id !== init.params.path.grantId,
          );
          return {
            data: undefined,
            response: new Response(null, { status: 204 }),
          };
        },
      ),
    },
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={{ client } as never}>
        <ComputerAppGrants computerId="computer_1" tenantId="tenant_1" />
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );

  expect(await screen.findByText("Allowed Desktop Apps")).toBeVisible();
  expect(await screen.findByText("Safari")).toBeVisible();
  expect(screen.getByText("Nova · com.apple.Safari")).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Revoke" }));

  await waitFor(() => {
    expect(revoked).toEqual(["grant_1"]);
  });
  expect(
    await screen.findByText(
      "No desktop apps have permanent access yet. Approve an app with Always allow to list it here.",
    ),
  ).toBeVisible();
});
