import {
  createBuiltinAgentFeatures,
  type BuiltinAgentFeatures,
} from "../agent-features/builtin.js";
import type { FeatureContext } from "../agent-features/contracts.js";
import type { BuiltinFeatureHost } from "../agent-features/host-ports.js";
import type { ExecutionContextRef } from "../executor/context-ref.js";
import type { AgentLogger } from "../observability/agent-log.js";
import { STATIC_PREFIX_END_MARKER } from "./prefix-boundary.js";

// Models with at most a 128K-token context window, such as local models, get
// the compact instructions.
export const COMPACT_INSTRUCTIONS_MAX_CONTEXT_WINDOW = 128 * 1024;

export interface StaticPrefixVariants {
  readonly full: string;
  readonly compact: string;
}

export interface StaticPrefixBundle {
  readonly version: 1;
  readonly marker: string;
  readonly compact_max_context_tokens: number;
  readonly prefixes: {
    readonly meta: StaticPrefixVariants;
    readonly alter_ego: StaticPrefixVariants;
  };
}

export interface RenderStaticPrefixBundleOptions {
  readonly connectedApps: boolean;
  readonly permissionReview: boolean;
}

const STATIC_WARMUP_SPONSOR = {
  actorId: "actor:warmup-sponsor",
  displayName: "Warmup Sponsor",
} as const;

const SILENT_LOGGER: AgentLogger = {
  log() {},
  child() {
    return SILENT_LOGGER;
  },
};

const STATIC_FEATURE_HOST: BuiltinFeatureHost = {
  trackBackground() {},
  timers: {
    set() {},
    clear() {},
  },
};

let cachedBuiltinFeatures: BuiltinAgentFeatures | undefined;

function getStaticBuiltinFeatures(): BuiltinAgentFeatures {
  cachedBuiltinFeatures ??= createBuiltinAgentFeatures({
    services: { logger: SILENT_LOGGER },
  });
  return cachedBuiltinFeatures;
}

function renderStaticPrefixVariant(
  contextKind: "meta" | "alter_ego",
  compact: boolean,
  options: RenderStaticPrefixBundleOptions,
): string {
  const ref: ExecutionContextRef =
    contextKind === "meta"
      ? { kind: "meta", agentId: "agent-warmup", roomId: "room-warmup" }
      : { kind: "alter_ego", agentId: "agent-warmup", taskId: "task-warmup" };
  const context: FeatureContext = {
    ref,
    ...(contextKind === "meta" ? { roomKind: "direct" as const } : {}),
    configurationRevision: "warmup",
    runtime: undefined,
    identity: {
      actorId: "actor:warmup-agent",
      agentType: "anotherme",
      representedHuman: STATIC_WARMUP_SPONSOR,
      sponsor: STATIC_WARMUP_SPONSOR,
    },
    tenantId: "tenant-warmup",
    actorId: "actor:warmup-agent",
    agentName: "Warmup Agent",
    agent: { name: "Warmup Agent", instructions: "" },
    capabilities: options.permissionReview ? ["permissionReview"] : [],
    signal: new AbortController().signal,
    activeRunId: () => undefined,
    steer: async () => ({ status: "skipped", reason: "static prefix warmup" }),
    followUp: async () => ({
      status: "skipped",
      reason: "static prefix warmup",
    }),
  };

  const composed = getStaticBuiltinFeatures()
    .composeContext({ context, host: STATIC_FEATURE_HOST })
    .contextInstructions({
      connectedApps: options.connectedApps,
      connectedAppKeys: [],
      connectableAppKeys: [],
      compactInstructions: compact,
    });
  const delimiter = `\n\n${STATIC_PREFIX_END_MARKER}`;
  const markerIndex = composed?.indexOf(delimiter) ?? -1;
  if (!composed || markerIndex === -1) {
    throw new Error(
      `Expected ${STATIC_PREFIX_END_MARKER} in composed static prefix`,
    );
  }
  return composed.slice(0, markerIndex);
}

/**
 * Renders the static system prompt prefixes shared across Agents on this
 * deployment so a Daemon can prefill and pin them right after a model loads.
 */
export function renderStaticPrefixBundle(
  options: RenderStaticPrefixBundleOptions,
): StaticPrefixBundle {
  return {
    version: 1,
    marker: STATIC_PREFIX_END_MARKER,
    compact_max_context_tokens: COMPACT_INSTRUCTIONS_MAX_CONTEXT_WINDOW,
    prefixes: {
      meta: {
        full: renderStaticPrefixVariant("meta", false, options),
        compact: renderStaticPrefixVariant("meta", true, options),
      },
      alter_ego: {
        full: renderStaticPrefixVariant("alter_ego", false, options),
        compact: renderStaticPrefixVariant("alter_ego", true, options),
      },
    },
  };
}
