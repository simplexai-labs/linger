import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { anotherMeQueryKey } from "../room-queries";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";

import { AnotherMeBackgroundFailureBanner } from "./another-me-background-failure-banner";
import {
  clearAllDismissedBackgroundFailures,
  clearDismissedBackgroundFailure,
} from "./another-me-background-failure-dismissal";

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
  const rendered = render(
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
    unmount: rendered.unmount,
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
  afterEach(() => {
    clearAllDismissedBackgroundFailures();
  });

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
    expect(
      screen.getByRole("button", { name: "Dismiss background failure notice" }),
    ).toHaveAttribute("data-voice-close");

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

  it("can be dismissed for the current reason and reappears on a different reason or a new streak", async () => {
    const first = renderBanner({
      ...chat,
      background_failure: {
        consecutive_failures: 5,
        reason: "runtime_incompatible",
      },
    });
    await screen.findByRole("alert");
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss background failure notice" }),
    );
    expect(screen.queryByRole("alert")).toBeNull();

    // Increasing counts under the same reason stay dismissed, including across remounts.
    await first.answer({
      ...chat,
      background_failure: {
        consecutive_failures: 6,
        reason: "runtime_incompatible",
      },
    });
    await waitFor(() => expect(first.read).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alert")).toBeNull();
    first.unmount();

    const remounted = renderBanner({
      ...chat,
      background_failure: {
        consecutive_failures: 6,
        reason: "runtime_incompatible",
      },
    });
    await waitFor(() => expect(remounted.read).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();

    // A different failure reason surfaces immediately.
    await remounted.answer({
      ...chat,
      background_failure: {
        consecutive_failures: 7,
        reason: "runtime_auth_required",
      },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Background tasks failed 7 times in a row: your Runtime needs you to sign in again.",
    );

    // Dismissing, clearing the streak (as RoomShell does), and hitting a new streak shows the banner again.
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss background failure notice" }),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    clearDismissedBackgroundFailure("tenant-1", "room-another-me");
    await remounted.answer(chat);
    await waitFor(() => expect(remounted.read).toHaveBeenCalledTimes(3));
    await remounted.answer({
      ...chat,
      background_failure: {
        consecutive_failures: 3,
        reason: "runtime_auth_required",
      },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Background tasks failed 3 times in a row: your Runtime needs you to sign in again.",
    );
  });

  it("reappears at count 3 when the streak clears while unmounted and restarts", async () => {
    const first = renderBanner({
      ...chat,
      background_failure: {
        consecutive_failures: 3,
        reason: "runtime_unavailable",
      },
    });
    await screen.findByRole("alert");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Dismiss background failure notice",
      }),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    first.unmount();

    // RoomShell observes the cleared streak while the Human is in another Room.
    clearDismissedBackgroundFailure("tenant-1", "room-another-me");

    renderBanner({
      ...chat,
      background_failure: {
        consecutive_failures: 3,
        reason: "runtime_unavailable",
      },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Background tasks failed 3 times in a row",
    );
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
