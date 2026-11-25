import type { ComponentProps } from "react";

import { isRunWorking } from "@/features/teamhub/run-status";
import { useT } from "@/i18n/use-translation";

import { chatMessages } from "./chat.messages";

import {
  JumpToLatestButton,
  type JumpToLatestOffset,
} from "./jump-to-latest-button";
import { MessageTimeline } from "./message-timeline";
import { useRoomBackgroundTasks } from "./use-room-background-tasks";
import type { RoomChatData } from "./use-room-chat-data";
import type { RoomChatConversationState } from "./use-room-chat-conversation-state";
import type { RoomChatTimelineActions } from "./use-room-chat-timeline-actions";

interface RoomChatTimelineSectionProps {
  actions: RoomChatTimelineActions;
  data: RoomChatData;
  state: RoomChatConversationState;
}

/** The scrolling Room timeline, including a linked Message outside it. */
export function RoomChatTimelineSection({
  actions,
  data,
  state,
}: RoomChatTimelineSectionProps) {
  const {
    actorItems,
    client,
    linkedInTimeline,
    linkedMessage,
    linkedMessageId,
    members,
    messages,
    navigation,
    room,
    roomId,
    setForwardMessage,
    tenantId,
  } = data;
  const {
    agentStreaming,
    conversation,
    currentActorId,
    delivery,
    dock,
    documentMetadata,
    documentTitles,
    interactions,
    linkedPresentedMessage,
    mentionOptions,
    onboarding,
    presentedMessages,
    timeline,
    voiceLiveDraft,
  } = state;
  const backgroundTasks = useRoomBackgroundTasks({
    client,
    roomId: room.participation === "left" ? "" : roomId,
    tenantId,
  });
  const hasStreamingDock =
    room.participation !== "left" &&
    (Boolean(dock.typingAgent) || (dock.runStatuses?.length ?? 0) > 0);
  const hasBackgroundTasks =
    room.participation !== "left" && backgroundTasks.length > 0;
  const jumpButtonOffset: JumpToLatestOffset =
    hasStreamingDock && hasBackgroundTasks
      ? "stacked"
      : hasStreamingDock || hasBackgroundTasks
        ? "raised"
        : "default";
  return (
    <RoomTimelineViewport
      agentWorking={conversation.streamingRunStatuses.some(isRunWorking)}
      awayFromLatest={timeline.awayFromLatest}
      jumpButtonOffset={jumpButtonOffset}
      onJumpToLatest={timeline.scrollToLatest}
      actorDisplayNames={actions.actorDisplayNames}
      canLoadOlder={messages.hasNextPage}
      currentActorId={currentActorId}
      documentTitles={documentTitles}
      documentMetadata={documentMetadata}
      initialScrollReady={timeline.initialScrollReady}
      loadingOlder={messages.isFetchingNextPage}
      linkedSource={
        linkedMessageId && !linkedInTimeline
          ? linkedMessage.isError
            ? {
                kind: "error",
                retry: () => void linkedMessage.refetch(),
              }
            : linkedMessage.data
              ? {
                  kind: "ready",
                  message: linkedPresentedMessage!,
                }
              : { kind: "loading" }
          : undefined
      }
      messages={presentedMessages}
      messagesArriving={onboarding.messagesHeld}
      voiceLiveDraft={voiceLiveDraft ?? undefined}
      runStatuses={conversation.streamingRunStatuses}
      runtimePresentationEventsByRunStatusId={
        agentStreaming.runtimePresentationEventsByRunStatusId
      }
      mentionableActorIds={new Set(mentionOptions.map((actor) => actor.id))}
      memberActorIds={new Set(members.items.map((member) => member.actor.id))}
      onCancel={delivery.cancelMessage}
      onCardDecision={actions.timelineActions.onCardDecision}
      onCloseLinkedSource={navigation.closeLinkedMessage}
      onToggleReaction={conversation.toggleReaction}
      actorKinds={actions.actorKinds}
      onForwardMessage={setForwardMessage}
      onMentionAuthor={interactions.mentionAuthor}
      onOpenMessageFile={navigation.openMessageFile}
      onOpenArtifact={navigation.previewArtifact}
      onOpenProfile={actions.openActorProfile}
      onOpenAgentActivity={(actorId, runStatusId, runId) => {
        const actor = actorItems.find((candidate) => candidate.id === actorId);
        if (actor) {
          if (runStatusId)
            navigation.openLiveActivity(actor, runStatusId, runId);
          else navigation.openAgentActivity(actor);
        }
      }}
      onOpenDirectChat={actions.openDirectChat}
      onOpenUrl={actions.timelineActions.onOpenUrl}
      onOpenThread={navigation.openThread}
      onReply={interactions.replyToMessage}
      onRetry={delivery.retryMessage}
      pendingMessages={conversation.pendingMessages}
      presentations={actions.resolvedPresentations}
      selectedContextMessageIds={
        new Set(
          interactions.selectedContextMessages.map((message) => message.id),
        )
      }
      tenantId={tenantId}
      workspaceAgentIds={actions.workspaceAgentIds}
      focusedMessageId={linkedInTimeline ? linkedMessageId : undefined}
      focusedMessageHighlight={
        linkedInTimeline ? navigation.linkedMessageHighlight : undefined
      }
      viewportOnScroll={(event) => {
        timeline.recordTimelineScroll(event.currentTarget);
        actions.loadOlderNearTop(event.currentTarget);
      }}
      viewportRef={timeline.timelineRef}
    />
  );
}

type RoomTimelineViewportProps = ComponentProps<typeof MessageTimeline> & {
  agentWorking: boolean;
  awayFromLatest: boolean;
  initialScrollReady: boolean;
  jumpButtonOffset: JumpToLatestOffset;
  onJumpToLatest: () => void;
  viewportOnScroll: NonNullable<ComponentProps<"div">["onScroll"]>;
  viewportRef: ComponentProps<"div">["ref"];
};

function RoomTimelineViewport({
  agentWorking,
  awayFromLatest,
  initialScrollReady,
  jumpButtonOffset,
  onJumpToLatest,
  viewportOnScroll,
  viewportRef,
  ...timelineProps
}: RoomTimelineViewportProps) {
  const t = useT();
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        aria-label={t(chatMessages.roomTimeline)}
        data-voice-scroll="main"
        className={`room-timeline workspace-scrollbar flex flex-1 flex-col overflow-y-scroll [overflow-anchor:none] ${
          initialScrollReady ? "" : "invisible"
        }`}
        data-initial-scroll-ready={initialScrollReady}
        onScroll={viewportOnScroll}
        ref={viewportRef}
      >
        <MessageTimeline {...timelineProps} />
      </div>
      {awayFromLatest ? (
        <JumpToLatestButton
          agentWorking={agentWorking}
          bottomOffset={jumpButtonOffset}
          onClick={onJumpToLatest}
        />
      ) : null}
    </div>
  );
}
