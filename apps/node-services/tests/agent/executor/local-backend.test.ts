import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type {
  OperationResult,
  RunEvent,
} from "@linger/wire-contracts/runner-gateway/types";

import { createLocalContextRuntimeBackend } from "../../../src/agent/executor/local-backend.js";
import type { ContextRuntimeBackendRequest } from "../../../src/agent/executor/activation.js";
import { encodeExecutionContextRef } from "../../../src/agent/executor/context-ref.js";
import { createMemoryProjection } from "../../../src/agent/agent-features/agent-memory/projection.js";
import {
  createContextViewContent,
  type ContextViewContent,
  type ContextViewManifest,
  type ContextViewSnapshotInput,
} from "../../../src/agent/runner-gateway/context-view-content.js";
import type { LocalRuntimeModelDefinition } from "../../../src/agent/runner-gateway/local-computer-management.js";
import type {
  RunnerOperation,
  RunnerOperationTarget,
} from "../../../src/agent/runner-gateway/runner-gateway.js";
import type { LocalRuntimeSettings } from "../../../src/agent/runtime-settings.js";
import type { RunnerContextDebugInspector } from "../../../src/agent/runner-gateway/runner-gateway-context.js";

const CONTEXT_KEY = encodeExecutionContextRef({
  kind: "meta",
  agentId: "agent-1",
  roomId: "room-1",
});

function requestFixture(): ContextRuntimeBackendRequest<LocalRuntimeSettings> {
  return {
    ref: { kind: "meta", agentId: "agent-1", roomId: "room-1" },
    tenantId: "tenant-1",
    actorId: "actor-1",
    runtimeInstanceKey: CONTEXT_KEY,
    viewPlan: {
      ref: { kind: "meta", agentId: "agent-1", roomId: "room-1" },
      contextKey: CONTEXT_KEY,
      mappings: [],
    },
    agent: { name: "Local Agent", instructions: "Be useful." },
    runtime: {
      type: "local",
      model: "codex-default",
      placement: {
        type: "local",
        tenantId: "tenant-1",
        ownerActorId: "owner-1",
        computerId: "computer-1",
        runtimeType: "codex",
        workspaceGrantId: "workspace-1",
        assignmentRevision: 1,
      },
    },
    resources: { skills: [] },
    signal: new AbortController().signal,
    logger: {
      child() {
        return this;
      },
      log() {},
    },
  };
}

/** Publishes the queued digests in order and records each release. */
function viewContent(...digests: string[]) {
  const events: string[] = [];
  const inputs: ContextViewSnapshotInput[] = [];
  const content: ContextViewContent = {
    async snapshot(input) {
      inputs.push(input);
      const viewDigest = digests.shift();
      if (!viewDigest) throw new Error("unexpected Context View snapshot");
      events.push(`snapshot:${viewDigest[0]}`);
      return {
        viewDigest,
        release: () => events.push(`release:${viewDigest[0]}`),
      };
    },
    contentUrl: () => "https://agent.example/v1/context-content/token",
    handle: async () => new Response(null, { status: 404 }),
  };
  return { content, events, inputs };
}

function completedOperation(
  result: OperationResult,
  events: readonly RunEvent[] = [],
): RunnerOperation {
  return {
    operationId: "operation-1",
    events: {
      async *[Symbol.asyncIterator]() {
        yield* events;
      },
    },
    result: Promise.resolve(result),
    input: async () => ({ turnId: "turn-1" }),
    cancel: async () => undefined,
  };
}

function backendFixture(
  content: ContextViewContent,
  ensureReady: () => Promise<number> = async () => 7,
  placedModel: LocalRuntimeModelDefinition = {
    id: "codex-default",
    label: "Codex default",
  },
  inspectLocalContext?: RunnerContextDebugInspector["inspectLocalContext"],
  readRevision: () => number = () => 7,
  credential?: (input: { runnerRevision: number }) => Promise<void>,
) {
  const targets: RunnerOperationTarget[] = [];
  const relay = { register: vi.fn(() => []), rebind: vi.fn(), revoke: vi.fn() };
  const placement = vi.fn(() => placedModel);
  const backend = createLocalContextRuntimeBackend({
    gateway: {
      requireLocalPlacement: placement,
      ensureReadyLocalAgentRunner: ensureReady,
      readReadyLocalAgentRunnerRevision: readRevision,
      ...(credential ? { ensureAgentCliCredential: credential } : {}),
      ...(inspectLocalContext ? { inspectLocalContext } : {}),
      async startOperation(target) {
        targets.push(target);
        return completedOperation(
          {
            type: "run",
            final_response: "done",
            session: { threadId: "thread-1" },
          },
          [
            {
              type: "run.started",
              turn_id: "turn-1",
              session: { threadId: "thread-1" },
            },
            { type: "message.delta", message_id: "message-1", delta: "done" },
            { type: "run.completed" },
          ],
        );
      },
    },
    ...(credential
      ? {
          teamhubFiles: {
            baseUrl: "http://teamhub.test",
            serviceToken: "test-token",
          },
        }
      : {}),
    contextViewContent: content,
    mcpRelay: relay,
  });
  return { backend, targets, relay, placement };
}

async function runOnce(
  activation: Awaited<
    ReturnType<ReturnType<typeof backendFixture>["backend"]["activate"]>
  >,
  runId: string,
) {
  const session = await activation.provider.createSession(
    activation.sessionSpec,
  );
  activation.setActiveRunContext({ runId, sourceInboxIds: [] });
  const run = await activation.provider.startRun(
    session,
    { type: "text", text: "hello" },
    { runContext: { executionRunRef: runId, sourceInboxIds: [] } },
  );
  await run.wait();
  activation.setActiveRunContext(null);
}

const FIRST = "a".repeat(64);
const SECOND = "b".repeat(64);
const THIRD = "c".repeat(64);

describe("Local Context Runtime backend", () => {
  it("waits for the reconnected Runner revision before preparing CLI credentials", async () => {
    let revision = 7;
    const credentials = vi.fn(async (input: { runnerRevision: number }) => {
      if (input.runnerRevision !== revision)
        throw new Error("Agent Runner placement does not match Context View");
    });
    const views = viewContent(FIRST, FIRST);
    const { backend } = backendFixture(
      views.content,
      async () => revision,
      undefined,
      undefined,
      () => revision,
      credentials,
    );
    const activation = await backend.activate(requestFixture());
    revision = 8;
    await activation.synchronize(requestFixture().viewPlan);
    expect(credentials).toHaveBeenLastCalledWith(
      expect.objectContaining({ runnerRevision: 8 }),
    );
    await activation.deactivate();
  });

  it("refreshes Runner authority before reading history after a Computer restart", async () => {
    let revision = 7;
    const ready = vi.fn(async () => revision);
    const readRevision = vi.fn(() => revision);
    const inspect = vi.fn<RunnerContextDebugInspector["inspectLocalContext"]>(
      async ({ context }) => {
        if (context.runnerRevision !== revision) {
          throw new Error("Agent Runner placement does not match Context View");
        }
        return {
          status: "available",
          provider_kind: "codex",
          source: "codex_rollout",
          snapshot: {
            id: "snapshot-1",
            thread_id: "existing-thread",
            captured_at: "2026-11-05T00:00:00Z",
            record_count: 0,
            tail_state: "clean",
          },
          instructions: {
            status: "unavailable",
            source: "codex_rollout",
            blocks: [],
          },
          records: [],
        };
      },
    );
    const views = viewContent(FIRST);
    const { backend } = backendFixture(
      views.content,
      ready,
      undefined,
      inspect,
      readRevision,
    );
    const activation = await backend.activate(requestFixture());
    revision = 8;
    const history = await activation.provider.inspectHistory!(
      { threadId: "existing-thread" },
      {},
    );
    expect(history.status).toBe("available");
    expect(inspect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          runnerRevision: 8,
          computerId: "computer-1",
          agentId: "agent-1",
          workspaceGrantId: "workspace-1",
          viewDigest: FIRST,
        }),
      }),
    );
    // History refresh does not rebuild or change the admitted View.
    expect(views.inputs).toHaveLength(1);
    expect(ready).toHaveBeenCalledTimes(1);
    readRevision.mockImplementationOnce(() => {
      throw new Error("Computer is offline");
    });
    await expect(
      activation.provider.inspectHistory!({ threadId: "existing-thread" }, {}),
    ).rejects.toThrow("Computer is offline");
    expect(inspect).toHaveBeenCalledTimes(1);
    await activation.deactivate();
  });

  it.each([
    ["codex-default", 32_768, true],
    ["codex-default", 131_072, true],
    ["codex-default", 262_144, false],
    ["codex-default", undefined, false],
    ["localmodels/qwen3.8-27b", 200_000, true],
    ["localmodels-library/spark-x2.6-4b:Q8_0", 200_000, true],
    ["localmodels/spark-x2.6-4b", undefined, true],
  ] as const)(
    "asks for compact instructions for %s with %s-token context window: %s",
    async (modelId, contextWindow, compactInstructions) => {
      const { backend } = backendFixture(
        viewContent(FIRST).content,
        undefined,
        {
          id: modelId,
          label: modelId,
          ...(contextWindow === undefined ? {} : { contextWindow }),
        },
      );
      expect(
        await backend.preflight?.({
          ref: requestFixture().ref,
          runtime: {
            ...requestFixture().runtime,
            model: modelId,
          },
          signal: requestFixture().signal,
        }),
      ).toEqual({ compactInstructions });
    },
  );

  it("wraps compact instructions in the compact Codex rules", async () => {
    const baseInstructions = async (compact: boolean) => {
      const { backend, targets } = backendFixture(viewContent(FIRST).content);
      const activation = await backend.activate({
        ...requestFixture(),
        ...(compact ? { compactInstructions: true as const } : {}),
      });
      await runOnce(activation, "run-1");
      await activation.deactivate();
      const request = targets.at(-1)!.request;
      return request.kind === "run.start"
        ? request.session_options.base_instructions
        : undefined;
    };
    expect(await baseInstructions(true)).toContain(
      "A progress report or a promise to continue is not completion.",
    );
    expect(await baseInstructions(true)).not.toContain(
      "Within your assigned scope",
    );
    expect(await baseInstructions(false)).toContain(
      "Within your assigned scope",
    );
  });

  it("publishes the activation View and names its digest in every Operation", async () => {
    const views = viewContent(FIRST);
    const { backend, targets, relay, placement } = backendFixture(
      views.content,
    );
    await backend.preflight?.({
      ref: requestFixture().ref,
      runtime: requestFixture().runtime,
      signal: requestFixture().signal,
    });
    expect(placement).toHaveBeenCalledOnce();

    const activation = await backend.activate(requestFixture());
    expect(views.inputs[0]).toMatchObject({
      computerId: "computer-1",
      runtimeInstanceId: CONTEXT_KEY,
      skills: [],
    });
    await runOnce(activation, "run-1");
    expect(targets.at(-1)).toMatchObject({
      executionContextKey: CONTEXT_KEY,
      runtimeInstanceId: CONTEXT_KEY,
      contextViewRef: { view_digest: FIRST },
      request: { kind: "run.start", run_resources: { mcp_servers: [] } },
    });
    expect(relay.register).not.toHaveBeenCalled();

    await activation.deactivate();
    expect(views.events).toEqual(["snapshot:a", "release:a"]);
  });

  it("moves to a changed View and keeps the View it replaced published", async () => {
    const views = viewContent(FIRST, SECOND, SECOND, THIRD);
    const { backend, targets } = backendFixture(views.content);
    const activation = await backend.activate(requestFixture());

    await activation.synchronize(requestFixture().viewPlan);
    await runOnce(activation, "run-1");
    expect(targets.at(-1)?.contextViewRef).toEqual({ view_digest: SECOND });
    expect(views.events).toEqual(["snapshot:a", "snapshot:b"]);

    // The same content again holds no second snapshot.
    await activation.synchronize(requestFixture().viewPlan);
    expect(views.events.slice(-2)).toEqual(["snapshot:b", "release:b"]);

    // A further change releases the oldest View, not the one it replaces.
    await activation.synchronize(
      requestFixture().viewPlan,
      new AbortController().signal,
    );
    expect(views.events.slice(-2)).toEqual(["snapshot:c", "release:a"]);

    await activation.deactivate();
    expect(views.events.slice(-2)).toEqual(["release:c", "release:b"]);
  });

  it("starts the next Run with its activation memory after the shared generations disappear", async () => {
    const agentRoot = await mkdtemp(
      path.join(os.tmpdir(), "activation-memory-"),
    );
    const request = requestFixture();
    let published = "A";
    const projection = createMemoryProjection({
      read: async () => ({
        revision: 1,
        summary: `index ${published}`,
        memory: `decision ${published}`,
        sessions: {},
        cursors: {},
      }),
      commit: vi.fn(),
    });
    const prepare = () =>
      projection.prepare(request.ref.agentId, request.signal);
    const views = createContextViewContent({
      publicOrigin: "https://agent.example",
      signingKey: "k".repeat(32),
      isCurrentConnection: (id, epoch) => id === "computer-1" && epoch === 1,
    });
    const { backend, targets } = backendFixture(views);
    const url = views.contentUrl("computer-1", 1);
    const get = (kind: string, id: string) =>
      views.handle(
        url.slice(url.lastIndexOf("/") + 1),
        kind,
        id,
        new Request(`${url}/${kind}/${id}`),
      );
    const memoryFile = async (digest: string, relativePath: string) => {
      const response = await get("views", digest);
      expect(response.status).toBe(200);
      const manifest = (await response.json()) as ContextViewManifest;
      const mapping = manifest.mappings.find(
        (m) => m.target_path === "agent-memory",
      );
      expect(mapping?.access).toBe("read_only");
      return mapping!.files.find((f) => f.relative_path === relativePath)!;
    };
    try {
      const first = await prepare();
      const planA = { ...request.viewPlan, mappings: [first.mapping!] };
      const active = await backend.activate({ ...request, viewPlan: planA });
      try {
        await runOnce(active, "run-before-change");
        const digestA = targets.at(-1)!.contextViewRef.view_digest;
        expect(first.summary).toBe("index A");
        const fileA = await memoryFile(digestA, "MEMORY.md");

        published = "B";
        await prepare();
        published = "C";
        const latest = await prepare();
        // Force the observed missing-directory failure independently of mtime.
        await rm(path.join(agentRoot, "agent-memory", "generations"), {
          recursive: true,
          force: true,
        });

        await active.synchronize(planA);
        await runOnce(active, "run-after-change");
        expect(targets.at(-1)?.contextViewRef.view_digest).toBe(digestA);
        const delayed = await get("files", fileA.sha256);
        expect(delayed.status).toBe(200);
        const original = await delayed.text();
        expect(original).toBe("decision A");
        expect(createHash("sha256").update(original).digest("hex")).toBe(
          fileA.sha256,
        );
        const summaryA = await memoryFile(digestA, "summary.md");
        expect(await (await get("files", summaryA.sha256)).text()).toBe(
          first.summary,
        );

        const reactivated = await backend.activate({
          ...request,
          viewPlan: { ...request.viewPlan, mappings: [latest.mapping!] },
        });
        try {
          await runOnce(reactivated, "run-after-reactivation");
          const digestC = targets.at(-1)!.contextViewRef.view_digest;
          expect(digestC).not.toBe(digestA);
          const fileC = await memoryFile(digestC, "MEMORY.md");
          expect(await (await get("files", fileC.sha256)).text()).toBe(
            "decision C",
          );
          const summaryC = await memoryFile(digestC, "summary.md");
          expect(latest.summary).toBe("index C");
          expect(await (await get("files", summaryC.sha256)).text()).toBe(
            latest.summary,
          );
          await active.deactivate();
          expect((await get("views", digestA)).status).toBe(404);
          expect((await get("files", fileA.sha256)).status).toBe(404);
          expect((await get("views", digestC)).status).toBe(200);
        } finally {
          await reactivated.deactivate();
        }
      } finally {
        await active.deactivate();
      }
    } finally {
      await rm(agentRoot, { recursive: true, force: true });
    }
  });

  it("releases the activation snapshot when the Runner is not ready", async () => {
    const views = viewContent(FIRST);
    const { backend } = backendFixture(views.content, async () => {
      throw new Error("Computer is not ready");
    });
    await expect(backend.activate(requestFixture())).rejects.toThrow(
      "Computer is not ready",
    );
    expect(views.events).toEqual(["snapshot:a", "release:a"]);
  });

  it("releases a fresh snapshot and keeps the current View when synchronization fails", async () => {
    const views = viewContent(FIRST, SECOND);
    let ready = 0;
    const { backend, targets } = backendFixture(views.content, async () => {
      ready += 1;
      if (ready === 2) throw new Error("Runner unavailable");
      return 7;
    });
    const activation = await backend.activate(requestFixture());

    await expect(
      activation.synchronize(requestFixture().viewPlan),
    ).rejects.toThrow("Runner unavailable");
    expect(views.events).toEqual(["snapshot:a", "snapshot:b", "release:b"]);
    await runOnce(activation, "run-1");
    expect(targets.at(-1)?.contextViewRef).toEqual({ view_digest: FIRST });
    await activation.deactivate();
  });

  it("ensures the CLI credential for the Runner revision the Computer holds now", async () => {
    // The Runner revision advanced after the activation, as it does when the
    // daemon replaces runtime-host and holds none of its Runners.
    const revisions = [7, 9];
    const ensured: number[] = [];
    const backend = createLocalContextRuntimeBackend({
      gateway: {
        requireLocalPlacement: () => ({
          id: "codex-default",
          label: "Codex default",
        }),
        ensureReadyLocalAgentRunner: async () => revisions.shift() ?? 9,
        readReadyLocalAgentRunnerRevision: () => (revisions.length ? 7 : 9),
        async ensureAgentCliCredential({ runnerRevision }) {
          if (runnerRevision !== 9)
            throw new Error("Agent Runner placement does not match");
          ensured.push(runnerRevision);
        },
        startOperation: async () =>
          completedOperation({
            type: "run",
            final_response: "done",
            session: { threadId: "thread-1" },
          }),
      },
      contextViewContent: viewContent(FIRST, FIRST).content,
      mcpRelay: { register: vi.fn(() => []), rebind: vi.fn(), revoke: vi.fn() },
      teamhubFiles: {} as never,
    });
    const activation = await backend.activate(requestFixture());

    await activation.synchronize(requestFixture().viewPlan);
    expect(ensured).toEqual([9]);
    await activation.deactivate();
  });

  it("names each Skill by its package manifest", async () => {
    const views = viewContent(FIRST);
    const { backend } = backendFixture(views.content);
    const skill = {
      skillId: "skill-1",
      packageName: "demo",
      packageSha256: "d".repeat(64),
    };
    const activation = await backend.activate({
      ...requestFixture(),
      resources: { skills: [{ ...skill, manifestId: "manifest-1" }] },
    } as unknown as ContextRuntimeBackendRequest<LocalRuntimeSettings>);
    expect(views.inputs[0]?.skills).toEqual([
      {
        package_name: "demo",
        manifest_id: "manifest-1",
        package_sha256: "d".repeat(64),
      },
    ]);
    await activation.deactivate();

    await expect(
      backendFixture(viewContent(FIRST).content).backend.activate({
        ...requestFixture(),
        resources: { skills: [skill] },
      } as unknown as ContextRuntimeBackendRequest<LocalRuntimeSettings>),
    ).rejects.toThrow("has no package manifest");
  });
});
