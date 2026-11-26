import { assembleExecutionContextDeveloperInstructions } from "../agent-features/context-instructions/context-instructions.js";
import {
  EMOJI_REACTION_INSTRUCTIONS,
  EMOJI_REACTION_INSTRUCTIONS_COMPACT,
} from "../agent-features/emoji-reaction/prompt.js";
import { STATIC_PREFIX_END_MARKER } from "./prefix-boundary.js";
import {
  TOOL_APPROVAL_PROTOCOL,
  TOOL_APPROVAL_PROTOCOL_COMPACT,
} from "./tool-approval-protocol.js";

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

function renderStaticPrefixVariant(
  contextKind: "meta" | "alter_ego",
  compact: boolean,
  options: RenderStaticPrefixBundleOptions,
): string {
  const base =
    contextKind === "meta"
      ? assembleExecutionContextDeveloperInstructions({
          agentName: "Warmup Agent",
          agentActorId: "actor:warmup-agent",
          agentType: "anotherme",
          representedHuman: STATIC_WARMUP_SPONSOR,
          sponsor: STATIC_WARMUP_SPONSOR,
          connectedApps: options.connectedApps,
          connectedAppKeys: [],
          connectableAppKeys: [],
          compactInstructions: compact,
          contextKind: "meta",
          roomId: "room-warmup",
          roomKind: "direct",
        })
      : assembleExecutionContextDeveloperInstructions({
          agentName: "Warmup Agent",
          agentActorId: "actor:warmup-agent",
          agentType: "anotherme",
          representedHuman: STATIC_WARMUP_SPONSOR,
          sponsor: STATIC_WARMUP_SPONSOR,
          connectedApps: options.connectedApps,
          connectedAppKeys: [],
          connectableAppKeys: [],
          compactInstructions: compact,
          contextKind: "alter_ego",
          taskId: "task-warmup",
        });

  const parts: string[] = [];
  if (base.static && base.static.length > 0) {
    parts.push(base.static);
  }
  if (options.permissionReview) {
    parts.push(
      compact ? TOOL_APPROVAL_PROTOCOL_COMPACT : TOOL_APPROVAL_PROTOCOL,
    );
  }
  parts.push(
    compact ? EMOJI_REACTION_INSTRUCTIONS_COMPACT : EMOJI_REACTION_INSTRUCTIONS,
  );
  return parts.join("\n\n");
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
