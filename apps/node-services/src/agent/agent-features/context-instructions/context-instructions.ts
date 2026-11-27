import type {
  AgentRepresentedHuman,
  AgentSponsorIdentity,
  AgentType,
} from "../../executor/types.js";
import type { MetaRoomKind } from "../../executor/context-ref.js";
import { renderAgentInstructions } from "../../prompt/agent-instructions.js";
import { renderBehaviorPattern } from "../../prompt/behavior-pattern.js";
import { renderCompactMetaInstructions } from "../../prompt/compact-meta-instructions.js";
import {
  renderAlterEgoTaskContext,
  renderEnvironmentKnowledgeStatic,
} from "../../prompt/environment-knowledge.js";
import { renderMetaInstructions } from "../../prompt/meta-instructions.js";
import {
  PERSONALITY_SPEC,
  PERSONALITY_SPEC_COMPACT,
} from "../../prompt/personality-spec.js";
import {
  PERSONAL_CONTEXT_METHOD_STATIC,
  renderConnectedAppContextSources,
} from "../../prompt/personal-context-method.js";
import {
  PERSONAL_KNOWLEDGE_POLICY,
  PERSONAL_KNOWLEDGE_POLICY_COMPACT,
} from "../../prompt/personal-knowledge-policy.js";
import type { SplitInstructions } from "../../prompt/prefix-boundary.js";

interface ExecutionContextDeveloperInstructionsCommonInput {
  readonly agentName: string;
  readonly agentActorId: string;
  readonly agentType: AgentType;
  readonly representedHuman?: AgentRepresentedHuman;
  readonly sponsor: AgentSponsorIdentity;
  /** TeamHub has a Composio API key, so the connected app commands work. */
  readonly connectedApps: boolean;
  /** Keys of the apps with an account granted to this Agent. */
  readonly connectedAppKeys: readonly string[];
  /** Keys of every catalog app the Human can connect. */
  readonly connectableAppKeys: readonly string[];
  /** The Runtime model's context window is small: use the compact recipe. */
  readonly compactInstructions: boolean;
}

export type ExecutionContextDeveloperInstructionsInput =
  ExecutionContextDeveloperInstructionsCommonInput &
    (
      | {
          readonly contextKind: "meta";
          readonly roomId: string;
          readonly roomKind: MetaRoomKind;
          readonly taskId?: never;
        }
      | {
          readonly contextKind: "alter_ego";
          readonly roomId?: never;
          readonly roomKind?: never;
          readonly taskId: string;
        }
      | {
          readonly contextKind: "document";
          readonly roomId?: never;
          readonly roomKind?: never;
          readonly taskId?: never;
        }
    );

/**
 * Renders developer instructions split into a cacheable static prefix and a
 * per-Agent / per-Context dynamic tail.
 */
export function assembleExecutionContextDeveloperInstructions(
  input: ExecutionContextDeveloperInstructionsInput,
): SplitInstructions {
  const representedHuman = input.representedHuman ?? input.sponsor;
  const compact = input.compactInstructions;
  if (input.contextKind === "meta")
    return (compact ? renderCompactMetaInstructions : renderMetaInstructions)({
      agentName: input.agentName,
      agentActorId: input.agentActorId,
      agentType: input.agentType,
      representedHuman,
      roomId: input.roomId,
      roomKind: input.roomKind,
      connectedApps: input.connectedApps,
      connectedAppKeys: input.connectedAppKeys,
      connectableAppKeys: input.connectableAppKeys,
    });
  const staticParts: string[] = [
    compact ? PERSONALITY_SPEC_COMPACT : PERSONALITY_SPEC,
    renderTeamHubCommands(input),
  ];
  if (input.contextKind !== "document") {
    staticParts.push(
      PERSONAL_CONTEXT_METHOD_STATIC,
      compact ? PERSONAL_KNOWLEDGE_POLICY_COMPACT : PERSONAL_KNOWLEDGE_POLICY,
    );
  }
  staticParts.push(
    renderEnvironmentKnowledgeStatic(input.contextKind, compact),
    renderBehaviorPattern({ contextKind: input.contextKind, compact }),
  );
  const dynamicParts: string[] = [
    renderAgentInstructions({
      agentName: input.agentName,
      agentActorId: input.agentActorId,
      agentType: input.agentType,
      representedHuman,
    }),
  ];
  if (input.contextKind === "alter_ego") {
    dynamicParts.push(renderAlterEgoTaskContext(input.taskId, compact));
    const appSources = renderConnectedAppContextSources(
      input.connectedApps,
      input.connectedAppKeys,
    );
    if (appSources) dynamicParts.push(appSources);
  }
  return {
    static: staticParts.join("\n\n"),
    dynamic: dynamicParts.join("\n\n"),
  };
}

const CONNECTED_APP_WRITES = ` Connected app writes are an exception: when an external write's outcome is unknown, do not rerun it blindly. Rerunning submits the write again whatever its operation ID; only a confirmation-card command with the same operation ID returns the same card. Check the result in the external application first, and submit again only after confirming the write did not take effect.`;

const COMPACT_CONNECTED_APP_WRITES = ` Never rerun a connected app write whose outcome is unknown; check the app first.`;

function renderCompactTeamHubCommands(
  input: Exclude<
    ExecutionContextDeveloperInstructionsInput,
    { readonly contextKind: "meta" }
  >,
): string {
  const common = `teamhub is a command-line program, not a tool: run it with your shell tool (exec_command, Bash, bash, or powershell), passing the whole command line as its cmd or command argument, and never call a tool named teamhub. teamhub <domain> <action> --help explains each command, and TeamHub checks your authority on every call. Use --file - for a body from stdin and --json for structured results. Credentials are installed; never read or print them. With --operation-id, use a unique id per write; after an unknown outcome, rerun the same command with the id the error printed.${input.connectedApps ? COMPACT_CONNECTED_APP_WRITES : ""}`;
  if (input.contextKind === "document")
    return `<teamhub-commands>\n${common}
Use the thread ID from this input: teamhub docs comment get <thread-id> reads it, teamhub docs comment reply <thread-id> --content "..." replies, and teamhub docs comment replace <thread-id> --content "..." applies an explicitly requested text change. Don't send Room messages.
</teamhub-commands>`;
  return `<teamhub-commands>\n${common}
In a Task you can't send messages or create Documents, Rooms, or Tasks, though authorization and connection cards are allowed. Read with teamhub message read, teamhub docs get, and teamhub docs list; edit an existing Document only when the Task asks. Write outputs under ./playground/<current-task-id>/ and describe them in your final reply.
</teamhub-commands>`;
}

function renderTeamHubCommands(
  input: Exclude<
    ExecutionContextDeveloperInstructionsInput,
    { readonly contextKind: "meta" }
  >,
): string {
  if (input.compactInstructions) return renderCompactTeamHubCommands(input);
  const common = `Use teamhub through your shell for internal business operations. teamhub --help and teamhub <domain> <action> --help describe the static command catalog, not current permissions; TeamHub checks current authority on every request. Use ordinary flags for text and business identifiers, --file - for a body from stdin, and --json for structured results. Credentials are installed by the Runtime; never read, log, copy or override them. Internal commands do not need MCP discovery; external MCP tools remain separate.
For commands that expose --operation-id, use a unique ID for each logical write. After an unknown TeamHub HTTP outcome, rerun the exact command with the same input and the operation ID the error printed: TeamHub returns the original result instead of writing twice. Without --operation-id every run is a new write.${input.connectedApps ? CONNECTED_APP_WRITES : ""} An operation ID does not replace CAS.`;
  if (input.contextKind === "document")
    return `<teamhub-commands>\n${common}
Use the exact thread ID supplied in this input. Read with teamhub docs comment get <thread-id>, reply with teamhub docs comment reply <thread-id> --content "Your reply", and apply an explicitly requested text change with teamhub docs comment replace <thread-id> --content "Replacement text". Do not send Room messages from this Context.
teamhub docs comment reply <current-thread-id> --operation-id <unique-reply-id> --content "Your reply" --json
</teamhub-commands>`;
  return `<teamhub-commands>\n${common}
In a Task you don't send messages or create Documents, Rooms, or Tasks; TeamHub refuses them. Posting authorization or connection cards (such as teamhub browser connect or teamhub computer permissions request) is allowed and is separate from sending chat messages. Read with teamhub message read, teamhub docs get, and teamhub docs list; edit an existing Document only when the Task asks for it. Write outputs under ./playground/<current-task-id>/ and describe them in your final reply.
</teamhub-commands>`;
}
