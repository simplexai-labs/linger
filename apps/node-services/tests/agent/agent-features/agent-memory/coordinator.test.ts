import { describe, expect, it, vi } from "vitest";
import {
  AgentMemoryCoordinator,
  memoryBudget,
  type AgentMemoryHost,
} from "../../../../src/agent/agent-features/agent-memory/coordinator.js";
import type {
  MemoryClient,
  MemoryDocument,
} from "../../../../src/agent/agent-features/agent-memory/client.js";
import { encodeExecutionContextRef } from "../../../../src/agent/executor/context-ref.js";
import {
  ModelCallError,
  type ModelCall,
  type ModelCallRequest,
} from "../../../../src/runtime-model-call.js";
import {
  TeamHubRuntimeStateError,
  type TeamHubRuntimeStateClient,
} from "../../../../src/agent/executor/teamhub-runtime-state-client.js";
import { modelCallPolicies } from "../../../../src/model-tasks.js";
import { stubModelCall } from "../../../model-call-stub.js";

const OWNER = { tenantId: "tenant-1", ownerActorId: "owner-1" };
const ATTEMPTS = modelCallPolicies.agent_memory.attempts;

const stageOf = (request: ModelCallRequest) =>
  request.schemaName === "memory_extract" ? "extract" : "consolidate";

const validOutput = (request: ModelCallRequest) =>
  stageOf(request) === "extract"
    ? {
        session_summary: "Orchard release is lantern-482",
        raw_memory: "release code lantern-482",
      }
    : {
        summary: "Orchard release",
        edits: [
          {
            op: (
              JSON.parse(request.input) as { memory_sections: string[] }
            ).memory_sections.includes("Releases")
              ? "replace"
              : "add",
            heading: "Releases",
            content: "Release code: lantern-482",
          },
        ],
      };

function fixture(
  options: {
    ghostRuntime?: unknown;
    ghost?: unknown;
    canReadHistory?: (computerId: string, runtimeType: string) => boolean;
    contextWindow?: () => number | undefined;
    inputSequence?: string;
  } = {},
) {
  const clock = { now: 0 };
  const documents = new Map<string, MemoryDocument>();
  let inputSequence = options.inputSequence ?? "1";
  const business = (agentId: string) => ({
    ref: {
      kind: "meta" as const,
      agent_id: agentId,
      room_id: `room-${agentId}`,
    },
    context_key: encodeExecutionContextRef({
      kind: "meta",
      agentId,
      roomId: `room-${agentId}`,
    }),
    next_input_sequence: inputSequence,
  });
  // Maintenance needs no Context lifecycle: the fake host has none.
  const host = {
    getGhost: vi.fn(async () =>
      "ghost" in options
        ? options.ghost
        : {
            runtime: options.ghostRuntime ?? {
              type: "local",
              placement: {
                ...OWNER,
                computerId: "computer-1",
                runtimeType: "codex",
              },
            },
          },
    ),
    subscribeTurnTerminals: () => () => {},
    inspectDebugContextHistory: vi.fn(async () => ({
      status: "available",
      snapshot: {
        id: "snapshot",
        threadId: "thread",
        tailState: "clean",
        recordCount: 1,
      },
      records: [
        {
          ordinal: 0,
          category: "message",
          nativeRecord: {
            role: "user",
            text: "Project Orchard uses release code lantern-482.",
          },
        },
      ],
    })),
  } as unknown as AgentMemoryHost;
  const runtimeState = {
    listContexts: async (id?: string) => [business(id ?? "A")],
    getWorkState: vi.fn(async () => ({ has_pending_work: false })),
  } as unknown as TeamHubRuntimeStateClient;
  const memory = {
    read: vi.fn(async (id: string) =>
      structuredClone(
        documents.get(id) ?? {
          revision: 0,
          summary: "",
          memory: "",
          sessions: {},
          cursors: {},
        },
      ),
    ),
    commit: async (id, document) => {
      if ((documents.get(id)?.revision ?? 0) !== document.revision)
        throw new Error("CAS conflict");
      const next = structuredClone({
        ...document,
        revision: document.revision + 1,
        // PostgreSQL JSONB does not preserve object insertion order.
        sessions: Object.fromEntries(Object.entries(document.sessions).sort()),
      });
      documents.set(id, next);
      return next;
    },
  } satisfies MemoryClient;
  const respond = vi.fn<
    (request: ModelCallRequest) => Promise<Record<string, unknown>>
  >(async (request) => validOutput(request));
  const contextWindow = vi.fn<NonNullable<ModelCall["contextWindow"]>>(
    async () => options.contextWindow?.(),
  );
  // As the call's attempts would: an answer the request's check rejects
  // gets the next attempt, and a thrown failure passes through.
  const modelCall: ModelCall = stubModelCall({
    call: async (request) => {
      for (let attempt = 1; ; attempt += 1) {
        const output = await respond(request);
        const problem = await request.validate?.(output);
        if (problem === undefined) return { output, model: "codex" };
        if (attempt >= ATTEMPTS)
          throw new ModelCallError("invalid_output", problem);
      }
    },
    contextWindow,
  });
  const logger = { log: vi.fn() };
  const coordinator = new AgentMemoryCoordinator({
    host,
    runtimeState,
    logger,
    now: () => clock.now,
    ...(options.canReadHistory
      ? { canReadHistory: options.canReadHistory }
      : {}),
    memory,
    modelCall,
  });
  return {
    coordinator,
    documents,
    memory,
    host,
    runtimeState,
    logger,
    respond,
    contextWindow,
    stages: () => respond.mock.calls.map(([request]) => stageOf(request)),
    receiveInput: () => {
      inputSequence = String(Number(inputSequence) + 1);
    },
    advance: (ms: number) => {
      clock.now += ms;
    },
  };
}

describe("Agent memory lifecycle", () => {
  it.each(["local"])(
    "extracts and publishes Pi memory from %s history",
    async (type) => {
      const f = fixture({
        ghostRuntime: {
          type,
          placement: { runtimeType: "pi", computerId: "computer" },
        },
      });
      try {
        await f.coordinator.wake("A");
        expect(f.host.inspectDebugContextHistory).toHaveBeenCalled();
        expect(f.stages()).toEqual(["extract", "consolidate"]);
        expect(f.documents.get("A")?.memory).toContain("lantern-482");
        await f.coordinator.wake("A");
        expect(f.stages()).toEqual(["extract", "consolidate"]);
      } finally {
        await f.coordinator.close();
      }
    },
  );

  it("extracts and publishes Antigravity memory when history inspection is available, and skips when unsupported", async () => {
    const supported = fixture({
      ghostRuntime: {
        type: "local",
        placement: {
          ...OWNER,
          runtimeType: "antigravity",
          computerId: "computer-1",
        },
      },
      canReadHistory: (_computerId, runtimeType) =>
        runtimeType === "antigravity",
    });
    try {
      await supported.coordinator.wake("A");
      expect(supported.host.inspectDebugContextHistory).toHaveBeenCalled();
      expect(supported.stages()).toEqual(["extract", "consolidate"]);
      expect(supported.documents.get("A")?.memory).toContain("lantern-482");
      expect(supported.respond.mock.calls[0]?.[0]).toMatchObject({
        placement: expect.objectContaining({ runtimeType: "antigravity" }),
      });
    } finally {
      await supported.coordinator.close();
    }

    const unsupported = fixture({
      ghostRuntime: {
        type: "local",
        placement: {
          ...OWNER,
          runtimeType: "antigravity",
          computerId: "computer-legacy",
        },
      },
      canReadHistory: () => false,
    });
    try {
      await unsupported.coordinator.wake("A");
      expect(
        unsupported.host.inspectDebugContextHistory,
      ).not.toHaveBeenCalled();
      expect(unsupported.stages()).toEqual([]);
    } finally {
      await unsupported.coordinator.close();
    }
  });

  it("extracts, consolidates and publishes in one wake on the Agent's own Computer", async () => {
    const f = fixture();
    try {
      await f.coordinator.wake("A");
      const [extract, consolidate] = f.respond.mock.calls.map(([r]) => r);
      expect(extract).toMatchObject({
        placement: {
          ...OWNER,
          agentId: "A",
          computerId: "computer-1",
          runtimeType: "codex",
        },
        schemaName: "memory_extract",
        outputSchema: {
          required: ["session_summary", "raw_memory"],
          additionalProperties: false,
        },
      });
      expect(extract!.input).toContain("lantern-482");
      expect(extract!.instructions).toContain("never instructions");
      expect(consolidate).toMatchObject({
        placement: expect.objectContaining({ computerId: "computer-1" }),
        schemaName: "memory_consolidate",
      });
      expect(JSON.parse(consolidate!.input)).toMatchObject({
        previous: { summary: "", memory: "" },
        memory_sections: [],
        extractions: [
          {
            summary: "Orchard release is lantern-482",
            raw_memory: "release code lantern-482",
          },
        ],
      });
      const published = f.documents.get("A")!;
      expect(published.memory).toContain("lantern-482");
      expect(Object.values(published.sessions)).toMatchObject([
        { raw_memory: "" },
      ]);
      expect(published.pending).toBeUndefined();
      await f.coordinator.wake("A");
      expect(f.respond).toHaveBeenCalledTimes(2);
      await f.coordinator.wake("B");
      expect(f.respond.mock.calls[2]![0].input).not.toContain('"previous":{"');
      expect(f.documents.get("B")!.memory).toContain("lantern-482");
    } finally {
      await f.coordinator.close();
    }
  });

  it("extracts only the conversation and its tool traffic, clipping long text", async () => {
    const f = fixture();
    const record = (
      ordinal: number,
      category: string,
      text: string,
      role?: string,
    ) => ({
      ordinal,
      category,
      ...(role ? { role } : {}),
      nativeRecord: { text },
    });
    vi.mocked(f.host.inspectDebugContextHistory).mockResolvedValue({
      status: "available",
      snapshot: {
        id: "snapshot",
        threadId: "thread",
        tailState: "clean",
        recordCount: 9,
      },
      records: [
        record(0, "message", "configuration ember-1", "developer"),
        record(1, "message", "Orchard uses lantern-482.", "user"),
        record(2, "provider_event", "item_completed ember-2"),
        record(3, "reasoning", "thinking ember-3"),
        record(4, "tool_call", "read orchard-notes"),
        record(5, "tool_result", `notes ${"x".repeat(5_000)}`),
        record(6, "usage", "token count ember-4"),
        record(7, "lifecycle", "task complete ember-5"),
        record(8, "compaction", "Summary: ember-6"),
      ],
    } as never);
    try {
      await f.coordinator.wake("A");
      const extract = f.respond.mock.calls[0]![0];
      expect(extract.schemaName).toBe("memory_extract");
      expect(extract.input).toContain("lantern-482");
      expect(extract.input).toContain("read orchard-notes");
      expect(extract.input).toContain("[1006 characters omitted]");
      expect(extract.input).not.toContain("ember-");
    } finally {
      await f.coordinator.close();
    }
  });

  it("waits for five succeeded Runs before reading new history", async () => {
    const f = fixture();
    try {
      for (let run = 0; run < 4; run += 1) await f.coordinator.recordRun("A");
      // Input alone wakes a scan, which reads no history before the fifth Run.
      f.receiveInput();
      await f.coordinator.reconcile();
      expect(f.host.inspectDebugContextHistory).not.toHaveBeenCalled();
      expect(f.respond).not.toHaveBeenCalled();
      await f.coordinator.recordRun("A");
      // The fifth Run extracts; its candidates wait for consolidation.
      expect(f.stages()).toEqual(["extract"]);
      expect(f.documents.get("A")!.memory).toBe("");
      expect(Object.values(f.documents.get("A")!.sessions)).toMatchObject([
        { raw_memory: "release code lantern-482" },
      ]);
      // A completed pass starts the count again.
      const inspected = vi.mocked(f.host.inspectDebugContextHistory).mock.calls
        .length;
      for (let run = 0; run < 4; run += 1) await f.coordinator.recordRun("A");
      f.receiveInput();
      await f.coordinator.reconcile();
      expect(f.host.inspectDebugContextHistory).toHaveBeenCalledTimes(
        inspected,
      );
    } finally {
      await f.coordinator.close();
    }
  });

  it("consolidates waiting candidates once the Agent has been idle for six hours", async () => {
    const f = fixture();
    const hour = 60 * 60_000;
    try {
      for (let run = 0; run < 5; run += 1) await f.coordinator.recordRun("A");
      expect(f.stages()).toEqual(["extract"]);
      f.advance(5 * hour);
      // Another Run starts the idle period again.
      await f.coordinator.recordRun("A");
      f.advance(hour);
      await f.coordinator.reconcile();
      expect(f.stages()).toEqual(["extract"]);
      f.advance(5 * hour);
      await f.coordinator.reconcile();
      expect(f.stages()).toEqual(["extract", "consolidate"]);
      const published = f.documents.get("A")!;
      expect(published.memory).toContain("lantern-482");
      expect(Object.values(published.sessions)).toMatchObject([
        { raw_memory: "" },
      ]);
      // Nothing waits any more, however long the Agent stays idle.
      f.advance(24 * hour);
      await f.coordinator.reconcile();
      expect(f.stages()).toEqual(["extract", "consolidate"]);
    } finally {
      await f.coordinator.close();
    }
  });

  it("consolidates candidates waiting from before a restart after six idle hours", async () => {
    const f = fixture();
    const key = "e".repeat(64);
    f.documents.set("A", {
      revision: 3,
      summary: "",
      memory: "",
      cursors: {},
      sessions: {
        [key]: {
          context_key: "source",
          thread_id: "other-thread",
          through: 0,
          summary: "earlier session",
          raw_memory: "waiting lantern-77",
          updated_revision: 3,
        },
      },
    });
    try {
      await f.coordinator.reconcile();
      expect(f.respond).not.toHaveBeenCalled();
      f.advance(6 * 60 * 60_000);
      await f.coordinator.reconcile();
      // An idle pass also extracts history fewer than five Runs left behind.
      expect(f.stages()).toEqual(["extract", "consolidate"]);
      expect(f.respond.mock.calls[1]![0].input).toContain("lantern-77");
      expect(f.documents.get("A")!.sessions[key]!.raw_memory).toBe("");
    } finally {
      await f.coordinator.close();
    }
  });

  it("publishes only the sections the consolidation edits", async () => {
    const f = fixture();
    const key = "e".repeat(64);
    const memory =
      "## Releases\n\n- lantern-77\n\n## Tooling\n\n- Run the gate.\n";
    f.documents.set("A", {
      revision: 3,
      summary: "old index",
      memory,
      cursors: {},
      sessions: {
        [key]: {
          context_key: "source",
          thread_id: "other-thread",
          through: 0,
          summary: "earlier session",
          raw_memory: "the release moved to lantern-482",
          updated_revision: 3,
        },
      },
    });
    try {
      await f.coordinator.wake("A");
      expect(f.stages()).toEqual(["extract", "consolidate"]);
      expect(JSON.parse(f.respond.mock.calls[1]![0].input)).toMatchObject({
        previous: { summary: "old index", memory },
        memory_sections: ["Releases", "Tooling"],
      });
      expect(f.documents.get("A")).toMatchObject({
        summary: "Orchard release",
        memory:
          "## Releases\n\nRelease code: lantern-482\n\n## Tooling\n\n- Run the gate.\n",
      });
    } finally {
      await f.coordinator.close();
    }
  });

  it("corrects edits that do not fit the memory in the call's next attempt", async () => {
    const f = fixture();
    f.respond
      .mockImplementationOnce(async (request) => validOutput(request))
      .mockResolvedValueOnce({
        summary: "Orchard release",
        edits: [{ op: "replace", heading: "Missing", content: "x" }],
      });
    try {
      await f.coordinator.wake("A");
      expect(f.stages()).toEqual(["extract", "consolidate", "consolidate"]);
      expect(f.documents.get("A")!.pending).toBeUndefined();
      expect(f.documents.get("A")!.memory).toBe(
        "## Releases\n\nRelease code: lantern-482\n",
      );
    } finally {
      await f.coordinator.close();
    }
  });

  it("spends an attempt and backs off each time consolidation times out", async () => {
    const f = fixture();
    f.respond.mockImplementation(async (request) => {
      if (stageOf(request) === "consolidate")
        throw new ModelCallError(
          "timed_out",
          "The Runtime did not answer in time",
        );
      return validOutput(request);
    });
    try {
      await f.coordinator.wake("A");
      expect(f.stages()).toEqual(["extract", "consolidate"]);
      expect(f.documents.get("A")!.pending).toMatchObject({
        stage: "consolidate",
        attempt: 1,
      });
      // A timed-out stage is not retried back to back.
      await f.coordinator.wake("A");
      expect(f.respond).toHaveBeenCalledTimes(2);
      f.advance(60_000);
      await f.coordinator.wake("A");
      f.advance(2 * 60_000);
      await f.coordinator.wake("A");
      expect(f.documents.get("A")!.pending).toMatchObject({ attempt: 3 });
      f.advance(60 * 60_000);
      await f.coordinator.wake("A");
      expect(f.respond).toHaveBeenCalledTimes(4);
      expect(f.documents.get("A")!.memory).toBe("");
    } finally {
      await f.coordinator.close();
    }
  });

  it("consolidates before extracting past the waiting candidate budget", async () => {
    const f = fixture();
    const records: {
      ordinal: number;
      category: string;
      nativeRecord: unknown;
    }[] = [];
    vi.mocked(f.host.inspectDebugContextHistory).mockImplementation(
      async () =>
        ({
          status: "available",
          snapshot: {
            id: "snapshot",
            threadId: "thread",
            tailState: "clean",
            recordCount: records.length,
          },
          records: [...records],
        }) as never,
    );
    f.respond.mockImplementation(async (request) =>
      stageOf(request) === "extract"
        ? { session_summary: "busy", raw_memory: "c".repeat(30_000) }
        : validOutput(request),
    );
    try {
      for (let pass = 0; pass < 4; pass += 1) {
        records.push({
          ordinal: pass,
          category: "message",
          nativeRecord: { role: "user", text: `turn ${pass}` },
        });
        for (let run = 0; run < 5; run += 1) await f.coordinator.recordRun("A");
      }
      expect(f.stages()).toEqual([
        "extract",
        "extract",
        "extract",
        "consolidate",
        "extract",
      ]);
      expect(
        Object.values(f.documents.get("A")!.sessions)[0]!.raw_memory,
      ).toHaveLength(30_000);
    } finally {
      await f.coordinator.close();
    }
  });

  it("counts Runs that finish during a pass toward the next one", async () => {
    const f = fixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.respond.mockImplementationOnce(async (request) => {
      await held;
      return validOutput(request);
    });
    try {
      const passes: Promise<void>[] = [];
      for (let run = 0; run < 5; run += 1)
        passes.push(f.coordinator.recordRun("A"));
      await vi.waitFor(() => expect(f.respond).toHaveBeenCalledTimes(1));
      for (let run = 0; run < 5; run += 1)
        passes.push(f.coordinator.recordRun("A"));
      release();
      await Promise.all(passes);
      const inspected = vi.mocked(f.host.inspectDebugContextHistory).mock.calls
        .length;
      // Five Runs are still counted, so even an unchanged scan reads history.
      await f.coordinator.reconcile();
      expect(f.host.inspectDebugContextHistory).toHaveBeenCalledTimes(
        inspected + 1,
      );
      await f.coordinator.reconcile();
      expect(f.host.inspectDebugContextHistory).toHaveBeenCalledTimes(
        inspected + 1,
      );
    } finally {
      await f.coordinator.close();
    }
  });

  it("extracts every batch a pass found, but not history written during it", async () => {
    const f = fixture();
    const record = (ordinal: number, text: string) => ({
      ordinal,
      category: "message",
      nativeRecord: { role: "user", text },
    });
    // Eighty clipped-size records exceed one extraction batch.
    const records = Array.from({ length: 80 }, (_, ordinal) =>
      record(
        ordinal,
        `${ordinal === 0 ? "first" : ordinal === 79 ? "second" : "filler"} ${"x".repeat(3_500)}`,
      ),
    );
    vi.mocked(f.host.inspectDebugContextHistory).mockImplementation(
      async () =>
        ({
          status: "available",
          snapshot: {
            id: "snapshot",
            threadId: "thread",
            tailState: "clean",
            recordCount: records.length,
          },
          records: [...records],
        }) as never,
    );
    f.respond.mockImplementation(async (request) => {
      // A Run finishes while the pass is extracting.
      if (records.length === 80) records.push(record(80, "third lantern-999"));
      return validOutput(request);
    });
    try {
      await f.coordinator.wake("A");
      // Both batches are extracted, then consolidated together once.
      expect(f.stages()).toEqual(["extract", "extract", "consolidate"]);
      const inputs = f.respond.mock.calls.map(([request]) => request.input);
      expect(inputs[0]).toContain("first");
      expect(inputs[1]).toContain("second");
      expect(inputs.join("")).not.toContain("lantern-999");
      expect(Object.values(f.documents.get("A")!.cursors)).toEqual([
        { thread_id: "thread", through: 79 },
      ]);
      for (let run = 0; run < 5; run += 1) await f.coordinator.recordRun("A");
      expect(f.respond.mock.calls.at(-1)![0].input).toContain("lantern-999");
    } finally {
      await f.coordinator.close();
    }
  });

  it("scans an Agent again only after one of its Contexts receives input", async () => {
    const f = fixture();
    try {
      await f.coordinator.reconcile();
      const reads = vi.mocked(f.memory.read).mock.calls.length;
      await f.coordinator.reconcile();
      await f.coordinator.reconcile();
      expect(f.memory.read).toHaveBeenCalledTimes(reads);
      f.receiveInput();
      await f.coordinator.reconcile();
      expect(f.memory.read).toHaveBeenCalledTimes(reads + 1);
      // A compaction start still maintains the Agent directly.
      await f.coordinator.wake("A");
      expect(f.memory.read).toHaveBeenCalledTimes(reads + 2);
      expect(f.respond).toHaveBeenCalledTimes(2);
    } finally {
      await f.coordinator.close();
    }
  });

  it("skips a Meta Context that has never received input and still settles", async () => {
    const f = fixture({ inputSequence: "0" });
    try {
      await f.coordinator.reconcile();
      expect(f.runtimeState.getWorkState).not.toHaveBeenCalled();
      expect(f.host.inspectDebugContextHistory).not.toHaveBeenCalled();
      expect(f.respond).not.toHaveBeenCalled();
      // Settled: the next scan with unchanged Contexts reads nothing.
      const getGhost = vi.mocked(f.host.getGhost).mock.calls.length;
      const reads = vi.mocked(f.memory.read).mock.calls.length;
      await f.coordinator.reconcile();
      expect(f.host.getGhost).toHaveBeenCalledTimes(getGhost);
      expect(f.memory.read).toHaveBeenCalledTimes(reads);
    } finally {
      await f.coordinator.close();
    }
  });

  it("leaves unreadable history for the next due pass", async () => {
    const f = fixture();
    vi.mocked(f.host.inspectDebugContextHistory).mockResolvedValue({
      status: "unavailable",
      records: [],
    } as never);
    try {
      for (let run = 0; run < 5; run += 1) await f.coordinator.recordRun("A");
      expect(f.host.inspectDebugContextHistory).toHaveBeenCalledTimes(1);
      // New input alone does not read it again.
      f.receiveInput();
      await f.coordinator.reconcile();
      expect(f.host.inspectDebugContextHistory).toHaveBeenCalledTimes(1);
      for (let run = 0; run < 5; run += 1) await f.coordinator.recordRun("A");
      expect(f.host.inspectDebugContextHistory).toHaveBeenCalledTimes(2);
    } finally {
      await f.coordinator.close();
    }
  });

  it("reads no history from a Computer that is offline or asleep", async () => {
    const canReadHistory = vi.fn(() => false);
    const f = fixture({
      ghostRuntime: {
        type: "local",
        placement: { computerId: "computer-1", runtimeType: "codex" },
      },
      canReadHistory,
    });
    try {
      await f.coordinator.wake("A");
      expect(canReadHistory).toHaveBeenCalledWith("computer-1", "codex");
      expect(f.host.inspectDebugContextHistory).not.toHaveBeenCalled();
      expect(f.respond).not.toHaveBeenCalled();
      expect(f.documents.get("A")).toBeUndefined();
      canReadHistory.mockReturnValue(true);
      await f.coordinator.wake("A");
      expect(f.stages()).toEqual(["extract", "consolidate"]);
    } finally {
      await f.coordinator.close();
    }
  });

  it("keeps extracted candidates and resumes consolidation without the Computer", async () => {
    const canReadHistory = vi.fn(() => true);
    const f = fixture({
      ghostRuntime: {
        type: "local",
        placement: { computerId: "computer-1", runtimeType: "codex" },
      },
      canReadHistory,
    });
    f.respond.mockImplementation(async (request) => {
      if (stageOf(request) === "consolidate")
        throw new ModelCallError("computer_offline", "Computer is offline");
      return validOutput(request);
    });
    try {
      await f.coordinator.wake("A");
      expect(f.documents.get("A")!.pending).toEqual({
        stage: "consolidate",
        prompt: expect.stringContaining("lantern-482"),
      });
      canReadHistory.mockReturnValue(false);
      f.respond.mockImplementation(async (request) => validOutput(request));
      f.advance(60_000);
      const inspected = vi.mocked(f.host.inspectDebugContextHistory).mock.calls
        .length;
      await f.coordinator.wake("A");
      expect(f.stages()).toEqual(["extract", "consolidate", "consolidate"]);
      expect(f.host.inspectDebugContextHistory).toHaveBeenCalledTimes(
        inspected,
      );
      expect(f.documents.get("A")!.memory).toContain("lantern-482");
      expect(f.documents.get("A")!.pending).toBeUndefined();
    } finally {
      await f.coordinator.close();
    }
  });

  it("backs off while the Computer is offline without spending an attempt", async () => {
    const f = fixture();
    f.respond.mockRejectedValue(
      new ModelCallError("computer_offline", "Computer is offline"),
    );
    try {
      await f.coordinator.wake("A");
      await f.coordinator.reconcile();
      await f.coordinator.wake("A");
      expect(f.respond).toHaveBeenCalledTimes(1);
      f.advance(60_000);
      await f.coordinator.wake("A");
      expect(f.respond).toHaveBeenCalledTimes(2);
      // The second failure doubles the wait.
      f.advance(60_000);
      await f.coordinator.wake("A");
      expect(f.respond).toHaveBeenCalledTimes(2);
      expect(f.documents.get("A")!.pending!.attempt).toBeUndefined();
      f.advance(60_000);
      f.respond.mockImplementation(async (request) => validOutput(request));
      await f.coordinator.wake("A");
      expect(f.documents.get("A")!.pending).toBeUndefined();
      expect(f.documents.get("A")!.memory).toContain("lantern-482");
    } finally {
      await f.coordinator.close();
    }
  });

  it("stops after three passes whose output stays invalid and leaves the published memory unchanged", async () => {
    const f = fixture();
    f.respond.mockResolvedValue({ session_summary: 42, raw_memory: "x" });
    try {
      await f.coordinator.wake("A");
      expect(f.respond).toHaveBeenCalledTimes(ATTEMPTS);
      expect(f.documents.get("A")!.pending).toMatchObject({
        stage: "extract",
        attempt: 1,
      });
      // A failed pass is not retried back to back.
      await f.coordinator.wake("A");
      expect(f.respond).toHaveBeenCalledTimes(ATTEMPTS);
      f.advance(60_000);
      await f.coordinator.wake("A");
      f.advance(2 * 60_000);
      await f.coordinator.wake("A");
      expect(f.respond).toHaveBeenCalledTimes(3 * ATTEMPTS);
      const document = f.documents.get("A")!;
      expect(document.pending).toMatchObject({ stage: "extract", attempt: 3 });
      expect(document.sessions).toEqual({});
      expect(document.cursors).toEqual({});
      expect(document.memory).toBe("");
      f.advance(60 * 60_000);
      await f.coordinator.wake("A");
      expect(f.respond).toHaveBeenCalledTimes(3 * ATTEMPTS);
    } finally {
      await f.coordinator.close();
    }
  });

  it("retains extraction watermarks when source summaries are evicted", async () => {
    const f = fixture();
    try {
      await f.coordinator.wake("A");
      const published = f.documents.get("A")!;
      f.documents.set("A", { ...published, sessions: {} });
      await f.coordinator.wake("A");
      expect(f.respond).toHaveBeenCalledTimes(2);
    } finally {
      await f.coordinator.close();
    }
  });

  it("evicts the oldest consolidated session regardless of JSONB key order", async () => {
    const f = fixture();
    const oldestKey = "f".repeat(64);
    const waitingKey = "e".repeat(64);
    const session = {
      context_key: "source",
      thread_id: "thread",
      through: 0,
      summary: "old",
      raw_memory: "",
    };
    f.documents.set("A", {
      revision: 100,
      summary: "",
      memory: "",
      cursors: {},
      sessions: Object.fromEntries([
        ...Array.from(
          { length: 28 },
          (_, i) =>
            [
              i.toString(16).padStart(64, "0"),
              { ...session, updated_revision: i + 3 },
            ] as const,
        ),
        [oldestKey, { ...session, updated_revision: 2 }],
        // Older still, but its candidates wait for consolidation.
        [
          waitingKey,
          { ...session, raw_memory: "waiting", updated_revision: 1 },
        ],
      ]),
    });
    try {
      await f.coordinator.wake("A");
      const published = f.documents.get("A")!;
      expect(Object.keys(published.sessions)).toHaveLength(30);
      expect(published.sessions[oldestKey]).toBeUndefined();
      expect(published.sessions[waitingKey]).toBeDefined();
      expect(f.respond.mock.calls.at(-1)![0].input).toContain("waiting");
      const [sourceKey] = Object.keys(published.cursors);
      expect(published.sessions[sourceKey!]!.updated_revision).toBe(
        Math.max(
          ...Object.values(published.sessions).map(
            (other) => other.updated_revision,
          ),
        ),
      );
    } finally {
      await f.coordinator.close();
    }
  });

  it("does not re-query getGhost for an Agent whose runtime config is gone until the signature changes", async () => {
    const f = fixture({ ghost: null });
    try {
      await f.coordinator.reconcile();
      expect(f.host.getGhost).toHaveBeenCalledTimes(1);
      expect(f.logger.log).toHaveBeenCalledTimes(1);
      expect(f.logger.log).toHaveBeenCalledWith(
        "info",
        "agent_memory.settled_config_gone",
        { agentId: "A", status: 404 },
      );
      expect(
        Object.keys(vi.mocked(f.logger.log).mock.calls[0]![2] as object),
      ).toEqual(["agentId", "status"]);
      await f.coordinator.reconcile();
      expect(f.host.getGhost).toHaveBeenCalledTimes(1);
      expect(f.logger.log).toHaveBeenCalledTimes(1);
      f.receiveInput();
      await f.coordinator.reconcile();
      expect(f.host.getGhost).toHaveBeenCalledTimes(2);
      expect(f.logger.log).toHaveBeenCalledTimes(2);
    } finally {
      await f.coordinator.close();
    }
  });

  it("does not treat an Agent as processed when getGhost throws", async () => {
    const f = fixture();
    vi.mocked(f.host.getGhost).mockRejectedValue(
      new TeamHubRuntimeStateError(503, "service unavailable"),
    );
    try {
      await f.coordinator.reconcile();
      expect(f.host.getGhost).toHaveBeenCalledTimes(1);
      await f.coordinator.reconcile();
      expect(f.host.getGhost).toHaveBeenCalledTimes(1);
      f.advance(60_000);
      await f.coordinator.reconcile();
      expect(f.host.getGhost).toHaveBeenCalledTimes(2);
    } finally {
      await f.coordinator.close();
    }
  });
});

describe("Agent memory sized to the model's context window", () => {
  // Half of 20,000 tokens at 1.5 UTF-8 bytes per token (CJK/JSON safe).
  const WINDOW = 20_000;
  const INPUT_BYTES = 15_000;
  const inputBytes = (request: ModelCallRequest) =>
    Buffer.byteLength(request.instructions ?? "", "utf8") +
    Buffer.byteLength(request.input, "utf8");
  const waitingSession = (raw_memory: string, updated_revision: number) => ({
    context_key: "source",
    thread_id: "thread",
    through: 0,
    summary: "summary",
    raw_memory,
    updated_revision,
  });

  it("extracts history in batches that fit the window", async () => {
    const f = fixture({ contextWindow: () => WINDOW });
    const records = Array.from({ length: 20 }, (_, ordinal) => ({
      ordinal,
      category: "message",
      nativeRecord: {
        role: "user",
        text: `turn ${ordinal} ${"x".repeat(3_000)}`,
      },
    }));
    vi.mocked(f.host.inspectDebugContextHistory).mockResolvedValue({
      status: "available",
      snapshot: {
        id: "snapshot",
        threadId: "thread",
        tailState: "clean",
        recordCount: records.length,
      },
      records,
    } as never);
    try {
      await f.coordinator.wake("A");
      const extractions = f.respond.mock.calls
        .map(([request]) => request)
        .filter((request) => stageOf(request) === "extract");
      expect(extractions.length).toBeGreaterThan(1);
      for (const request of extractions)
        expect(inputBytes(request)).toBeLessThanOrEqual(INPUT_BYTES);
      expect(f.stages().at(-1)).toBe("consolidate");
      expect(Object.values(f.documents.get("A")!.cursors)).toEqual([
        { thread_id: "thread", through: 19 },
      ]);
      // The window is the one of the model the stages run on.
      expect(f.contextWindow).toHaveBeenCalledOnce();
      expect(f.contextWindow.mock.calls[0]![0]).toEqual({
        placement: extractions[0]!.placement,
      });
    } finally {
      await f.coordinator.close();
    }
  });

  it("consolidates waiting sessions in batches that fit the window, least recently extracted first", async () => {
    const f = fixture({
      contextWindow: () => WINDOW,
      canReadHistory: () => false,
    });
    const candidate = (marker: string) => `${marker} ${"x".repeat(5_000)}`;
    f.documents.set("A", {
      revision: 10,
      summary: "",
      memory: "",
      cursors: {},
      sessions: {
        ["1".repeat(64)]: waitingSession(candidate("newest"), 3),
        ["2".repeat(64)]: waitingSession(candidate("oldest"), 1),
        ["3".repeat(64)]: waitingSession(candidate("middle"), 2),
      },
    });
    try {
      await f.coordinator.wake("A");
      expect(f.stages()).toEqual(["consolidate", "consolidate"]);
      const [first, second] = f.respond.mock.calls.map(([request]) => request);
      expect(first!.input).toContain("oldest");
      expect(first!.input).toContain("middle");
      expect(first!.input).not.toContain("newest");
      expect(inputBytes(first!)).toBeLessThanOrEqual(INPUT_BYTES);
      expect(second!.input).toContain("newest");
      expect(
        Object.values(f.documents.get("A")!.sessions).map(
          (session) => session.raw_memory,
        ),
      ).toEqual(["", "", ""]);
    } finally {
      await f.coordinator.close();
    }
  });

  it("consolidates a session alone when it does not fit the window by itself", async () => {
    const f = fixture({
      contextWindow: () => WINDOW,
      canReadHistory: () => false,
    });
    const rawMemory = "y".repeat(40_000);
    f.documents.set("A", {
      revision: 10,
      summary: "",
      memory: "",
      cursors: {},
      sessions: {
        ["1".repeat(64)]: waitingSession(rawMemory, 1),
      },
    });
    try {
      await f.coordinator.wake("A");
      const calls = f.respond.mock.calls.map(([request]) => request);
      expect(calls.length).toBeGreaterThan(1);
      expect(f.stages().every((stage) => stage === "consolidate")).toBe(true);
      for (const call of calls) {
        expect(inputBytes(call)).toBeLessThanOrEqual(INPUT_BYTES);
      }
      const combined = calls
        .map(
          (call) =>
            (
              JSON.parse(call.input) as {
                extractions: { raw_memory: string }[];
              }
            ).extractions[0]!.raw_memory,
        )
        .join("");
      expect(combined).toBe(rawMemory);
      expect(f.documents.get("A")!.memory).toContain("lantern-482");
      expect(f.documents.get("A")!.sessions["1".repeat(64)]!.raw_memory).toBe(
        "",
      );
    } finally {
      await f.coordinator.close();
    }
  });

  it("limits the Memory to half of the window's input and corrects a larger one", async () => {
    const f = fixture({ contextWindow: () => WINDOW });
    f.respond
      .mockImplementationOnce(async (request) => validOutput(request))
      .mockResolvedValueOnce({
        summary: "Orchard release",
        edits: [{ op: "add", heading: "Releases", content: "z".repeat(8_000) }],
      });
    try {
      await f.coordinator.wake("A");
      expect(f.stages()).toEqual(["extract", "consolidate", "consolidate"]);
      expect(f.respond.mock.calls[1]![0].instructions).toContain(
        "at most 7500 UTF-8 bytes",
      );
      expect(f.documents.get("A")!.memory).toBe(
        "## Releases\n\nRelease code: lantern-482\n",
      );
    } finally {
      await f.coordinator.close();
    }
  });

  it.each([undefined, 1_000_000])(
    "keeps the fixed 200 KB Memory limit when the window is %s",
    async (window) => {
      const f = fixture({ contextWindow: () => window });
      try {
        await f.coordinator.wake("A");
        expect(f.respond.mock.calls.at(-1)![0].instructions).toContain(
          "at most 200000 UTF-8 bytes",
        );
      } finally {
        await f.coordinator.close();
      }
    },
  );

  it("preserves full ceilings when contextWindow is unknown or large and tightens only explicitly constrained windows", () => {
    expect(memoryBudget(undefined)).toEqual({
      input: 400_000,
      memory: 200_000,
    });
    expect(memoryBudget(1_000_000)).toEqual({
      input: 400_000,
      memory: 200_000,
    });
    expect(memoryBudget(200_000)).toEqual({
      input: 300_000,
      memory: 150_000,
    });
    expect(memoryBudget(65_536)).toEqual({
      input: 49_152,
      memory: 24_576,
    });
    expect(memoryBudget(undefined, 40_000)).toEqual({
      input: 40_000,
      memory: 200_000,
    });
  });

  it.each([
    ["unknown window (Codex)", undefined],
    ["constrained 65K local window", 65_536],
  ])(
    "consolidates cleanly without failing or losing memory when existing persisted memory is 60 KB (%s)",
    async (_label, windowValue) => {
      const f = fixture({
        contextWindow: () => windowValue,
        canReadHistory: () => false,
      });
      const existingMemory = Array.from(
        { length: 12 },
        (_, idx) => `## Existing ${idx}\n\n${"m".repeat(5_000)}\n`,
      ).join("\n");
      expect(Buffer.byteLength(existingMemory, "utf8")).toBeGreaterThan(60_000);
      const sessionKey = "f".repeat(64);
      f.documents.set("A", {
        revision: 4,
        summary: "Existing summary",
        memory: existingMemory,
        cursors: {},
        sessions: {
          [sessionKey]: waitingSession("New release code: lantern-482.", 4),
        },
      });
      try {
        await f.coordinator.wake("A");
        expect(f.stages()).toEqual(["consolidate"]);
        const call = f.respond.mock.calls[0]![0];
        if (windowValue === 65_536) {
          expect(inputBytes(call)).toBeLessThanOrEqual(49_152);
        }
        const after = f.documents.get("A")!;
        expect(after.pending).toBeUndefined();
        expect(after.memory).toContain("## Existing 0");
        expect(after.memory).toContain("## Existing 11");
        expect(after.memory).toContain("lantern-482");
        expect(Buffer.byteLength(after.memory, "utf8")).toBeGreaterThan(60_000);
        expect(after.sessions[sessionKey]!.raw_memory).toBe("");
      } finally {
        await f.coordinator.close();
      }
    },
  );

  it("keeps dense non-ASCII and JSON transcripts strictly under 65,536 tokens for a 65K window", async () => {
    // Three-byte UTF-8 ideographs encoded via escapes to keep source English-only.
    const cjkChunk = "\u4e2d\u6587\u8bb0\u5fc6\u6d4b\u8bd5".repeat(400);
    const records = Array.from({ length: 40 }, (_, ordinal) => ({
      ordinal,
      category: "message",
      nativeRecord: {
        role: ordinal % 2 === 0 ? "user" : "assistant",
        text: `turn-${ordinal} ${cjkChunk}`,
        metadata: { step: ordinal, tags: ["json", "payload", "local"] },
      },
    }));
    const f = fixture({ contextWindow: () => 65_536 });
    vi.mocked(f.host.inspectDebugContextHistory).mockResolvedValue({
      status: "available",
      snapshot: {
        id: "snapshot-cjk",
        threadId: "thread-cjk",
        tailState: "clean",
        recordCount: records.length,
      },
      records,
    } as never);
    try {
      await f.coordinator.wake("A");
      const extractions = f.respond.mock.calls
        .map(([request]) => request)
        .filter((request) => stageOf(request) === "extract");
      expect(extractions.length).toBeGreaterThan(1);
      for (const request of extractions) {
        const totalBytes = inputBytes(request);
        // Even at a pessimistic 1.5 UTF-8 bytes/token for dense UTF-8 + JSON,
        // every batch stays around 32K tokens, well below a 65,536-token n_ctx.
        expect(totalBytes).toBeLessThanOrEqual(49_152);
        const worstCaseTokens = Math.ceil(totalBytes / 1.5);
        expect(worstCaseTokens).toBeLessThan(40_000);
      }
      expect(Object.values(f.documents.get("A")!.cursors)).toEqual([
        { thread_id: "thread-cjk", through: 39 },
      ]);
    } finally {
      await f.coordinator.close();
    }
  });

  it("rebuilds smaller extraction batches on invalid_request context overflow through the single builder", async () => {
    const f = fixture({ contextWindow: () => undefined });
    const records = Array.from({ length: 12 }, (_, ordinal) => ({
      ordinal,
      category: "message",
      nativeRecord: {
        role: "user",
        text: `item-${ordinal} ${"a".repeat(2_500)}`,
      },
    }));
    vi.mocked(f.host.inspectDebugContextHistory).mockResolvedValue({
      status: "available",
      snapshot: {
        id: "snapshot-shrink",
        threadId: "thread-shrink",
        tailState: "clean",
        recordCount: records.length,
      },
      records,
    } as never);
    // Simulate a smaller local n_ctx that rejects prompts above 12 KB.
    f.respond.mockImplementation(async (request) => {
      if (
        stageOf(request) === "extract" &&
        Buffer.byteLength(request.input, "utf8") > 12_000
      ) {
        throw new ModelCallError(
          "invalid_request",
          "request exceeds available context size",
        );
      }
      return validOutput(request);
    });
    try {
      await f.coordinator.wake("A");
      expect(Object.values(f.documents.get("A")!.cursors)).toEqual([
        { thread_id: "thread-shrink", through: 11 },
      ]);
      expect(f.documents.get("A")!.pending).toBeUndefined();
      expect(f.logger.log).toHaveBeenCalledWith(
        "warn",
        "agent_memory.batch_shrunk",
        expect.objectContaining({
          agentId: "A",
          stage: "extract",
          before_bytes: expect.any(Number),
          target_input_bytes: expect.any(Number),
          reason: "invalid_request",
        }),
      );
    } finally {
      await f.coordinator.close();
    }
  });

  it("skips only an indivisible overflowing record at minimum budget while preserving healthy siblings", async () => {
    const f = fixture({ contextWindow: () => 20_000 });
    const records = [
      {
        ordinal: 0,
        category: "message",
        nativeRecord: { role: "user", text: "poison-record-token-explosion" },
      },
      {
        ordinal: 1,
        category: "message",
        nativeRecord: { role: "user", text: "Keep sibling-one lantern-777." },
      },
      {
        ordinal: 2,
        category: "message",
        nativeRecord: { role: "user", text: "Keep sibling-two lantern-888." },
      },
    ];
    vi.mocked(f.host.inspectDebugContextHistory).mockResolvedValue({
      status: "available",
      snapshot: {
        id: "snapshot-siblings",
        threadId: "thread-siblings",
        tailState: "clean",
        recordCount: records.length,
      },
      records,
    } as never);
    // Reject any prompt still containing record 0, even when sent alone.
    f.respond.mockImplementation(async (request) => {
      if (
        stageOf(request) === "extract" &&
        request.input.includes("poison-record-token-explosion")
      ) {
        throw new ModelCallError(
          "invalid_request",
          "Model invocation prompt exceeded the model context window",
        );
      }
      return validOutput(request);
    });
    try {
      await f.coordinator.wake("A");
      const extractInputs = f.respond.mock.calls
        .map(([r]) => r)
        .filter((r) => stageOf(r) === "extract")
        .map((r) => r.input);
      expect(f.logger.log).toHaveBeenCalledWith(
        "warn",
        "agent_memory.record_skipped_oversized",
        expect.objectContaining({
          agentId: "A",
          ordinal: 0,
        }),
      );
      expect(extractInputs.at(-1)).toContain("sibling-one");
      expect(extractInputs.at(-1)).toContain("sibling-two");
      expect(Object.values(f.documents.get("A")!.cursors)).toEqual([
        { thread_id: "thread-siblings", through: 2 },
      ]);
      expect(f.documents.get("A")!.pending).toBeUndefined();
    } finally {
      await f.coordinator.close();
    }
  });

  it("never skips records when MAX_SHRINK_STEPS_PER_PASS is exhausted on invalid_request", async () => {
    const f = fixture({ contextWindow: () => 200_000 });
    const records = Array.from({ length: 64 }, (_, ordinal) => ({
      ordinal,
      category: "message",
      nativeRecord: {
        role: "user",
        text: `msg-${ordinal} ${"x".repeat(1_500)}`,
      },
    }));
    vi.mocked(f.host.inspectDebugContextHistory).mockResolvedValue({
      status: "available",
      snapshot: {
        id: "snapshot-many",
        threadId: "thread-many",
        tailState: "clean",
        recordCount: records.length,
      },
      records,
    } as never);
    f.respond.mockImplementation(async (request) => {
      if (
        stageOf(request) === "extract" &&
        Buffer.byteLength(request.input, "utf8") > 3_500
      ) {
        throw new ModelCallError("invalid_request", "context overflow");
      }
      return validOutput(request);
    });
    try {
      await f.coordinator.wake("A");
      // Hit MAX_SHRINK_STEPS_PER_PASS before reaching <= 3.5 KB: cursor must
      // remain untouched and pending dropped so the next pass resumes tighter.
      expect(Object.values(f.documents.get("A")!.cursors)).toEqual([]);
      expect(f.documents.get("A")!.pending).toBeUndefined();

      // Next pass continues from the learned tighter budget and completes all 64.
      f.advance(60_000);
      await f.coordinator.wake("A");
      expect(Object.values(f.documents.get("A")!.cursors)).toEqual([
        { thread_id: "thread-many", through: 63 },
      ]);
    } finally {
      await f.coordinator.close();
    }
  });

  it("keeps generic failed and canceled errors on backoff without truncating memory or spending attempts", async () => {
    const f = fixture({
      contextWindow: () => 65_536,
      canReadHistory: () => false,
    });
    const sessionKey = "c".repeat(64);
    const fullCandidate = `important-start ${"x".repeat(12_000)} important-tail-marker`;
    f.documents.set("A", {
      revision: 3,
      summary: "Summary",
      memory: "## Releases\n\nInitial.\n",
      cursors: {},
      sessions: {
        [sessionKey]: waitingSession(fullCandidate, 3),
      },
    });
    let failCount = 0;
    f.respond.mockImplementation(async (request) => {
      if (failCount < 4) {
        failCount += 1;
        throw new ModelCallError(
          "failed",
          failCount === 1
            ? "Model invocation canceled: drain"
            : "temporary provider outage",
        );
      }
      return validOutput(request);
    });
    try {
      for (const delay of [0, 60_000, 2 * 60_000, 4 * 60_000]) {
        if (delay > 0) f.advance(delay);
        await f.coordinator.wake("A");
        const pending = f.documents.get("A")!.pending;
        expect(pending?.stage).toBe("consolidate");
        expect(pending?.attempt).toBeUndefined();
        expect(pending?.prompt).toContain("important-tail-marker");
      }
      // After 4 transient failures (exceeding MAX_STAGE_ATTEMPTS = 3), recovery
      // still succeeds with the full, unclipped candidate intact.
      f.advance(8 * 60_000);
      await f.coordinator.wake("A");
      expect(f.documents.get("A")!.pending).toBeUndefined();
      expect(f.respond.mock.calls.at(-1)![0].input).toContain(
        "important-tail-marker",
      );
      expect(f.documents.get("A")!.sessions[sessionKey]!.raw_memory).toBe("");
    } finally {
      await f.coordinator.close();
    }
  });

  it("rebuilds consolidate prompts on invalid_request while preserving memory_sections", async () => {
    const f = fixture({
      contextWindow: () => 65_536,
      canReadHistory: () => false,
    });
    const largeMemory = Array.from(
      { length: 20 },
      (_, idx) => `## Topic ${idx}\n\n${"m".repeat(5_000)}\n`,
    ).join("\n");
    const largeSummary = "s".repeat(12_000);
    const sessionKey = "d".repeat(64);
    f.documents.set("A", {
      revision: 5,
      summary: largeSummary,
      memory: largeMemory,
      cursors: {},
      sessions: {
        [sessionKey]: waitingSession("candidate facts", 5),
      },
    });
    // Reject prompts above 20 KB to exercise invalid_request rebuild of previous.memory.
    f.respond.mockImplementation(async (request) => {
      if (
        stageOf(request) === "consolidate" &&
        Buffer.byteLength(request.input, "utf8") > 20_000
      ) {
        throw new ModelCallError(
          "invalid_request",
          "Model invocation prompt exceeded the model context window",
        );
      }
      return validOutput(request);
    });
    try {
      await f.coordinator.wake("A");
      const calls = f.respond.mock.calls
        .map(([r]) => r)
        .filter((r) => stageOf(r) === "consolidate");
      expect(calls.length).toBeGreaterThanOrEqual(2);
      expect(inputBytes(calls[0]!)).toBeLessThanOrEqual(49_152);
      const finalPayload = JSON.parse(calls.at(-1)!.input) as {
        previous: { summary: string; memory: string };
        memory_sections: string[];
      };
      expect(
        Buffer.byteLength(calls.at(-1)!.input, "utf8"),
      ).toBeLessThanOrEqual(20_000);
      expect(finalPayload.memory_sections).toHaveLength(20);
      expect(f.documents.get("A")!.memory).toContain("lantern-482");
      expect(f.documents.get("A")!.memory).toContain("## Topic 0");
      expect(f.documents.get("A")!.pending).toBeUndefined();
    } finally {
      await f.coordinator.close();
    }
  });

  it("clips a sole oversized waiting extraction to budget, preserves the unconsumed tail, and shrinks cleanly on invalid_request", async () => {
    const sessionKey = "b".repeat(64);
    const paragraphs = Array.from(
      { length: 120 },
      (_, idx) =>
        `fact-${String(idx).padStart(3, "0")} \u{1F525} ${"r".repeat(985)}`,
    );
    const oversizedRawMemory = paragraphs.join("\n\n");
    const totalRawBytes = Buffer.byteLength(oversizedRawMemory, "utf8");
    expect(totalRawBytes).toBeGreaterThanOrEqual(120_000);

    // 1. Model rejects input over 49,000 bytes: pass 1 sends a clipped head,
    // logs agent_memory.extraction_clipped, publishes cleanly, and preserves
    // the unconsumed tail in session.raw_memory; subsequent consolidations
    // consume the remaining tail until raw_memory is "" with zero lost content.
    const fFit = fixture({
      contextWindow: () => 65_536,
      canReadHistory: () => false,
    });
    fFit.documents.set("A", {
      revision: 6,
      summary: "",
      memory: "",
      cursors: {},
      sessions: {
        [sessionKey]: waitingSession(oversizedRawMemory, 6),
      },
    });
    const observedRemainingBeforeCall: string[] = [];
    fFit.respond.mockImplementation(async (request) => {
      observedRemainingBeforeCall.push(
        fFit.documents.get("A")!.sessions[sessionKey]!.raw_memory,
      );
      if (
        stageOf(request) === "consolidate" &&
        Buffer.byteLength(request.input, "utf8") > 49_000
      ) {
        throw new ModelCallError(
          "invalid_request",
          "Model invocation prompt exceeded the model context window",
        );
      }
      return validOutput(request);
    });
    try {
      await fFit.coordinator.wake("A");
      const calls = fFit.respond.mock.calls
        .map(([r]) => r)
        .filter((r) => stageOf(r) === "consolidate");
      expect(calls.length).toBeGreaterThanOrEqual(3);
      for (const call of calls) {
        expect(inputBytes(call)).toBeLessThanOrEqual(49_152);
        expect(Buffer.byteLength(call.input, "utf8")).toBeLessThanOrEqual(
          49_000,
        );
      }
      // After pass 1 published, session.raw_memory preserved the unconsumed
      // tail (non-empty and strictly shorter than the initial 120 KB).
      expect(observedRemainingBeforeCall[0]).toBe(oversizedRawMemory);
      const afterPass1 = observedRemainingBeforeCall[1]!;
      expect(afterPass1.length).toBeGreaterThan(0);
      expect(Buffer.byteLength(afterPass1, "utf8")).toBeLessThan(totalRawBytes);
      for (let i = 1; i < observedRemainingBeforeCall.length; i += 1) {
        expect(
          Buffer.byteLength(observedRemainingBeforeCall[i]!, "utf8"),
        ).toBeLessThan(
          Buffer.byteLength(observedRemainingBeforeCall[i - 1]!, "utf8"),
        );
      }
      expect(fFit.logger.log).toHaveBeenCalledWith(
        "warn",
        "agent_memory.extraction_clipped",
        expect.objectContaining({
          agentId: "A",
          session_id: sessionKey,
          before_bytes: expect.any(Number),
          after_bytes: expect.any(Number),
          remaining_bytes: expect.any(Number),
        }),
      );
      const firstClipLog = vi
        .mocked(fFit.logger.log)
        .mock.calls.find(
          ([, event]) => event === "agent_memory.extraction_clipped",
        )![2] as {
        before_bytes: number;
        after_bytes: number;
        remaining_bytes: number;
      };
      expect(firstClipLog.after_bytes).toBeLessThan(firstClipLog.before_bytes);
      expect(firstClipLog.remaining_bytes).toBe(
        Buffer.byteLength(afterPass1, "utf8"),
      );
      const sentChunks = calls.map(
        (call) =>
          (
            JSON.parse(call.input) as {
              extractions: { raw_memory: string }[];
            }
          ).extractions[0]!.raw_memory,
      );
      // Clean paragraph boundary splits preserve every paragraph and never
      // break UTF-16 surrogate pairs.
      for (const chunk of sentChunks) {
        expect(Buffer.from(chunk, "utf8").toString("utf8")).toBe(chunk);
      }
      expect(sentChunks.join("\n\n")).toBe(oversizedRawMemory);
      expect(fFit.documents.get("A")!.pending).toBeUndefined();
      expect(fFit.documents.get("A")!.memory).toContain("lantern-482");
      expect(fFit.documents.get("A")!.sessions[sessionKey]!.raw_memory).toBe(
        "",
      );
    } finally {
      await fFit.coordinator.close();
    }

    // 2. Resuming a clipped consolidate checkpoint across a restart publishes
    // the head, keeps the unconsumed tail in session.raw_memory, and a later
    // consolidation consumes the rest with zero lost content.
    const fResume = fixture({
      contextWindow: () => 65_536,
      canReadHistory: () => false,
    });
    fResume.documents.set("A", {
      revision: 6,
      summary: "",
      memory: "",
      cursors: {},
      sessions: {
        [sessionKey]: waitingSession(oversizedRawMemory, 6),
      },
    });
    let failSecondChunk = true;
    fResume.respond.mockImplementation(async (request) => {
      if (fResume.respond.mock.calls.length === 2 && failSecondChunk) {
        failSecondChunk = false;
        throw new ModelCallError("computer_offline", "Computer is offline");
      }
      return validOutput(request);
    });
    try {
      await fResume.coordinator.wake("A");
      const midDoc = fResume.documents.get("A")!;
      expect(midDoc.memory).toContain("lantern-482");
      expect(midDoc.sessions[sessionKey]!.raw_memory.length).toBeGreaterThan(0);
      expect(
        Buffer.byteLength(midDoc.sessions[sessionKey]!.raw_memory, "utf8"),
      ).toBeLessThan(totalRawBytes);

      fResume.advance(60_000);
      await fResume.coordinator.wake("A");
      const finalDoc = fResume.documents.get("A")!;
      expect(finalDoc.pending).toBeUndefined();
      expect(finalDoc.sessions[sessionKey]!.raw_memory).toBe("");
      const succeededChunks = fResume.respond.mock.calls
        .filter((_, idx) => idx !== 1)
        .map(
          ([call]) =>
            (
              JSON.parse(call.input) as {
                extractions: { raw_memory: string }[];
              }
            ).extractions[0]!.raw_memory,
        );
      expect(succeededChunks.join("\n\n")).toBe(oversizedRawMemory);
    } finally {
      await fResume.coordinator.close();
    }

    // 3. Model rejects input over 20,000 bytes: adaptive shrinking decreases
    // call sizes strictly across retries until consolidation publishes and
    // drains the remaining tail cleanly with zero lost content.
    const fShrink = fixture({
      contextWindow: () => 65_536,
      canReadHistory: () => false,
    });
    fShrink.documents.set("A", {
      revision: 6,
      summary: "",
      memory: "",
      cursors: {},
      sessions: {
        [sessionKey]: waitingSession(oversizedRawMemory, 6),
      },
    });
    const shrinkRejectedSizes: number[] = [];
    const shrinkSucceededChunks: string[] = [];
    fShrink.respond.mockImplementation(async (request) => {
      const size = Buffer.byteLength(request.input, "utf8");
      if (stageOf(request) === "consolidate" && size > 20_000) {
        shrinkRejectedSizes.push(size);
        throw new ModelCallError(
          "invalid_request",
          "Model invocation prompt exceeded the model context window",
        );
      }
      shrinkSucceededChunks.push(
        (
          JSON.parse(request.input) as {
            extractions: { raw_memory: string }[];
          }
        ).extractions[0]!.raw_memory,
      );
      return validOutput(request);
    });
    try {
      await fShrink.coordinator.wake("A");
      const calls = fShrink.respond.mock.calls
        .map(([r]) => r)
        .filter((r) => stageOf(r) === "consolidate");
      expect(shrinkRejectedSizes.length).toBeGreaterThanOrEqual(2);
      expect(inputBytes(calls[0]!)).toBeLessThanOrEqual(49_152);
      for (let i = 1; i < shrinkRejectedSizes.length; i += 1) {
        expect(shrinkRejectedSizes[i]!).toBeLessThan(
          shrinkRejectedSizes[i - 1]!,
        );
      }
      const firstSuccessSize = Buffer.byteLength(
        calls[shrinkRejectedSizes.length]!.input,
        "utf8",
      );
      expect(firstSuccessSize).toBeLessThan(shrinkRejectedSizes.at(-1)!);
      expect(firstSuccessSize).toBeLessThanOrEqual(20_000);
      expect(shrinkSucceededChunks.join("\n\n")).toBe(oversizedRawMemory);
      expect(fShrink.documents.get("A")!.pending).toBeUndefined();
      expect(fShrink.documents.get("A")!.memory).toContain("lantern-482");
      expect(fShrink.documents.get("A")!.sessions[sessionKey]!.raw_memory).toBe(
        "",
      );
    } finally {
      await fShrink.coordinator.close();
    }

    // 4. When only session summary exceeds budget while raw_memory fits whole,
    // extraction_clipped logs remaining_bytes: 0 and publication clears
    // session.raw_memory to "".
    const fSummaryClip = fixture({
      contextWindow: () => 20_000,
      canReadHistory: () => false,
    });
    fSummaryClip.documents.set("A", {
      revision: 6,
      summary: "",
      memory: "",
      cursors: {},
      sessions: {
        [sessionKey]: {
          ...waitingSession("small candidate fact", 6),
          summary: "s".repeat(25_000),
        },
      },
    });
    try {
      await fSummaryClip.coordinator.wake("A");
      expect(fSummaryClip.stages()).toEqual(["consolidate"]);
      expect(fSummaryClip.logger.log).toHaveBeenCalledWith(
        "warn",
        "agent_memory.extraction_clipped",
        expect.objectContaining({
          agentId: "A",
          session_id: sessionKey,
          remaining_bytes: 0,
        }),
      );
      expect(
        fSummaryClip.documents.get("A")!.sessions[sessionKey]!.raw_memory,
      ).toBe("");
    } finally {
      await fSummaryClip.coordinator.close();
    }

    // 5. Unspaced surrogate-pair text splits without breaking UTF-16 pairs and
    // reassembles identically across consolidations.
    const fEmoji = fixture({
      contextWindow: () => 20_000,
      canReadHistory: () => false,
    });
    const emojiRawMemory = "\u{1F525}".repeat(10_000);
    fEmoji.documents.set("A", {
      revision: 6,
      summary: "",
      memory: "",
      cursors: {},
      sessions: {
        [sessionKey]: waitingSession(emojiRawMemory, 6),
      },
    });
    try {
      await fEmoji.coordinator.wake("A");
      const emojiChunks = fEmoji.respond.mock.calls.map(
        ([call]) =>
          (
            JSON.parse(call.input) as {
              extractions: { raw_memory: string }[];
            }
          ).extractions[0]!.raw_memory,
      );
      expect(emojiChunks.length).toBeGreaterThan(1);
      for (const chunk of emojiChunks) {
        expect(Buffer.from(chunk, "utf8").toString("utf8")).toBe(chunk);
      }
      expect(emojiChunks.join("")).toBe(emojiRawMemory);
      expect(fEmoji.documents.get("A")!.sessions[sessionKey]!.raw_memory).toBe(
        "",
      );
    } finally {
      await fEmoji.coordinator.close();
    }
  });

  it("rebuilds oversized persisted extract and consolidate checkpoints through the single builder", async () => {
    // 1. Oversized persisted consolidate checkpoint on a 65K model.
    const fConsolidate = fixture({
      contextWindow: () => 65_536,
      canReadHistory: () => false,
    });
    const hugeMemory = Array.from(
      { length: 20 },
      (_, idx) => `## Section ${idx}\n\n${"k".repeat(4_000)}\n`,
    ).join("\n");
    const sessionKey = "e".repeat(64);
    const oversizedConsolidate = JSON.stringify({
      previous: { summary: "s".repeat(10_000), memory: hugeMemory },
      memory_sections: Array.from({ length: 20 }, (_, idx) => `Section ${idx}`),
      extractions: [
        {
          key: sessionKey,
          context_key: "source",
          summary: "sum",
          raw_memory: "r".repeat(20_000),
        },
      ],
    });
    expect(Buffer.byteLength(oversizedConsolidate, "utf8")).toBeGreaterThan(
      100_000,
    );
    fConsolidate.documents.set("A", {
      revision: 2,
      summary: "",
      memory: "",
      cursors: {},
      sessions: { [sessionKey]: waitingSession("r".repeat(20_000), 2) },
      pending: { stage: "consolidate", prompt: oversizedConsolidate },
    });
    try {
      await fConsolidate.coordinator.reconcile();
      const firstCall = fConsolidate.respond.mock.calls[0]![0];
      expect(stageOf(firstCall)).toBe("consolidate");
      expect(inputBytes(firstCall)).toBeLessThanOrEqual(49_152);
      expect(fConsolidate.documents.get("A")!.pending).toBeUndefined();
    } finally {
      await fConsolidate.coordinator.close();
    }

    // 2. Oversized persisted extract checkpoint on a 65K model.
    const fExtract = fixture({ contextWindow: () => 65_536 });
    const legacyRecords = Array.from({ length: 30 }, (_, ordinal) => ({
      ordinal,
      category: "message",
      nativeRecord: {
        role: "user",
        text: `legacy-${ordinal} ${"x".repeat(3_500)}`,
      },
    }));
    vi.mocked(fExtract.host.inspectDebugContextHistory).mockResolvedValue({
      status: "available",
      snapshot: {
        id: "snapshot-legacy",
        threadId: "thread-legacy",
        tailState: "clean",
        recordCount: legacyRecords.length,
      },
      records: legacyRecords,
    } as never);
    const legacyPrompt = JSON.stringify({
      source_context: "source",
      previous: null,
      records: legacyRecords,
    });
    expect(Buffer.byteLength(legacyPrompt, "utf8")).toBeGreaterThan(100_000);
    fExtract.documents.set("A", {
      revision: 1,
      summary: "",
      memory: "",
      sessions: {},
      cursors: {},
      pending: {
        stage: "extract",
        prompt: legacyPrompt,
        source_key: "a".repeat(64),
        thread_id: "thread-legacy",
        through: 29,
      },
    });
    try {
      await fExtract.coordinator.reconcile();
      const firstExtract = fExtract.respond.mock.calls[0]![0];
      expect(stageOf(firstExtract)).toBe("extract");
      expect(inputBytes(firstExtract)).toBeLessThanOrEqual(49_152);
      expect(fExtract.documents.get("A")!.pending).toBeUndefined();
    } finally {
      await fExtract.coordinator.close();
    }
  });

  it("skips an indivisible oversized record rather than looping forever", async () => {
    const f = fixture({ contextWindow: () => 20_000 });
    // Build one record whose unclippable JSON structure alone exceeds room, followed by a normal record.
    const hugeArray = Array.from({ length: 6_000 }, (_, i) => i);
    const records = [
      {
        ordinal: 0,
        category: "tool_result",
        nativeRecord: { numbers: hugeArray },
      },
      {
        ordinal: 1,
        category: "message",
        nativeRecord: { role: "user", text: "Keep lantern-482 alive." },
      },
    ];
    vi.mocked(f.host.inspectDebugContextHistory).mockResolvedValue({
      status: "available",
      snapshot: {
        id: "snapshot-oversized",
        threadId: "thread-oversized",
        tailState: "clean",
        recordCount: records.length,
      },
      records,
    } as never);
    try {
      await f.coordinator.wake("A");
      expect(f.logger.log).toHaveBeenCalledWith(
        "warn",
        "agent_memory.record_skipped_oversized",
        expect.objectContaining({
          agentId: "A",
          ordinal: 0,
          source_key: expect.any(String),
          room_bytes: expect.any(Number),
        }),
      );
      expect(f.stages()).toEqual(["extract", "consolidate"]);
      expect(f.respond.mock.calls[0]![0].input).toContain("lantern-482");
      expect(Object.values(f.documents.get("A")!.cursors)).toEqual([
        { thread_id: "thread-oversized", through: 1 },
      ]);
    } finally {
      await f.coordinator.close();
    }
  });

  it("builds no stage while the window cannot be read and backs off", async () => {
    const contextWindow = vi.fn((): number | undefined => {
      throw new Error("Local Computer is offline");
    });
    const f = fixture({ contextWindow });
    try {
      await f.coordinator.wake("A");
      expect(f.respond).not.toHaveBeenCalled();
      expect(f.documents.get("A")).toBeUndefined();
      expect(f.logger.log).toHaveBeenCalledWith(
        "warn",
        "agent_memory.reconcile_failed",
        expect.objectContaining({ agentId: "A" }),
      );
      contextWindow.mockReturnValue(WINDOW);
      f.advance(60_000);
      await f.coordinator.wake("A");
      expect(f.stages()).toEqual(["extract", "consolidate"]);
    } finally {
      await f.coordinator.close();
    }
  });

  it("persists pending.target, survives offline switch and restart, and recovers on Runtime or model change", async () => {
    let runtimeType: "codex" | "claude" = "codex";
    let model = "gpt-5-old";
    let readable = true;
    const f = fixture({ canReadHistory: () => readable });
    vi.mocked(f.host.getGhost).mockImplementation(
      async () =>
        ({
          runtime: {
            type: "local",
            model,
            placement: {
              ...OWNER,
              computerId: "computer-1",
              runtimeType,
            },
          },
        }) as never,
    );
    f.respond.mockImplementation(async (request) => {
      if (model === "gpt-5-old" && stageOf(request) === "extract") {
        throw new ModelCallError("timed_out", "Timed out on previous model");
      }
      return validOutput(request);
    });
    try {
      await f.coordinator.wake("A");
      f.advance(60_000);
      await f.coordinator.wake("A");
      f.advance(2 * 60_000);
      await f.coordinator.wake("A");
      expect(f.documents.get("A")!.pending).toMatchObject({
        stage: "extract",
        attempt: 3,
        target: JSON.stringify(["computer-1", "codex", "gpt-5-old"]),
      });

      // Switch Runtime while Computer history is offline: must NOT overwrite pending.target.
      runtimeType = "claude";
      model = "claude-sonnet-4-6";
      readable = false;
      f.advance(4 * 60_000);
      await f.coordinator.wake("A");
      expect(f.documents.get("A")!.pending).toMatchObject({
        stage: "extract",
        attempt: 3,
        target: JSON.stringify(["computer-1", "codex", "gpt-5-old"]),
      });

      // Once Computer is readable again, the persisted target mismatch resets the checkpoint.
      readable = true;
      f.advance(8 * 60_000);
      await f.coordinator.wake("A");
      expect(f.logger.log).toHaveBeenCalledWith(
        "info",
        "agent_memory.pending_reset",
        expect.objectContaining({
          agentId: "A",
          stage: "extract",
          reason: "runtime_changed",
        }),
      );
      expect(f.documents.get("A")!.pending).toBeUndefined();
      expect(f.documents.get("A")!.memory).toContain("lantern-482");
    } finally {
      await f.coordinator.close();
    }
  });

  it("recovers a persisted exhausted consolidate checkpoint after restart when target changed", async () => {
    const f = fixture();
    f.documents.set("A", {
      revision: 3,
      summary: "",
      memory: "",
      sessions: {
        ["a".repeat(64)]: {
          context_key: encodeExecutionContextRef({
            kind: "meta",
            agentId: "A",
            roomId: "room-A",
          }),
          thread_id: "thread-A",
          through: 1,
          updated_revision: 3,
          summary: "Discussed lantern-482",
          raw_memory: "Remember lantern-482",
        },
      },
      cursors: {},
      pending: {
        stage: "consolidate",
        prompt: JSON.stringify({
          previous: "",
          memory_sections: [],
          extractions: [],
        }),
        attempt: 3,
        target: JSON.stringify(["computer-1", "codex", "gpt-5-old"]),
      },
    });
    try {
      await f.coordinator.wake("A");
      expect(f.logger.log).toHaveBeenCalledWith(
        "info",
        "agent_memory.pending_reset",
        expect.objectContaining({
          agentId: "A",
          stage: "consolidate",
          reason: "runtime_changed",
        }),
      );
      expect(f.documents.get("A")!.pending).toBeUndefined();
      expect(f.documents.get("A")!.memory).toContain("lantern-482");
    } finally {
      await f.coordinator.close();
    }
  });

  it("recovers an exhausted extract checkpoint on the same target when the native thread changed", async () => {
    const f = fixture();
    const contextKey = encodeExecutionContextRef({
      kind: "meta",
      agentId: "A",
      roomId: "room-A",
    });
    f.documents.set("A", {
      revision: 3,
      summary: "",
      memory: "",
      sessions: {},
      cursors: {},
      pending: {
        stage: "extract",
        prompt: JSON.stringify({
          source_context: contextKey,
          previous: null,
          records: [],
        }),
        source_key: "source-key",
        thread_id: "old-thread-from-prior-runtime",
        through: 0,
        attempt: 3,
        target: JSON.stringify(["computer-1", "codex", ""]),
      },
    });
    try {
      await f.coordinator.wake("A");
      expect(f.logger.log).toHaveBeenCalledWith(
        "info",
        "agent_memory.pending_reset",
        expect.objectContaining({
          agentId: "A",
          stage: "extract",
          reason: "thread_changed",
        }),
      );
      expect(f.documents.get("A")!.pending).toBeUndefined();
      expect(f.documents.get("A")!.memory).toContain("lantern-482");
    } finally {
      await f.coordinator.close();
    }
  });

  it("recovers a legacy exhausted consolidate checkpoint without target once after upgrade", async () => {
    const f = fixture();
    f.documents.set("A", {
      revision: 3,
      summary: "",
      memory: "",
      sessions: {
        ["a".repeat(64)]: {
          context_key: encodeExecutionContextRef({
            kind: "meta",
            agentId: "A",
            roomId: "room-A",
          }),
          thread_id: "thread-A",
          through: 1,
          updated_revision: 3,
          summary: "Discussed lantern-482",
          raw_memory: "Remember lantern-482",
        },
      },
      cursors: {},
      pending: {
        stage: "consolidate",
        prompt: JSON.stringify({
          previous: "",
          memory_sections: [],
          extractions: [],
        }),
        attempt: 3,
      },
    });
    try {
      await f.coordinator.wake("A");
      expect(f.logger.log).toHaveBeenCalledWith(
        "info",
        "agent_memory.pending_reset",
        expect.objectContaining({
          agentId: "A",
          stage: "consolidate",
          reason: "legacy_target_unknown",
        }),
      );
      expect(f.documents.get("A")!.pending).toBeUndefined();
      expect(f.documents.get("A")!.memory).toContain("lantern-482");
    } finally {
      await f.coordinator.close();
    }
  });
});
