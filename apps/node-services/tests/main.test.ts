import { afterEach, describe, expect, it, vi } from "vitest";

const lifecycleState = vi.hoisted(() => ({
  controller: new AbortController(),
  close: undefined as (() => Promise<void>) | undefined,
  events: [] as string[],
  startMemory: vi.fn(),
  startLlmWiki: vi.fn(),
  startAgent: vi.fn(),
  startVoice: vi.fn(),
  startDocument: vi.fn(),
}));

vi.mock("../src/process-lifecycle.js", () => ({
  SHUTDOWN_TIMEOUT_MS: 1_000,
  runServiceProcess: async (
    start: (control: {
      signal: AbortSignal;
      progress: () => void;
      onExit: () => void;
    }) => Promise<{ close(): Promise<void> }>,
  ) => {
    const running = await start({
      signal: lifecycleState.controller.signal,
      progress: () => undefined,
      onExit: () => undefined,
    });
    lifecycleState.close = running.close;
  },
}));

vi.mock("../src/http-host.js", () => ({
  startHttpHost: async () => ({
    url: "http://127.0.0.1:0",
    finishStartup: () => lifecycleState.events.push("http:finishStartup"),
    close: async () => {
      lifecycleState.events.push("http:close");
    },
  }),
}));

vi.mock("../src/model-packages.js", () => ({
  pruneModelPackages: async () => [],
}));

vi.mock("../src/memory/main.js", () => ({
  startMemoryService: (...args: unknown[]) =>
    lifecycleState.startMemory(...args),
}));

vi.mock("../src/llm-wiki/service.js", () => ({
  startLlmWikiService: (...args: unknown[]) =>
    lifecycleState.startLlmWiki(...args),
}));

vi.mock("../src/agent/main.js", () => ({
  startAgentService: (...args: unknown[]) => lifecycleState.startAgent(...args),
}));

vi.mock("../src/voice/service.js", () => ({
  startVoiceService: (...args: unknown[]) => lifecycleState.startVoice(...args),
}));

vi.mock("../src/document/main.js", () => ({
  startDocumentService: (...args: unknown[]) =>
    lifecycleState.startDocument(...args),
}));

import { main, readHttpAddress, selectRoles } from "../src/main.js";

function resetRoleMocks(): void {
  lifecycleState.controller = new AbortController();
  lifecycleState.close = undefined;
  lifecycleState.events.length = 0;
  lifecycleState.startMemory.mockReset().mockImplementation(async () => {
    lifecycleState.events.push("memory:start");
    return {
      flashback: {},
      started: () => lifecycleState.events.push("memory:started"),
      stopping: () => lifecycleState.events.push("memory:stopping"),
      stop: async () => {
        lifecycleState.events.push("memory:stop");
      },
    };
  });
  lifecycleState.startLlmWiki.mockReset().mockImplementation(async () => {
    lifecycleState.events.push("llm-wiki:start");
    return {
      stop: async () => {
        lifecycleState.events.push("llm-wiki:stop");
      },
    };
  });
  lifecycleState.startAgent.mockReset().mockImplementation(async () => {
    lifecycleState.events.push("agent:start");
    return {
      modelCall: {},
      stop: async () => {
        lifecycleState.events.push("agent:stop");
      },
    };
  });
  lifecycleState.startVoice.mockReset().mockImplementation(async () => {
    lifecycleState.events.push("voice:start");
    return {
      stop: async () => {
        lifecycleState.events.push("voice:stop");
      },
    };
  });
  lifecycleState.startDocument.mockReset().mockImplementation(async () => {
    lifecycleState.events.push("document:start");
    return {
      stop: async () => {
        lifecycleState.events.push("document:stop");
      },
    };
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetRoleMocks();
});

describe("selectRoles", () => {
  it("starts every role when NODE_SERVICES_ROLES is unset or empty", () => {
    const all = ["memory", "llm-wiki", "agent", "voice", "document"];
    expect(selectRoles(undefined)).toEqual(all);
    expect(selectRoles(" , ")).toEqual(all);
  });

  it("keeps the host's start order without duplicates", () => {
    expect(selectRoles("agent, llm-wiki, memory,llm-wiki")).toEqual([
      "memory",
      "llm-wiki",
      "agent",
    ]);
  });

  it("rejects unknown roles", () => {
    expect(() => selectRoles("memory,skill-indexer")).toThrow(
      "NODE_SERVICES_ROLES contains unknown roles: skill-indexer",
    );
  });
});

describe("readHttpAddress", () => {
  it("defaults to the loopback listener on 4319", () => {
    expect(readHttpAddress({})).toEqual({ host: "127.0.0.1", port: 4319 });
  });

  it("reads host:port, [ipv6]:port and :port for every interface", () => {
    expect(
      readHttpAddress({ NODE_SERVICES_HTTP_ADDRESS: "10.0.0.5:5000" }),
    ).toEqual({ host: "10.0.0.5", port: 5000 });
    expect(
      readHttpAddress({ NODE_SERVICES_HTTP_ADDRESS: "[::1]:5000" }),
    ).toEqual({ host: "::1", port: 5000 });
    expect(readHttpAddress({ NODE_SERVICES_HTTP_ADDRESS: ":5000" })).toEqual({
      host: "0.0.0.0",
      port: 5000,
    });
  });

  it("allows an ephemeral port only in tests", () => {
    expect(
      readHttpAddress({
        NODE_ENV: "test",
        NODE_SERVICES_HTTP_ADDRESS: "127.0.0.1:0",
      }),
    ).toEqual({ host: "127.0.0.1", port: 0 });
    for (const value of ["127.0.0.1:0", "127.0.0.1:4.5", "4319"])
      expect(() =>
        readHttpAddress({ NODE_SERVICES_HTTP_ADDRESS: value }),
      ).toThrow(
        "NODE_SERVICES_HTTP_ADDRESS must be host:port with a port between 1 and 65535",
      );
  });
});

describe("main startup orchestration", () => {
  it("starts document eagerly, gates TeamHub-dependent roles once when waitForTeamHub is enabled, and stops in reverse order", async () => {
    resetRoleMocks();
    vi.stubEnv("NODE_SERVICES_ROLES", "memory,llm-wiki,agent,voice,document");
    vi.stubEnv("NODE_ENV", "test");

    let releaseTeamHub!: () => void;
    const teamHubGate = new Promise<void>((resolve) => {
      releaseTeamHub = resolve;
    });
    let releaseDocument!: () => void;
    const documentGate = new Promise<void>((resolve) => {
      releaseDocument = resolve;
    });
    const waitForTeamHubReady = vi.fn(async () => {
      lifecycleState.events.push("teamhub:wait:start");
      await teamHubGate;
      lifecycleState.events.push("teamhub:wait:done");
    });
    lifecycleState.startDocument.mockImplementation(async () => {
      lifecycleState.events.push("document:start");
      await documentGate;
      lifecycleState.events.push("document:ready");
      return {
        stop: async () => {
          lifecycleState.events.push("document:stop");
        },
      };
    });

    const startup = main({
      waitForTeamHub: true,
      waitForTeamHubReady,
    });

    // Document, memory, and llm-wiki all begin before TeamHub becomes ready.
    await vi.waitFor(() =>
      expect(lifecycleState.events).toContain("teamhub:wait:start"),
    );
    expect(lifecycleState.events).toEqual([
      "document:start",
      "memory:start",
      "llm-wiki:start",
      "teamhub:wait:start",
    ]);
    expect(lifecycleState.startAgent).not.toHaveBeenCalled();
    expect(lifecycleState.startVoice).not.toHaveBeenCalled();

    releaseDocument();
    releaseTeamHub();
    await startup;

    expect(waitForTeamHubReady).toHaveBeenCalledOnce();
    expect(lifecycleState.events.indexOf("agent:start")).toBeGreaterThan(
      lifecycleState.events.indexOf("teamhub:wait:done"),
    );
    expect(lifecycleState.events.indexOf("voice:start")).toBeGreaterThan(
      lifecycleState.events.indexOf("agent:start"),
    );
    expect(lifecycleState.events.at(-2)).toBe("memory:started");
    expect(lifecycleState.events.at(-1)).toBe("http:finishStartup");

    // Reverse shutdown order: document stops before agent, llm-wiki, memory.
    lifecycleState.events.length = 0;
    await lifecycleState.close?.();
    const nonVoiceStops = lifecycleState.events.filter(
      (entry) => entry !== "voice:stop",
    );
    expect(nonVoiceStops).toEqual([
      "memory:stopping",
      "document:stop",
      "agent:stop",
      "llm-wiki:stop",
      "memory:stop",
      "http:close",
    ]);
    expect(lifecycleState.events).toContain("voice:stop");
  });

  it("gates voice when agent is unselected and skips waiting when disabled or no TeamHub role is selected", async () => {
    resetRoleMocks();
    vi.stubEnv("NODE_ENV", "test");

    // Voice-only with waitForTeamHub: true waits once before voice.
    vi.stubEnv("NODE_SERVICES_ROLES", "voice");
    const waitVoice = vi.fn(async () => {
      lifecycleState.events.push("teamhub:wait");
    });
    await main({ waitForTeamHub: true, waitForTeamHubReady: waitVoice });
    expect(waitVoice).toHaveBeenCalledOnce();
    expect(lifecycleState.events.slice(0, 2)).toEqual([
      "teamhub:wait",
      "voice:start",
    ]);
    await lifecycleState.close?.();

    // Non-TeamHub roles only with waitForTeamHub: true never wait.
    resetRoleMocks();
    vi.stubEnv("NODE_SERVICES_ROLES", "memory,llm-wiki,document");
    const waitNonTeamHub = vi.fn(async () => undefined);
    await main({ waitForTeamHub: true, waitForTeamHubReady: waitNonTeamHub });
    expect(waitNonTeamHub).not.toHaveBeenCalled();
    await lifecycleState.close?.();

    // Direct call without waitForTeamHub does not wait even for agent and voice.
    resetRoleMocks();
    vi.stubEnv("NODE_SERVICES_ROLES", "agent,voice");
    const waitDisabled = vi.fn(async () => undefined);
    await main({ waitForTeamHubReady: waitDisabled });
    expect(waitDisabled).not.toHaveBeenCalled();
    await lifecycleState.close?.();
  });

  it("stops an in-flight eager document worker without leaking when an earlier role fails", async () => {
    resetRoleMocks();
    vi.stubEnv("NODE_SERVICES_ROLES", "memory,agent,document");
    vi.stubEnv("NODE_ENV", "test");

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let releaseDocument!: () => void;
      const documentGate = new Promise<void>((resolve) => {
        releaseDocument = resolve;
      });
      const documentStop = vi.fn(async () => {
        lifecycleState.events.push("document:stop");
      });
      lifecycleState.startDocument.mockImplementation(async () => {
        lifecycleState.events.push("document:start");
        await documentGate;
        return { stop: documentStop };
      });
      lifecycleState.startAgent.mockImplementation(async () => {
        lifecycleState.events.push("agent:fail");
        // Release document asynchronously so cleanup must await the in-flight worker.
        setTimeout(() => releaseDocument(), 15);
        throw new Error("agent bootstrap failed");
      });

      await expect(main()).rejects.toThrow("agent bootstrap failed");
      expect(documentStop).toHaveBeenCalledOnce();
      expect(lifecycleState.events).toContain("memory:stop");
      expect(lifecycleState.events).toContain("document:stop");
      expect(lifecycleState.events).toContain("http:close");
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("stops an eager document worker and earlier roles when aborted during TeamHub health wait", async () => {
    resetRoleMocks();
    vi.stubEnv("NODE_SERVICES_ROLES", "memory,llm-wiki,agent,voice,document");
    vi.stubEnv("NODE_ENV", "test");

    let releaseDocument!: () => void;
    const documentGate = new Promise<void>((resolve) => {
      releaseDocument = resolve;
    });
    const documentStop = vi.fn(async () => {
      lifecycleState.events.push("document:stop");
    });
    lifecycleState.startDocument.mockImplementation(async () => {
      lifecycleState.events.push("document:start");
      await documentGate;
      return { stop: documentStop };
    });
    const waitForTeamHubReady = vi.fn(async (signal: AbortSignal) => {
      lifecycleState.events.push("teamhub:wait:start");
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });

    const startup = main({
      waitForTeamHub: true,
      waitForTeamHubReady,
    });
    await vi.waitFor(() =>
      expect(lifecycleState.events).toContain("teamhub:wait:start"),
    );

    const abortReason = new Error("shutdown requested");
    lifecycleState.controller.abort(abortReason);
    setTimeout(() => releaseDocument(), 15);

    await expect(startup).rejects.toBe(abortReason);
    expect(lifecycleState.startAgent).not.toHaveBeenCalled();
    expect(lifecycleState.startVoice).not.toHaveBeenCalled();
    expect(documentStop).toHaveBeenCalledOnce();
    expect(lifecycleState.events).toContain("llm-wiki:stop");
    expect(lifecycleState.events).toContain("memory:stop");
    expect(lifecycleState.events).toContain("http:close");
  });

  it("records eager document settlement duration instead of including later TeamHub wait time", async () => {
    resetRoleMocks();
    vi.stubEnv("NODE_SERVICES_ROLES", "memory,agent,document");
    vi.stubEnv("NODE_ENV", "test");

    let clock = 1_000;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    const lines: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        lines.push(String(chunk));
        return true;
      });

    let resolveDocument!: () => void;
    const documentGate = new Promise<void>((resolve) => {
      resolveDocument = resolve;
    });
    lifecycleState.startDocument.mockImplementation(async () => {
      await documentGate;
      return { stop: async () => undefined };
    });
    const waitForTeamHubReady = vi.fn(async () => {
      // Document finishes at +25ms while TeamHub health wait takes another 500ms.
      clock += 25;
      resolveDocument();
      // Drain all promise microtasks so eagerDocument's .then() captures +25ms
      // before TeamHub's remaining wait advances the clock.
      await new Promise<void>((resolve) => setImmediate(resolve));
      clock += 500;
    });

    try {
      await main({
        waitForTeamHub: true,
        waitForTeamHubReady,
      });
      await lifecycleState.close?.();
    } finally {
      stderrSpy.mockRestore();
      nowSpy.mockRestore();
    }

    const records = lines
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const documentStarted = records.find(
      (record) =>
        record.event === "host.role_started" && record.role === "document",
    );
    expect(documentStarted?.ms).toBe(25);
    const startupTimings = records.find(
      (record) => record.event === "host.startup_timings",
    );
    expect(
      (startupTimings?.roles as Record<string, unknown> | undefined)?.document,
    ).toBe(25);
  });
});
