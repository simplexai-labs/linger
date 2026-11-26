import { describe, expect, it } from "vitest";

import type { DecisionCard, WebSearchBackend } from "../api/types";
import { canDecide, keySite, searchKeyBackends } from "./decision-rules";

type Rules = Pick<
  DecisionCard,
  "status" | "kind" | "decision_owner" | "requester"
>;

function card(kind: DecisionCard["kind"], more: Partial<Rules> = {}): Rules {
  return {
    kind,
    status: "pending",
    decision_owner: { id: "owner", kind: "human", display_name: "Ada" },
    requester: { id: "agent", kind: "agent", display_name: "Linger" },
    ...more,
  };
}

describe("who may decide", () => {
  const workspace = new Set(["agent"]);

  it("lets the decision owner answer a pending card", () => {
    expect(canDecide(card("connector_write"), "owner", new Set())).toBe(true);
    expect(
      canDecide(
        card("connector_write", { status: "denied" }),
        "owner",
        workspace,
      ),
    ).toBe(false);
    expect(canDecide(card("connector_write"), undefined, workspace)).toBe(
      false,
    );
  });

  it("lets any member create a Room a workspace Agent asked for", () => {
    expect(canDecide(card("room_creation"), "member", workspace)).toBe(true);
    expect(canDecide(card("room_creation"), "member", new Set())).toBe(false);
    expect(canDecide(card("agent_change"), "member", workspace)).toBe(false);
  });
});

function backend(id: WebSearchBackend["id"]): WebSearchBackend {
  return {
    id,
    name: id,
    description: "A search engine.",
    tier: "key",
    commands: ["search"],
    filters: [],
    max_limit: 10,
    max_sites: 0,
    keyless: false,
    official_key_check: true,
    status: "key_required",
    key_state: "none",
  };
}

describe("search key backends", () => {
  it("shows the card's backend first and other key backends after", () => {
    const { shown, others } = searchKeyBackends(
      ["tavily", "brave", "duckduckgo", "exa", "direct"].map((id) =>
        backend(id as WebSearchBackend["id"]),
      ),
      "brave",
    );
    expect(shown?.id).toBe("brave");
    expect(others.map((item) => item.id)).toEqual(["tavily", "exa"]);
  });

  it("names a key page by host and path", () => {
    expect(keySite("https://www.tavily.com/dashboard/")).toBe(
      "tavily.com/dashboard",
    );
    expect(keySite("https://api.exa.ai")).toBe("api.exa.ai");
  });
});
