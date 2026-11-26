import { describe, expect, it, vi } from "vitest";

import { startLayers, type Module } from "./modules.js";
import { stubModule, testHost } from "./test-support.js";

const names = (layers: readonly (readonly Module[])[]): string[][] =>
  layers.map((layer) => layer.map((m) => m.name).sort());

describe("module host", () => {
  it("starts dependencies first and peers in the same layer", () => {
    expect(
      names(
        startLayers([
          stubModule("RuntimeHost", ["BridgeClient", "WorkspaceGrants"]),
          stubModule("BridgeClient", ["Config"]),
          stubModule("WorkspaceGrants", ["Config"]),
          stubModule("Config"),
        ]),
      ),
    ).toEqual([
      ["Config"],
      ["BridgeClient", "WorkspaceGrants"],
      ["RuntimeHost"],
    ]);
  });

  it("rejects cycles and unknown dependencies", () => {
    expect(() =>
      startLayers([stubModule("A", ["B"]), stubModule("B", ["A"])]),
    ).toThrow(/cycle: A, B/);
    expect(() => startLayers([stubModule("A", ["Missing"])])).toThrow(
      /unknown module Missing/,
    );
  });

  it("stops in reverse order and abandons a stuck module", async () => {
    vi.useFakeTimers();
    try {
      const stopped: string[] = [];
      const module = (name: string, deps: string[], stuck = false): Module => ({
        ...stubModule(name, deps),
        stop: () => {
          stopped.push(name);
          return stuck ? new Promise(() => {}) : Promise.resolve();
        },
      });
      const host = testHost([
        module("Config", []),
        module("BridgeClient", ["Config"], true),
        module("RuntimeHost", ["BridgeClient"]),
      ]);
      await host.start();
      const stopping = host.stop("quit");
      await vi.advanceTimersByTimeAsync(5_000);
      await stopping;
      expect(stopped).toEqual(["RuntimeHost", "BridgeClient", "Config"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops peers in the same layer concurrently after dependents and stays idempotent", async () => {
    const events: string[] = [];
    const peerEntered = new Set<string>();
    let releasePeers!: () => void;
    const peersBarrier = new Promise<void>((resolve) => {
      releasePeers = resolve;
    });

    const host = testHost([
      {
        ...stubModule("Config"),
        stop: async () => {
          events.push("stop:Config");
        },
      },
      {
        ...stubModule("BridgeClient", ["Config"]),
        stop: async () => {
          events.push("begin:BridgeClient");
          peerEntered.add("BridgeClient");
          if (peerEntered.size === 2) releasePeers();
          await peersBarrier;
          events.push("end:BridgeClient");
        },
      },
      {
        ...stubModule("WorkspaceGrants", ["Config"]),
        stop: async () => {
          events.push("begin:WorkspaceGrants");
          peerEntered.add("WorkspaceGrants");
          if (peerEntered.size === 2) releasePeers();
          await peersBarrier;
          events.push("end:WorkspaceGrants");
          throw new Error("peer error");
        },
      },
      {
        ...stubModule("RuntimeHost", ["BridgeClient", "WorkspaceGrants"]),
        stop: async () => {
          events.push("stop:RuntimeHost");
        },
      },
    ]);

    await host.start();
    await host.stop("quit");
    expect(events[0]).toBe("stop:RuntimeHost");
    expect(peerEntered).toEqual(new Set(["BridgeClient", "WorkspaceGrants"]));
    expect(events.at(-1)).toBe("stop:Config");

    // Repeated stop() does not stop already-stopped modules again.
    events.length = 0;
    await host.stop("quit");
    expect(events).toEqual([]);
  });
});
