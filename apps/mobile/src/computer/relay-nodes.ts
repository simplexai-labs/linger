// The Relay nodes a phone may reach its computer through. The computer keeps
// a link to every node in its list and names them in the pairing code and in
// each welcome; the phone dials them all and keeps the first session (or only
// the node the Human pinned), trying the fastest it measured first. A computer
// too old to list nodes names one `relay`, which reads as a single node.
/**
 * Accepts a WebSocket origin (`ws://host:port` or `wss://host`) and returns
 * it without a trailing slash; anything with a path, query or credentials is
 * refused so a code cannot point the phone at an arbitrary URL.
 */
export function normalizeOrigin(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match =
    /^(wss?):\/\/([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(:\d{1,5})?\/?$/.exec(
      value.trim(),
    );
  if (!match) return undefined;
  return `${match[1]}://${match[2]}${match[3] ?? ""}`;
}

export interface RelayNode {
  readonly id: string;
  readonly url: string;
  readonly label: string;
}

/** "auto" races every node; a node ID dials only that node. */
export type RelayChoice = string;

/** The part of a paired computer that decides its Relay dials. */
export interface RelaySettings {
  readonly relay: string | null;
  readonly relays?: readonly RelayNode[];
  readonly relayChoice?: RelayChoice;
  /** The last handshake time through each node URL, in milliseconds. */
  readonly relayLatency?: Readonly<Record<string, number>>;
}

function hostOf(url: string): string {
  return url.replace(/^wss?:\/\//, "");
}

/** Reads a node list from a pairing code or welcome; bad entries are dropped. */
export function parseRelayNodes(value: unknown): RelayNode[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const nodes: RelayNode[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const { id, url, label } = item as Record<string, unknown>;
    const origin = normalizeOrigin(url);
    if (typeof id !== "string" || !id || !origin) continue;
    if (nodes.some((node) => node.url === origin)) continue;
    nodes.push({
      id,
      url: origin,
      label: typeof label === "string" && label.trim() ? label : hostOf(origin),
    });
  }
  return nodes;
}

/**
 * The nodes a computer named, or its single legacy Relay as one node. A list
 * the computer sent wins even when empty: it turned every node off.
 */
export function relayNodesOf(settings: RelaySettings): RelayNode[] {
  if (settings.relays) return [...settings.relays];
  return settings.relay
    ? [{ id: "relay", url: settings.relay, label: hostOf(settings.relay) }]
    : [];
}

/**
 * The nodes one connection round dials, in order. A pinned node that is still
 * listed is the only one; otherwise every node, the fastest measured first
 * and unmeasured ones after them in the computer's order.
 */
export function relayDialOrder(settings: RelaySettings): RelayNode[] {
  const nodes = relayNodesOf(settings);
  const pinned = nodes.find((node) => node.id === settings.relayChoice);
  if (pinned) return [pinned];
  const latency = settings.relayLatency ?? {};
  return nodes
    .map((node, index) => ({ node, index, ms: latency[node.url] }))
    .sort((a, b) => {
      if (a.ms !== undefined && b.ms !== undefined) return a.ms - b.ms;
      if (a.ms !== undefined) return -1;
      if (b.ms !== undefined) return 1;
      return a.index - b.index;
    })
    .map((entry) => entry.node);
}

/** Whether two node lists name the same nodes in the same order. */
export function sameRelayNodes(
  a: readonly RelayNode[],
  b: readonly RelayNode[],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (node, index) =>
        node.id === b[index]?.id &&
        node.url === b[index]?.url &&
        node.label === b[index]?.label,
    )
  );
}
