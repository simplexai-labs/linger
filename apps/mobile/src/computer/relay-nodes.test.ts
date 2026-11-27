import { describe, expect, it } from "vitest";

import {
  parseRelayNodes,
  relayDialOrder,
  relayNodesOf,
  type RelayNode,
} from "./relay-nodes";

const global: RelayNode = {
  id: "relay_official_global",
  url: "wss://relay.heylinger.com",
  label: "Linger Global",
};
const mainland: RelayNode = {
  id: "relay_official_mainland",
  url: "ws://120.26.232.218:7787",
  label: "Linger Mainland China",
};

describe("parseRelayNodes", () => {
  it("keeps well-formed nodes and drops the rest", () => {
    expect(
      parseRelayNodes([
        global,
        { id: "x", url: "https://example.com", label: "No" },
        { id: "", url: "ws://198.51.100.1:7787", label: "No ID" },
        { id: "c", url: "ws://198.51.100.1:7787/", label: "" },
        { ...global, id: "dup" },
      ]),
    ).toEqual([
      global,
      { id: "c", url: "ws://198.51.100.1:7787", label: "198.51.100.1:7787" },
    ]);
    expect(parseRelayNodes("nope")).toBeUndefined();
  });
});

describe("relayNodesOf", () => {
  it("reads a computer that names one legacy Relay as a single node", () => {
    expect(relayNodesOf({ relay: "wss://relay.heylinger.com" })).toEqual([
      {
        id: "relay",
        url: "wss://relay.heylinger.com",
        label: "relay.heylinger.com",
      },
    ]);
    expect(relayNodesOf({ relay: null })).toEqual([]);
  });
});

describe("relayDialOrder", () => {
  it("tries the fastest measured node first, then the rest in list order", () => {
    expect(
      relayDialOrder({
        relay: global.url,
        relays: [global, mainland],
        relayLatency: { [mainland.url]: 40 },
      }).map((node) => node.id),
    ).toEqual([mainland.id, global.id]);
    expect(
      relayDialOrder({ relay: global.url, relays: [global, mainland] }).map(
        (node) => node.id,
      ),
    ).toEqual([global.id, mainland.id]);
  });

  it("dials only a pinned node while the computer still lists it", () => {
    const settings = {
      relay: global.url,
      relays: [global, mainland],
      relayChoice: global.id,
      relayLatency: { [mainland.url]: 40, [global.url]: 400 },
    };
    expect(relayDialOrder(settings)).toEqual([global]);
    expect(
      relayDialOrder({ ...settings, relayChoice: "relay_gone" }).map(
        (node) => node.id,
      ),
    ).toEqual([mainland.id, global.id]);
  });
});
