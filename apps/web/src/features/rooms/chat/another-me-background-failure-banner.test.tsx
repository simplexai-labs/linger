import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { anotherMeQueryKey } from "../room-queries";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";

import { AnotherMeBackgroundFailureBanner } from "./another-me-background-failure-banner";

interface AnotherMe {
  agent_actor_id?: string;
  room_id?: string;
  background_failure?: { consecutive_failures: number; reason: string };
}

function renderBanner(initial: AnotherMe, roomId = "room-another-me") {
  const { client, server } = createTestTeamHubRuntime();
  let current = initial;
  const read = vi.fn(() => current);
  server.on("GET", "/v0/tenants/{tenantId}/another-me", read);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AnotherMeBackgroundFailureBanner
        client={client}
        roomId={roomId}
        tenantId="tenant-1"
      />
    </QueryClientProvider>,
  );
  return {
    read,
    /** What TeamHub answers next, refetched as an another-me hint would. */
    answer: async (next: AnotherMe) => {
      current = next;
      await queryClient.invalidateQueries({
        queryKey: anotherMeQueryKey("tenant-1"),
      });
    },
  };
}

const chat = { agent_actor_id: "actor-another-me", room_id: "room-another-me" };

describe("Another Me background failure banner", () => {
  it("shows nothing while TeamHub reports fewer than three failures", async () => {
    const { read } = renderBanner(chat);
    await waitFor(() => expect(read).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the failures and their reason, then goes after a completed call", async () => {
    const { answer } = renderBanner({
      ...chat,
      background_failure: {
        consecutive_failures: 3,
        reason: "runtime_incompatible",
      },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Background tasks failed 3 times in a row: your Runtime is incompatible, or its model isn't available to your account. Update your local CLI or Linger, or check its model setting.",
    );
    expect(screen.queryByRole("button")).toBeNull();

    await answer({
      ...chat,
      background_failure: {
        consecutive_failures: 4,
        reason: "runtime_auth_required",
      },
    });
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Background tasks failed 4 times in a row: your Runtime needs you to sign in again.",
      ),
    );

    await answer(chat);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("explains an unknown or unrecognized reason without any error text", async () => {
    const { answer } = renderBanner({
      ...chat,
      background_failure: { consecutive_failures: 5, reason: "unknown" },
    });
    const unknown =
      "Background tasks failed 5 times in a row. Wiki, Memory and daily reports may be out of date until a task succeeds.";
    expect(await screen.findByRole("alert")).toHaveTextContent(unknown);

    await answer({
      ...chat,
      background_failure: { consecutive_failures: 5, reason: "future_reason" },
    });
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(unknown),
    );
  });

  it("stays out of every other Room", async () => {
    const { read } = renderBanner(
      {
        ...chat,
        background_failure: { consecutive_failures: 3, reason: "unknown" },
      },
      "room-1",
    );
    await waitFor(() => expect(read).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
