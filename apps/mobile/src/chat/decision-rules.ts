// Who may answer a decision card, and which web search backends take a key,
// as the web's decision card and search key card decide.
import type {
  DecisionCard,
  WebSearchBackend,
  WebSearchKeyBackend,
} from "../api/types";

/**
 * Whether this Human sees the card's answers: its decision owner, or for a
 * Room creation an Agent visible to the whole workspace asked for, any
 * member of the Room.
 */
export function canDecide(
  card: Pick<DecisionCard, "status" | "kind" | "decision_owner" | "requester">,
  myActorId: string | undefined,
  workspaceAgentIds: ReadonlySet<string>,
): boolean {
  if (card.status !== "pending" || !myActorId) return false;
  if (card.decision_owner.id === myActorId) return true;
  return (
    card.kind === "room_creation" &&
    card.requester.kind === "agent" &&
    workspaceAgentIds.has(card.requester.id)
  );
}

const KEY_BACKENDS: Record<WebSearchKeyBackend, string> = {
  tavily: "Tavily",
  brave: "Brave Search",
  firecrawl: "Firecrawl",
  exa: "Exa",
  you: "You.com",
};

/** A backend's name before the list arrives. */
export function keyBackendName(id: WebSearchKeyBackend): string {
  return KEY_BACKENDS[id];
}

/** A backend that takes an API key saved in the product. */
export function isKeyBackend(
  backend: WebSearchBackend,
): backend is WebSearchBackend & { id: WebSearchKeyBackend } {
  return Object.hasOwn(KEY_BACKENDS, backend.id);
}

/**
 * The backend a search key card shows first, then the other key backends,
 * in TeamHub's order.
 */
export function searchKeyBackends(
  backends: readonly WebSearchBackend[],
  suggested: WebSearchKeyBackend,
): {
  readonly shown: (WebSearchBackend & { id: WebSearchKeyBackend }) | undefined;
  readonly others: (WebSearchBackend & { id: WebSearchKeyBackend })[];
} {
  const keyed = backends.filter(isKeyBackend);
  return {
    shown: keyed.find((backend) => backend.id === suggested),
    others: keyed.filter((backend) => backend.id !== suggested),
  };
}

/** A key page as a short label: host and path, without `www.`. */
export function keySite(keyUrl: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)([^?#]*)/iu.exec(keyUrl);
  if (!match) return keyUrl;
  const host = (match[1] ?? "").replace(/^www\./iu, "");
  return `${host}${(match[2] ?? "").replace(/\/$/u, "")}`;
}
