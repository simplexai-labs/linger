import { describe, expect, it } from "vitest";

import type { TeamHubMessage } from "@/features/teamhub/teamhub-types";

import { pendingDecisionsByRequester } from "./use-room-conversation";

const NOW = Date.parse("2026-11-26T08:00:00Z");

function cardMessage(
  created_at: string,
  card: {
    status?: string;
    owner?: string;
    requester?: string;
    expires_at?: string;
  } = {},
): TeamHubMessage {
  return {
    created_at,
    card: {
      card_type: "personal_notice",
      intent: "decision_requested",
      version: 1,
      decision_id: `d-${created_at}`,
      kind: "computer_permission",
      status: card.status ?? "pending",
      title: "Permission",
      decision_owner: {
        id: card.owner ?? "alice",
        display_name: "Alice",
        kind: "human",
      },
      requester: {
        id: card.requester ?? "agent-1",
        display_name: "Codex",
        kind: "agent",
      },
      ...(card.expires_at ? { expires_at: card.expires_at } : {}),
    },
  } as unknown as TeamHubMessage;
}

describe("pendingDecisionsByRequester", () => {
  it.each([
    ["an answered card", { status: "answered" }],
    ["a card another Human decides", { owner: "bob" }],
    ["an expired card", { expires_at: "2026-11-26T07:59:59Z" }],
  ])("leaves out %s", (_, card) => {
    const result = pendingDecisionsByRequester(
      [cardMessage("2026-11-26T07:00:00Z", card)],
      "alice",
      NOW,
    );
    expect(result.since.size).toBe(0);
  });

  it("leaves out every card when the current Human is unknown", () => {
    const result = pendingDecisionsByRequester(
      [cardMessage("2026-11-26T07:00:00Z")],
      undefined,
      NOW,
    );
    expect(result.since.size).toBe(0);
  });

  it("keeps each Agent's newest pending card and the first lapse", () => {
    const result = pendingDecisionsByRequester(
      [
        cardMessage("2026-11-26T07:30:00Z", {
          expires_at: "2026-11-26T09:00:00Z",
        }),
        cardMessage("2026-11-26T07:00:00Z", {
          expires_at: "2026-11-26T08:30:00Z",
        }),
        cardMessage("2026-11-26T06:00:00Z", { requester: "agent-2" }),
      ],
      "alice",
      NOW,
    );
    expect(Object.fromEntries(result.since)).toEqual({
      "agent-1": "2026-11-26T07:30:00Z",
      "agent-2": "2026-11-26T06:00:00Z",
    });
    expect(result.nextExpiry).toBe(Date.parse("2026-11-26T08:30:00Z"));
  });
});
