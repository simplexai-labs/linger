// Thin typed calls to TeamHub through the phone's session. Every route here
// must be on the Mobile API allowlist (apps/teamhub/internal/mobilegateway).
import { randomId } from "../lib/bytes";
import {
  HttpError,
  requestJson,
  sendRequest,
  type SessionResponse,
} from "../session/http";
import { utf8 } from "../session/frames";
import type { PhoneSession } from "../session/session";
import { buildMultipart } from "./multipart";
import type {
  AnotherMe,
  ExternalAppList,
  ExternalConnectionAgentAccessList,
  ExternalConnectionList,
  MobileRelayNode,
  RoutinePage,
  MobileRelayNodeList,
  CurrentIdentity,
  DecisionRequest,
  DocumentPage,
  DocumentVersion,
  MemoryEntry,
  MemoryEntryPage,
  Message,
  MessageAttachmentUpload,
  MessageCreateRequest,
  MessagePage,
  PhonePushGrantRequest,
  PhonePushPreferences,
  Room,
  RoomEventPage,
  RoomPage,
  RoomMemberPage,
  RoomReadState,
  RoomRunCancelResult,
  RoomRunStatusList,
  RuntimePresentationEventPage,
  TeamHubDocument,
  TenantAgentAvailabilityPage,
  TenantAgentPage,
  VoiceCapture,
  VoiceConnectionCredential,
  VoiceSession,
  VoiceSessionPurpose,
} from "./types";

/** Idempotency keys mark every write so a resend never applies twice. */
export function newIdempotencyKey(): string {
  return `mobile:${randomId()}`;
}

function segment(id: string): string {
  return encodeURIComponent(id);
}

function query(params: Record<string, string | number | undefined>): string {
  const parts = Object.entries(params)
    .filter(
      (entry): entry is [string, string | number] => entry[1] !== undefined,
    )
    .map(([name, value]) => `${name}=${encodeURIComponent(String(value))}`);
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

/** Reads one response header regardless of how the server cased it. */
export function headerValue(
  response: SessionResponse,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, values] of Object.entries(response.headers)) {
    if (key.toLowerCase() === wanted) return values[0];
  }
  return undefined;
}

function errorFrom(response: SessionResponse): HttpError {
  let code = `HTTP_${response.status}`;
  let message = `Request failed with status ${response.status}`;
  try {
    const envelope = JSON.parse(utf8(response.body)) as {
      error?: { code?: string; message?: string };
    };
    code = envelope.error?.code ?? code;
    message = envelope.error?.message ?? message;
  } catch {
    // Not the error envelope; keep the status code.
  }
  return new HttpError(response.status, code, message);
}

export function getMe(session: PhoneSession): Promise<CurrentIdentity> {
  return requestJson(session, "GET", "/v0/me");
}

export function getAnotherMe(
  session: PhoneSession,
  tenantId: string,
): Promise<AnotherMe> {
  return requestJson(
    session,
    "GET",
    `/v0/tenants/${segment(tenantId)}/another-me`,
  );
}

export function listAgentAvailability(
  session: PhoneSession,
  tenantId: string,
): Promise<TenantAgentAvailabilityPage> {
  return requestJson(
    session,
    "GET",
    `/v0/tenants/${segment(tenantId)}/agent-availability${query({ limit: 200 })}`,
  );
}

export function listRooms(
  session: PhoneSession,
  tenantId: string,
  cursor?: string,
): Promise<RoomPage> {
  return requestJson(
    session,
    "GET",
    `/v0/tenants/${segment(tenantId)}/rooms${query({ cursor, limit: 100 })}`,
  );
}

export function getRoom(session: PhoneSession, roomId: string): Promise<Room> {
  return requestJson(session, "GET", `/v0/rooms/${segment(roomId)}`);
}

export function listRoomMembers(
  session: PhoneSession,
  roomId: string,
): Promise<RoomMemberPage> {
  return requestJson(
    session,
    "GET",
    `/v0/rooms/${segment(roomId)}/members${query({ limit: 200 })}`,
  );
}

export function listTenantAgents(
  session: PhoneSession,
  tenantId: string,
  cursor?: string,
): Promise<TenantAgentPage> {
  return requestJson(
    session,
    "GET",
    `/v0/tenants/${segment(tenantId)}/agents${query({ cursor, limit: 100 })}`,
  );
}

export function listMessages(
  session: PhoneSession,
  roomId: string,
  cursor?: string,
): Promise<MessagePage> {
  return requestJson(
    session,
    "GET",
    `/v0/rooms/${segment(roomId)}/messages${query({ cursor, limit: 50 })}`,
  );
}

export function getMessage(
  session: PhoneSession,
  roomId: string,
  messageId: string,
): Promise<Message> {
  return requestJson(
    session,
    "GET",
    `/v0/rooms/${segment(roomId)}/messages/${segment(messageId)}`,
  );
}

export function createMessage(
  session: PhoneSession,
  roomId: string,
  body: MessageCreateRequest,
  idempotencyKey: string,
): Promise<Message> {
  return requestJson(session, "POST", `/v0/rooms/${segment(roomId)}/messages`, {
    body,
    headers: { "Idempotency-Key": idempotencyKey },
  });
}

export async function uploadAttachment(
  session: PhoneSession,
  roomId: string,
  file: { name: string; mediaType?: string; bytes: Uint8Array },
  idempotencyKey: string,
): Promise<MessageAttachmentUpload> {
  const fields = [{ name: "filename", value: file.name }];
  if (file.mediaType)
    fields.push({ name: "media_type", value: file.mediaType });
  const multipart = buildMultipart([
    ...fields,
    {
      name: "content",
      value: file.bytes,
      filename: file.name,
      contentType: file.mediaType || "application/octet-stream",
    },
  ]);
  const response = await sendRequest(
    session,
    "POST",
    `/v0/rooms/${segment(roomId)}/message-attachment-uploads`,
    {
      body: multipart.body,
      headers: {
        Accept: "application/json",
        "Content-Type": multipart.contentType,
        "Idempotency-Key": idempotencyKey,
      },
    },
  );
  if (response.status >= 400) throw errorFrom(response);
  return JSON.parse(utf8(response.body)) as MessageAttachmentUpload;
}

export async function deleteAttachmentUpload(
  session: PhoneSession,
  roomId: string,
  uploadId: string,
): Promise<void> {
  await requestJson(
    session,
    "DELETE",
    `/v0/rooms/${segment(roomId)}/message-attachment-uploads/${segment(uploadId)}`,
  );
}

export function updateReadState(
  session: PhoneSession,
  roomId: string,
  throughRoomSeq: number,
): Promise<RoomReadState> {
  return requestJson(
    session,
    "PUT",
    `/v0/rooms/${segment(roomId)}/read-state`,
    {
      body: { through_room_seq: throughRoomSeq },
    },
  );
}

export function listRoomEvents(
  session: PhoneSession,
  roomId: string,
  after: number,
): Promise<RoomEventPage> {
  return requestJson(
    session,
    "GET",
    `/v0/rooms/${segment(roomId)}/events${query({ after, limit: 200 })}`,
  );
}

export function listRunStatuses(
  session: PhoneSession,
  roomId: string,
): Promise<RoomRunStatusList> {
  return requestJson(
    session,
    "GET",
    `/v0/rooms/${segment(roomId)}/run-statuses`,
  );
}

export function listPresentationEvents(
  session: PhoneSession,
  roomId: string,
  runId: string,
  after: string | undefined,
): Promise<RuntimePresentationEventPage> {
  return requestJson(
    session,
    "GET",
    `/v0/rooms/${segment(roomId)}/runs/${segment(runId)}/runtime-presentation-events${query({ after, limit: 200 })}`,
  );
}

export function cancelRun(
  session: PhoneSession,
  roomId: string,
  runId: string,
): Promise<RoomRunCancelResult> {
  return requestJson(
    session,
    "POST",
    `/v0/rooms/${segment(roomId)}/runs/${segment(runId)}/cancel`,
    { body: { request_id: newIdempotencyKey() } },
  );
}

export function decide(
  session: PhoneSession,
  decisionId: string,
  request: DecisionRequest,
): Promise<Message> {
  return requestJson(session, "POST", `/v0/decisions/${segment(decisionId)}`, {
    body: request,
  });
}

export interface Download {
  readonly contentType: string;
  readonly bytes: Uint8Array;
  /** The content passed MAX_DOWNLOAD_BYTES and was not kept. */
  readonly tooLarge?: boolean;
}

/** The most the phone reads of one file: the largest it can preview. */
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

async function download(
  session: PhoneSession,
  path: string,
): Promise<Download> {
  const response = await sendRequest(session, "GET", path, {
    maxBytes: MAX_DOWNLOAD_BYTES,
  });
  if (response.status >= 400) throw errorFrom(response);
  return {
    contentType:
      headerValue(response, "Content-Type") ?? "application/octet-stream",
    bytes: response.body,
    tooLarge: response.tooLarge,
  };
}

/** An Agent's uploaded avatar, by the versioned path TenantAgent names. */
export function agentAvatarImage(
  session: PhoneSession,
  avatarImageUrl: string,
): Promise<Download> {
  // The URL is same-origin; only its path and query reach the Gateway.
  return download(session, avatarImageUrl.replace(/^[a-z]+:\/\/[^/]+/i, ""));
}

export function decisionScreenshot(
  session: PhoneSession,
  decisionId: string,
): Promise<Download> {
  return download(session, `/v0/decisions/${segment(decisionId)}/screenshot`);
}

export function listMeetings(
  session: PhoneSession,
  tenantId: string,
  cursor?: string,
): Promise<MemoryEntryPage> {
  return requestJson(
    session,
    "GET",
    `/v0/tenants/${segment(tenantId)}/memory${query({ kind: "meeting", cursor, limit: 100 })}`,
  );
}

export function getMemoryEntry(
  session: PhoneSession,
  tenantId: string,
  entryId: string,
): Promise<MemoryEntry> {
  return requestJson(
    session,
    "GET",
    `/v0/tenants/${segment(tenantId)}/memory/${segment(entryId)}`,
  );
}

export function getDocument(
  session: PhoneSession,
  documentId: string,
): Promise<TeamHubDocument> {
  return requestJson(session, "GET", `/v0/documents/${segment(documentId)}`);
}

export function getDocumentVersion(
  session: PhoneSession,
  versionId: string,
): Promise<DocumentVersion> {
  return requestJson(
    session,
    "GET",
    `/v0/document-versions/${segment(versionId)}`,
  );
}

export function documentVersionContentPath(versionId: string): string {
  return `/v0/document-versions/${segment(versionId)}/content`;
}

export function downloadDocumentVersion(
  session: PhoneSession,
  versionId: string,
): Promise<Download> {
  return download(session, documentVersionContentPath(versionId));
}

const MAX_DOWNLOAD_ATTEMPTS = 10;

/**
 * Downloads a Document's latest content. TeamHub answers 202 with
 * Retry-After while a native Document is still rendering.
 */
export async function downloadLatestDocument(
  session: PhoneSession,
  documentId: string,
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<Download> {
  for (let attempt = 0; attempt < MAX_DOWNLOAD_ATTEMPTS; attempt += 1) {
    const response = await sendRequest(
      session,
      "GET",
      `/v0/documents/${segment(documentId)}/downloads`,
      { maxBytes: MAX_DOWNLOAD_BYTES },
    );
    if (response.status === 202) {
      const seconds = Number(headerValue(response, "Retry-After") ?? "1");
      await wait(
        Math.min(10, Number.isFinite(seconds) && seconds > 0 ? seconds : 1) *
          1000,
      );
      continue;
    }
    if (response.status >= 400) throw errorFrom(response);
    return {
      contentType:
        headerValue(response, "Content-Type") ?? "application/octet-stream",
      bytes: response.body,
      tooLarge: response.tooLarge,
    };
  }
  throw new HttpError(
    503,
    "DOCUMENT_NOT_READY",
    "The document is still being prepared",
  );
}

export function listLibraryDocuments(
  session: PhoneSession,
  cursor?: string,
): Promise<DocumentPage> {
  return requestJson(
    session,
    "GET",
    `/v0/library/documents${query({ view: "recent", cursor, limit: 50 })}`,
  );
}

export function listWikiDocuments(
  session: PhoneSession,
  tenantId: string,
  cursor?: string,
): Promise<DocumentPage> {
  return requestJson(
    session,
    "GET",
    `/v0/tenants/${segment(tenantId)}/personal-wiki/documents${query({ cursor, limit: 50 })}`,
  );
}

export async function putPushGrant(
  session: PhoneSession,
  request: PhonePushGrantRequest,
): Promise<void> {
  await requestJson(session, "PUT", "/v0/me/phone/push-grant", {
    body: request,
  });
}

export async function putPushPreferences(
  session: PhoneSession,
  request: PhonePushPreferences,
): Promise<void> {
  await requestJson(session, "PUT", "/v0/me/phone/push-preferences", {
    body: request,
  });
}

/** Tells the computer the Human is looking at this Room now. */
export async function notifyRoomPresence(
  session: PhoneSession,
  roomId: string,
): Promise<void> {
  await requestJson(session, "POST", `/v0/rooms/${segment(roomId)}/presence`);
}

export async function deletePushGrant(session: PhoneSession): Promise<void> {
  await requestJson(session, "DELETE", "/v0/me/phone/push-grant");
}

export function listRelayNodes(
  session: PhoneSession,
): Promise<MobileRelayNodeList> {
  return requestJson(session, "GET", "/v0/mobile/relays");
}

/** Adds a Relay node to the computer's list; the computer links to it. */
export function addRelayNode(
  session: PhoneSession,
  url: string,
  label?: string,
): Promise<MobileRelayNode> {
  return requestJson(session, "POST", "/v0/mobile/relays", {
    body: label ? { url, label } : { url },
  });
}

export function createVoiceSession(
  session: PhoneSession,
  roomId: string,
  purpose: VoiceSessionPurpose,
): Promise<VoiceSession> {
  return requestJson(
    session,
    "POST",
    `/v0/rooms/${segment(roomId)}/voice-sessions`,
    { body: { purpose, client: "mobile" } },
  );
}

export function getVoiceSession(
  session: PhoneSession,
  voiceSessionId: string,
  signal?: AbortSignal,
): Promise<VoiceSession> {
  return requestJson(
    session,
    "GET",
    `/v0/voice-sessions/${segment(voiceSessionId)}`,
    { signal },
  );
}

export async function closeVoiceSession(
  session: PhoneSession,
  voiceSessionId: string,
): Promise<void> {
  await requestJson(
    session,
    "DELETE",
    `/v0/voice-sessions/${segment(voiceSessionId)}`,
  );
}

/** Each call advances the publisher generation, as for a browser. */
export function createVoiceCredential(
  session: PhoneSession,
  voiceSessionId: string,
): Promise<VoiceConnectionCredential> {
  return requestJson(
    session,
    "POST",
    `/v0/voice-sessions/${segment(voiceSessionId)}/connection-credentials`,
  );
}

/** Finalizes the current dictation turn; a retry reuses the request ID. */
export async function commitDictation(
  session: PhoneSession,
  voiceSessionId: string,
  requestId: string,
): Promise<void> {
  await requestJson(
    session,
    "POST",
    `/v0/voice-sessions/${segment(voiceSessionId)}/dictation-commit`,
    { body: { request_id: requestId } },
  );
}

export function startVoiceCapture(
  session: PhoneSession,
  voiceSessionId: string,
  roomId: string,
  startOffsetMs: number,
): Promise<VoiceCapture> {
  return requestJson(
    session,
    "POST",
    `/v0/voice-sessions/${segment(voiceSessionId)}/captures`,
    { body: { room_id: roomId, start_offset_ms: startOffsetMs } },
  );
}

export function stopVoiceCapture(
  session: PhoneSession,
  captureId: string,
): Promise<VoiceCapture> {
  return requestJson(
    session,
    "POST",
    `/v0/voice-captures/${segment(captureId)}/stop`,
  );
}

export function getVoiceCapture(
  session: PhoneSession,
  captureId: string,
): Promise<VoiceCapture> {
  return requestJson(
    session,
    "GET",
    `/v0/voice-captures/${segment(captureId)}`,
  );
}

export function voiceEventsStreamPath(
  voiceSessionId: string,
  after: string | undefined,
): string {
  return `/v0/voice-sessions/${segment(voiceSessionId)}/events/stream${query({ after })}`;
}

export function listRoomRoutines(
  session: PhoneSession,
  roomId: string,
): Promise<RoutinePage> {
  return requestJson(
    session,
    "GET",
    `/v0/rooms/${segment(roomId)}/routines${query({ limit: 100 })}`,
  );
}

export function listExternalApps(
  session: PhoneSession,
): Promise<ExternalAppList> {
  return requestJson(session, "GET", "/v0/external-apps");
}

export function listExternalConnections(
  session: PhoneSession,
): Promise<ExternalConnectionList> {
  return requestJson(session, "GET", "/v0/external-connections");
}

export function listConnectionAgentAccess(
  session: PhoneSession,
  connectionId: string,
): Promise<ExternalConnectionAgentAccessList> {
  return requestJson(
    session,
    "GET",
    `/v0/external-connections/${segment(connectionId)}/agent-grants`,
  );
}
