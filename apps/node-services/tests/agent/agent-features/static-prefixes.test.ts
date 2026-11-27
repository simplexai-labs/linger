import { describe, expect, it, vi } from "vitest";

import {
  createBuiltinAgentFeatures,
  type BuiltinFeatureServices,
} from "../../../src/agent/agent-features/builtin.js";
import type { BuiltinFeatureHost } from "../../../src/agent/agent-features/host-ports.js";
import { createUserMemoryTracker } from "../../../src/agent/agent-features/user-memory/index.js";
import type { AgentLogger } from "../../../src/agent/observability/agent-log.js";
import {
  COMPACT_INSTRUCTIONS_MAX_CONTEXT_WINDOW,
  STATIC_PREFIX_END_MARKER,
  renderStaticPrefixBundle,
} from "../../../src/agent/prompt/index.js";
import type { ExecutionContextRef } from "../../../src/agent/executor/context-ref.js";
import { makeTestFeatureContext } from "./fixtures.js";

const warmupSponsor = {
  actorId: "actor:warmup-sponsor",
  displayName: "Warmup Sponsor",
} as const;

interface PrefixCase {
  readonly contextKind: "meta" | "alter_ego";
  readonly compact: boolean;
  readonly connectedApps: boolean;
  readonly permissionReview: boolean;
}

const cases: readonly PrefixCase[] = (["meta", "alter_ego"] as const).flatMap(
  (contextKind) =>
    [false, true].flatMap((compact) =>
      [false, true].flatMap((connectedApps) =>
        [false, true].map((permissionReview) => ({
          contextKind,
          compact,
          connectedApps,
          permissionReview,
        })),
      ),
    ),
);

function createFullStubbedServices(): BuiltinFeatureServices {
  const logger: AgentLogger = { log: vi.fn(), child: () => logger };
  return {
    logger,
    runWakes: { registerTarget: vi.fn(() => ({ stop: vi.fn() })) },
    flashback: {
      client: {
        suggest: vi.fn(async () => ({ reason: "no_cue" as const })),
        record: vi.fn(async () => undefined),
      },
    },
    proactive: {
      client: {
        window: vi.fn(async () => undefined),
        finish: vi.fn(async () => true),
        queueWake: vi.fn(async () => undefined),
      },
    },
    taskProgress: {
      client: {
        read: vi.fn(async () => ({ live_foreground: false, tasks: [] })),
      },
    },
    roomReplyGuard: {
      readReplyStatus: vi.fn(async () => ({ replied: true })),
    },
    agentMemory: {
      agentMemory: {
        recordRun: vi.fn(async () => undefined),
        wake: vi.fn(async () => undefined),
      },
      agentMemoryProjection: {
        prepare: vi.fn(async () => ({ summary: "memory summary" })),
      },
    },
    contextRestart: {},
    resolveUserMemory: vi.fn(async () => ({
      version: 1,
      markdown: "# Memory",
    })),
    userMemories: createUserMemoryTracker(),
    replyRhythm: {
      settings: {
        activationRate: 1,
        enabled: true,
        maxMessageCount: 4,
        minMessageCount: 2,
        version: "v1",
      },
    },
  };
}

function createFullStubbedHost(): BuiltinFeatureHost {
  return {
    inbox: { takeUpQueuedInput: vi.fn() },
    trackBackground: vi.fn(),
    timers: { set: vi.fn(), clear: vi.fn() },
  };
}

function renderComposedStaticPrefix(entry: PrefixCase): string {
  const ref: ExecutionContextRef =
    entry.contextKind === "meta"
      ? { kind: "meta", agentId: "agent-warmup", roomId: "room-warmup" }
      : { kind: "alter_ego", agentId: "agent-warmup", taskId: "task-warmup" };
  const { context } = makeTestFeatureContext({
    ref,
    ...(entry.contextKind === "meta" ? { roomKind: "direct" as const } : {}),
    identity: {
      actorId: "actor:warmup-agent",
      agentType: "anotherme",
      sponsor: warmupSponsor,
      representedHuman: warmupSponsor,
    },
    agentName: "Warmup Agent",
    agent: { name: "Warmup Agent", instructions: "unused" },
    capabilities: entry.permissionReview ? ["permissionReview"] : [],
  });
  const composed = createBuiltinAgentFeatures({
    services: createFullStubbedServices(),
  })
    .composeContext({
      context,
      host: createFullStubbedHost(),
    })
    .contextInstructions({
      connectedApps: entry.connectedApps,
      connectedAppKeys: [],
      connectableAppKeys: [],
      compactInstructions: entry.compact,
    });
  if (!composed) {
    throw new Error("Expected composed context instructions");
  }
  const delimiter = `\n\n${STATIC_PREFIX_END_MARKER}`;
  const markerIndex = composed.indexOf(delimiter);
  if (markerIndex === -1) {
    throw new Error(
      "Expected STATIC_PREFIX_END_MARKER in composed instructions",
    );
  }
  return composed.slice(0, markerIndex);
}

const WARMUP_PLACEHOLDERS = [
  "Warmup Agent",
  "actor:warmup-agent",
  "Warmup Sponsor",
  "actor:warmup-sponsor",
  "room-warmup",
  "task-warmup",
  "agent-warmup",
  "tenant-warmup",
] as const;

describe("renderStaticPrefixBundle", () => {
  it("reports schema version, marker, and compact context threshold", () => {
    const bundle = renderStaticPrefixBundle({
      connectedApps: true,
      permissionReview: true,
    });
    expect(bundle.version).toBe(1);
    expect(bundle.marker).toBe(STATIC_PREFIX_END_MARKER);
    expect(bundle.compact_max_context_tokens).toBe(
      COMPACT_INSTRUCTIONS_MAX_CONTEXT_WINDOW,
    );
    expect(bundle.compact_max_context_tokens).toBe(128 * 1024);
  });

  it.each(cases)(
    "matches full builtin feature composition byte-for-byte ($contextKind, compact=$compact, connectedApps=$connectedApps, permissionReview=$permissionReview)",
    (entry) => {
      const bundle = renderStaticPrefixBundle({
        connectedApps: entry.connectedApps,
        permissionReview: entry.permissionReview,
      });
      const variant = entry.compact ? "compact" : "full";
      const rendered = bundle.prefixes[entry.contextKind][variant];
      expect(rendered).toBe(renderComposedStaticPrefix(entry));
      for (const placeholder of WARMUP_PLACEHOLDERS) {
        expect(rendered).not.toContain(placeholder);
      }
    },
  );
});
