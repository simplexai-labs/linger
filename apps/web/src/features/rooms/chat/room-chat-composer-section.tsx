import { Message01Icon } from "@hugeicons/core-free-icons";
import { lazy, Suspense, type ComponentProps } from "react";

import { Icon } from "@/components/ui/icon";
import { isRunWorking } from "@/features/teamhub/run-status";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { commonMessages } from "@/i18n/common.messages";
import { translate } from "@/i18n/language";
import { useT } from "@/i18n/use-translation";

import { RoomRejoinBanner } from "../room-participation";
import { readRoomComposerDraft, writeRoomComposerDraft } from "../room-drafts";
import { roomDocumentsQueryKey } from "../room-queries";
import { MessageComposer } from "./message-composer";
import type { MessageDocumentOption } from "./message-composer-references";
import { RoomChatComposerNotices } from "./room-chat-composer-notices";
import { BackgroundTasksIndicator } from "./background-tasks-indicator";
import { AgentStreamingStatusDock } from "./message-timeline";
import { roomOffersVoiceMaterials } from "./voice-mode/voice-materials-context";
import { RoomComposerDock } from "./room-composer-dock";
import { composerMessages } from "./composer.messages";
import type { RoomChatData } from "./use-room-chat-data";
import type { RoomChatConversationState } from "./use-room-chat-conversation-state";
import type { RoomChatTimelineActions } from "./use-room-chat-timeline-actions";

const DirectAgentModelSwitch = lazy(async () => ({
  default: (await import("./direct-agent-model-switch")).DirectAgentModelSwitch,
}));

const EMPTY_DOCUMENT_OPTIONS: MessageDocumentOption[] = [];

interface RoomChatComposerSectionProps {
  actions: RoomChatTimelineActions;
  data: RoomChatData;
  state: RoomChatConversationState;
}

/** The Room's main composer, or the rejoin banner once the user has left. */
export function RoomChatComposerSection({
  actions,
  data,
  state,
}: RoomChatComposerSectionProps) {
  const t = useT();
  const {
    client,
    documentsPending,
    navigation,
    onDocumentQueryChange,
    room,
    roomDocuments,
    roomId,
    shareableDocuments,
    tenantId,
  } = data;
  const {
    agentAvailability,
    agentDirectory,
    agentStreaming,
    currentActorId,
    delivery,
    dock,
    documentOptions,
    draftScope,
    initialDraft,
    interactions,
    mentionOptions,
    skillOptions,
    updateVoiceLiveDraft,
  } = state;
  const {
    actorDisplayNames,
    directAgentRegistration,
    directPeerState,
    focusComposerOnEntry,
    openActorProfile,
    sendMessage,
  } = actions;
  if (room.participation === "left") {
    return <RoomRejoinBanner room={room} />;
  }
  if (room.channel) {
    return (
      <div className="shrink-0">
        <BackgroundTasksIndicator
          client={client}
          roomId={roomId}
          tenantId={tenantId}
        />
        <AgentStreamingStatusDock {...dock} />
        <ChannelViewOnlyBanner channel={room.channel} roomName={room.name} />
      </div>
    );
  }
  return (
    <RoomComposerDock
      onRetry={() => void agentDirectory.refetch()}
      outboxError={delivery.outboxError}
      state={directPeerState}
    >
      {shareableDocuments.isError ? (
        <p role="alert" className="px-4 py-2 text-sm text-app-danger">
          {t(composerMessages.documentsOutsideRoomFailed)}{" "}
          <button
            type="button"
            onClick={() => void shareableDocuments.refetch()}
          >
            {t(commonMessages.retry)}
          </button>
        </p>
      ) : null}
      <BackgroundTasksIndicator
        client={client}
        roomId={roomId}
        tenantId={tenantId}
      />
      <AgentStreamingStatusDock {...dock} />
      <RoomMessageComposer
        agentPeek={{
          busyAgentIds: agentStreaming.runStatuses.flatMap((runStatus) =>
            isRunWorking(runStatus) ? [runStatus.agent.id] : [],
          ),
          directAgent:
            room.kind === "direct" && room.direct_peer?.kind === "agent"
              ? room.direct_peer
              : undefined,
        }}
        agentOptionsReady={agentDirectory.isSuccess}
        agentDirectoryError={agentDirectory.isError}
        attachmentDraftKey={`${draftScope.accountId}:${tenantId}:${roomId}`}
        attachmentEnabled
        // eslint-disable-next-line jsx-a11y/no-autofocus -- the field is focused on purpose because the user just opened this dialog or inline editor
        autoFocus={focusComposerOnEntry}
        documentOptions={documentOptions.map((option) => ({
          ...option,
          requiresRoomBinding: !roomDocuments.data?.items.some(
            (document) => document.id === option.documentId,
          ),
        }))}
        documentOptionsReady={roomDocuments.isSuccess && !documentsPending}
        historyScope={draftScope}
        initialDocumentContexts={initialDraft.documentContexts}
        initialDocumentReferences={initialDraft.documentReferences}
        initialMentions={initialDraft.mentions}
        initialSkillReferences={initialDraft.skillReferences}
        initialValue={initialDraft.body}
        mentionOptions={mentionOptions}
        onDocumentQueryChange={onDocumentQueryChange}
        onDraftStateChange={(draft) =>
          writeRoomComposerDraft(draftScope, {
            ...draft,
            // Material selection owns this field. A late ASR drain must
            // not restore excerpts removed/replaced while it was pending.
            voiceMaterials: readRoomComposerDraft(draftScope).voiceMaterials,
          })
        }
        onVoiceModePresentation={updateVoiceLiveDraft}
        onCancelAttachment={delivery.cancelAttachment}
        onOpenDocumentContext={navigation.openDocumentContext}
        onOpenDocument={navigation.openDocument}
        onOpenProfile={openActorProfile}
        onRetryAgents={() =>
          void Promise.all([
            agentDirectory.refetch(),
            agentAvailability.refetch(),
          ])
        }
        onRemoveContextMessage={interactions.removeContext}
        modelSwitch={
          directAgentRegistration ? (
            <Suspense fallback={null}>
              <DirectAgentModelSwitch
                client={client}
                currentActorId={currentActorId}
                registration={directAgentRegistration}
                busy={
                  (agentAvailability.data?.items.find(
                    (item) =>
                      item.actor_id === directAgentRegistration.actor.id,
                  )?.availability.active_task_count ?? 0) > 0
                }
                tenantId={tenantId}
              />
            </Suspense>
          ) : undefined
        }
        onSend={sendMessage}
        isVoiceDraftCurrent={(expected) =>
          readRoomComposerDraft(draftScope).body === expected
        }
        // Every Room's main composer offers Voice Mode and sends turns as
        // ordinary Messages; only an Agent direct Room has a recipient.
        voiceModeTarget={
          roomOffersVoiceMaterials(room)
            ? {
                accountId: draftScope.accountId,
                roomId,
                roomName:
                  room.kind === "direct"
                    ? (room.direct_peer?.display_name ?? room.name)
                    : room.name,
                tenantId,
                ...(room.kind === "direct" && room.direct_peer?.kind === "agent"
                  ? { recipient: room.direct_peer }
                  : {}),
              }
            : undefined
        }
        onStageAttachment={delivery.stageAttachment}
        placeholder={
          room.kind === "direct" && room.direct_peer
            ? t(composerMessages.messagePeer, {
                name:
                  actorDisplayNames[room.direct_peer?.id ?? ""] ??
                  room.direct_peer?.display_name,
              })
            : t(composerMessages.messageThisRoom)
        }
        ref={interactions.composerRef}
        resolveDocumentLink={(link) => resolveRoomDocumentLink(data, link)}
        selectedContextMessages={interactions.selectedContextMessages}
        skillOptions={skillOptions}
      />
    </RoomComposerDock>
  );
}

type RoomDocumentLink = Parameters<
  NonNullable<ComponentProps<typeof MessageComposer>["resolveDocumentLink"]>
>[0];

// A pasted Document link becomes a reference only when it is an active,
// context-usable Document of this Tenant, bound to this Room when requested.
async function resolveRoomDocumentLink(
  { client, queryClient, roomId, tenantId }: RoomChatData,
  link: RoomDocumentLink,
) {
  if (link.tenantId !== tenantId) {
    throw new Error(translate(composerMessages.documentCannotBeShared));
  }
  try {
    const document = await teamHubData(
      client.api.GET("/v0/documents/{documentId}", {
        params: { path: { documentId: link.documentId } },
      }),
    );
    if (
      document.id !== link.documentId ||
      document.tenant_id !== tenantId ||
      document.status !== "active" ||
      !document.capabilities.use_as_context
    ) {
      throw new Error("Document is not eligible for this Room.");
    }
    if (link.bindToRoom) {
      const bound = await teamHubData(
        client.api.PUT("/v0/rooms/{roomId}/documents/{documentId}", {
          params: {
            path: { roomId, documentId: document.id },
          },
        }),
      );
      if (
        bound.id !== document.id ||
        bound.tenant_id !== tenantId ||
        !bound.from.some(
          (source) =>
            source.binding_kind === "room" && source.context_id === roomId,
        )
      ) {
        throw new Error("Document binding was not established.");
      }
      await queryClient.invalidateQueries({
        queryKey: roomDocumentsQueryKey(tenantId, roomId),
      });
    }
    return {
      documentId: document.id,
      name: document.title,
      tenantId,
      updatedAt: document.updated_at,
    };
  } catch {
    throw new Error(translate(composerMessages.documentCannotBeShared));
  }
}

type RoomMessageComposerProps = ComponentProps<typeof MessageComposer> & {
  agentDirectoryError: boolean;
  onRetryAgents: () => void;
};

function RoomMessageComposer({
  agentDirectoryError,
  documentOptions = EMPTY_DOCUMENT_OPTIONS,
  documentOptionsReady,
  onRetryAgents,
  ...composerProps
}: RoomMessageComposerProps) {
  return (
    <>
      <MessageComposer
        {...composerProps}
        documentOptions={documentOptions}
        documentOptionsReady={documentOptionsReady}
      />
      <RoomChatComposerNotices
        agentDirectoryError={agentDirectoryError}
        onRetryAgents={onRetryAgents}
      />
    </>
  );
}

interface ChannelViewOnlyBannerProps {
  channel: string;
  roomName: string;
}

/** View-only footer shown in external channel Rooms instead of a composer. */
export function ChannelViewOnlyBanner({
  channel,
  roomName,
}: ChannelViewOnlyBannerProps) {
  const t = useT();
  const channelLabel =
    channel === "imessage"
      ? t(composerMessages.channelIMessage)
      : channel === "wechat"
        ? t(composerMessages.channelWeChat)
        : roomName;
  return (
    <div className="px-4 pb-4 pt-2">
      <div
        className="mx-auto flex max-w-3xl items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3 text-sm shadow-xs"
        data-testid="channel-view-only-banner"
      >
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
        >
          <Icon icon={Message01Icon} size={16} />
        </span>
        <div className="min-w-0">
          <p className="font-medium text-foreground">
            {t(composerMessages.channelViewOnlyTitle)}
          </p>
          <p className="text-xs text-muted-foreground">
            {t(composerMessages.channelViewOnlyDescription, {
              channel: channelLabel,
            })}
          </p>
        </div>
      </div>
    </div>
  );
}
