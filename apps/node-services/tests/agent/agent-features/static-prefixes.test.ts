import { describe, expect, it } from "vitest";

import { composeContextFeatures } from "../../../src/agent/agent-features/compose.js";
import { createContextInstructionsFeature } from "../../../src/agent/agent-features/context-instructions/feature.js";
import { createEmojiReactionFeature } from "../../../src/agent/agent-features/emoji-reaction/feature.js";
import { createToolApprovalFeature } from "../../../src/agent/agent-features/tool-approval/feature.js";
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
  const composed = composeContextFeatures({
    context,
    features: [
      createContextInstructionsFeature(),
      createToolApprovalFeature(),
      createEmojiReactionFeature(),
    ],
  }).contextInstructions({
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
    "matches composed static prefix byte-for-byte ($contextKind, compact=$compact, connectedApps=$connectedApps, permissionReview=$permissionReview)",
    (entry) => {
      const bundle = renderStaticPrefixBundle({
        connectedApps: entry.connectedApps,
        permissionReview: entry.permissionReview,
      });
      const variant = entry.compact ? "compact" : "full";
      expect(bundle.prefixes[entry.contextKind][variant]).toBe(
        renderComposedStaticPrefix(entry),
      );
    },
  );
});
