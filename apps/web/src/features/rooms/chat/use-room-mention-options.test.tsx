import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import type { TeamHubRoomMemberPage } from "@/features/teamhub/teamhub-types";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";

import { useRoomMentionOptions } from "./use-room-mention-options";

describe("useRoomMentionOptions", () => {
  it("orders Agents and other collaborators ahead of the current user so @ + Enter never self-mentions", async () => {
    const runtime = createTestTeamHubRuntime();
    const tenantId = runtime.seed.tenant.id;
    const owner = runtime.seed.identity.actors.find(
      (actor) => actor.tenant_id === tenantId,
    )!;
    const teammate = runtime.seed.actors.find(
      (actor) => actor.kind === "human" && actor.id !== owner.id,
    )!;
    const agent = runtime.seed.tenantAgents[0]!.actor;
    const members: TeamHubRoomMemberPage = {
      items: [
        {
          actor: owner,
          added_by: owner,
          joined_at: "2026-10-01T00:00:00Z",
          role: "owner",
          room_id: "room-all",
          updated_at: "2026-10-01T00:00:00Z",
        },
        {
          actor: teammate,
          added_by: owner,
          joined_at: "2026-10-01T00:01:00Z",
          role: "member",
          room_id: "room-all",
          updated_at: "2026-10-01T00:01:00Z",
        },
        {
          actor: agent,
          added_by: owner,
          joined_at: "2026-10-01T00:02:00Z",
          role: "member",
          room_id: "room-all",
          updated_at: "2026-10-01T00:02:00Z",
        },
      ],
      page: { has_more: false },
    };

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(
      () =>
        useRoomMentionOptions({
          client: runtime.client,
          currentActorId: owner.id,
          members,
          tenantId,
        }),
      { wrapper },
    );

    await waitFor(() =>
      expect(result.current.mentionOptions.map((actor) => actor.id)).toEqual([
        agent.id,
        teammate.id,
        owner.id,
      ]),
    );
  });
});
