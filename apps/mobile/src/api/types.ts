// Names for the TeamHub public contract types the app uses. Type-only: the
// generated module never enters the bundle.
import type { components } from "@linger/wire-contracts/teamhub-public/types";

type Schemas = components["schemas"];

export type CurrentIdentity = Schemas["CurrentIdentity"];
export type ActorRef = Schemas["ActorRef"];
export type AnotherMe = Schemas["AnotherMe"];
export type TenantAgentAvailabilityPage =
  Schemas["TenantAgentAvailabilityPage"];
export type TenantAgentAvailabilitySnapshot =
  Schemas["TenantAgentAvailabilitySnapshot"];
export type Room = Schemas["Room"];
export type RoomMember = Schemas["RoomMember"];
export type RoomMemberPage = Schemas["RoomMemberPage"];
export type TenantAgent = Schemas["TenantAgent"];
export type TenantAgentPage = Schemas["TenantAgentPage"];
export type RoomListItem = Schemas["RoomListItem"];
export type RoomPage = Schemas["RoomPage"];
export type Message = Schemas["Message"];
export type MessagePage = Schemas["MessagePage"];
export type MessageAttachment = Schemas["MessageAttachment"];
export type MessageCreateRequest = Schemas["MessageCreateRequest"];
export type MessageAttachmentUpload = Schemas["MessageAttachmentUpload"];
export type RoomReadState = Schemas["RoomReadState"];
export type RoomEventEnvelope = Schemas["RoomEventEnvelope"];
export type RoomEventPage = Schemas["RoomEventPage"];
export type RoomRunStatus = Schemas["RoomRunStatus"];
export type RoomRunStatusList = Schemas["RoomRunStatusList"];
export type RoomRunCancelResult = Schemas["RoomRunCancelResult"];
export type RuntimePresentationEventPage =
  Schemas["RuntimePresentationEventPage"];
export type RuntimePresentationEventRecord =
  Schemas["RuntimePresentationEventRecord"];
export type DecisionCard = Schemas["DecisionRequestedMessageCard"];
export type DecisionRequest = Schemas["DecisionRequest"];
export type DecisionKind = Schemas["DecisionKind"];
export type MemoryEntry = Schemas["MemoryEntry"];
export type MemoryEntryPage = Schemas["MemoryEntryPage"];
export type TeamHubDocument = Schemas["Document"];
export type DocumentPage = Schemas["DocumentPage"];
export type DocumentVersion = Schemas["DocumentVersion"];
export type PhonePushGrantRequest = Schemas["PhonePushGrantRequest"];
export type PhonePushPreferences = Schemas["PhonePushPreferences"];
export type VoiceSession = Schemas["VoiceSession"];
export type VoiceSessionPurpose = Schemas["VoiceSessionPurpose"];
export type VoiceConnectionCredential = Schemas["VoiceConnectionCredential"];
export type VoiceCapture = Schemas["VoiceCapture"];
export type VoiceTranscriptEvent = Schemas["VoiceTranscriptEvent"];
export type VoiceTranscriptEventPage = Schemas["VoiceTranscriptEventPage"];
export type VoiceEventPage = Schemas["VoiceEventPage"];
export type VoiceLiveTurnMarker = Schemas["VoiceLiveTurnMarker"];
export type VoiceLiveRuntimeEvent = Schemas["VoiceLiveRuntimeEvent"];
export type VoiceLiveClientEvent = Schemas["VoiceLiveClientEvent"];

/**
 * `resource.invalidated` data. The SSE payload schemas are not emitted into
 * the generated types, so this mirrors contracts/openapi/components/human-events.yaml.
 */
export interface ResourceInvalidated {
  readonly tenant_id: string;
  readonly resource: string;
  readonly id: string;
  readonly room_seq?: number;
}

/** `stream.resync` data, from the same source. */
export interface StreamResync {
  readonly reason: "connected" | "hints_lost";
}
export type MobileRelayNode = Schemas["MobileRelayNode"];
export type MobileRelayNodeList = Schemas["MobileRelayNodeList"];
export type RoutinePage = Schemas["RoutinePage"];
export type Routine = Schemas["Routine"];
export type ExternalAppList = Schemas["ExternalAppList"];
export type ExternalConnectionList = Schemas["ExternalConnectionList"];
export type ExternalConnectionAgentAccessList =
  Schemas["ExternalConnectionAgentAccessList"];
