import { replaceEqualDeep } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  presentTeamHubMessageAttachments,
  type TeamHubMessagePresentation,
} from "@/features/teamhub/teamhub-runtime";
import { referencedMessageActors } from "@/features/teamhub/teamhub-message-content";
import type {
  TeamHubActorRef,
  TeamHubMessage,
} from "@/features/teamhub/teamhub-types";

type RoomMessagePresentations = Record<string, TeamHubMessagePresentation>;

interface RoomMessagePresentationInput {
  deliveryPresentations: Readonly<RoomMessagePresentations>;
  mentionOptions: TeamHubActorRef[];
  messages: TeamHubMessage[];
  roomMessagePresentations: Readonly<RoomMessagePresentations>;
}

interface CachedMessagePresentation {
  deliveryPresentation: TeamHubMessagePresentation | undefined;
  mentionOptions: TeamHubActorRef[];
  roomPresentation: TeamHubMessagePresentation | undefined;
  value: TeamHubMessagePresentation;
}

const cachedByMessage = new WeakMap<
  TeamHubMessage,
  CachedMessagePresentation
>();

/**
 * Resolves presentations and keeps every entry whose inputs or content did not
 * change, so memoized rows skip unrelated Messages without mutating refs.
 */
export function useRoomMessagePresentations({
  deliveryPresentations,
  mentionOptions,
  messages,
  roomMessagePresentations,
}: RoomMessagePresentationInput) {
  return useMemo(() => {
    const presentations: RoomMessagePresentations = {
      ...deliveryPresentations,
      ...roomMessagePresentations,
    };
    for (const message of messages) {
      const deliveryPresentation = deliveryPresentations[message.id];
      const roomPresentation = roomMessagePresentations[message.id];
      const cached = cachedByMessage.get(message);
      if (
        cached &&
        cached.deliveryPresentation === deliveryPresentation &&
        cached.roomPresentation === roomPresentation &&
        cached.mentionOptions === mentionOptions
      ) {
        presentations[message.id] = cached.value;
        continue;
      }
      const next = resolveOneMessagePresentation(
        message,
        deliveryPresentation,
        roomPresentation,
        mentionOptions,
      );
      const value = cached ? replaceEqualDeep(cached.value, next) : next;
      cachedByMessage.set(message, {
        deliveryPresentation,
        mentionOptions,
        roomPresentation,
        value,
      });
      presentations[message.id] = value;
    }
    return presentations;
  }, [
    deliveryPresentations,
    mentionOptions,
    messages,
    roomMessagePresentations,
  ]);
}

export function resolveRoomMessagePresentations({
  deliveryPresentations,
  mentionOptions,
  messages,
  roomMessagePresentations,
}: RoomMessagePresentationInput): RoomMessagePresentations {
  const presentations = {
    ...deliveryPresentations,
    ...roomMessagePresentations,
  };

  for (const message of messages) {
    presentations[message.id] = resolveOneMessagePresentation(
      message,
      deliveryPresentations[message.id],
      roomMessagePresentations[message.id],
      mentionOptions,
    );
  }

  return presentations;
}

function resolveOneMessagePresentation(
  message: TeamHubMessage,
  deliveryPresentation: TeamHubMessagePresentation | undefined,
  roomPresentation: TeamHubMessagePresentation | undefined,
  mentionOptions: TeamHubActorRef[],
): TeamHubMessagePresentation {
  const mentions = roomPresentation?.mentions.length
    ? roomPresentation.mentions
    : deliveryPresentation?.mentions.length
      ? deliveryPresentation.mentions
      : referencedMessageActors(message.segments, mentionOptions);
  return {
    attachments: firstPresentedAttachments(
      roomPresentation?.attachments,
      deliveryPresentation?.attachments,
      presentTeamHubMessageAttachments(message),
    ),
    mentions,
  };
}

function firstPresentedAttachments(
  ...candidates: Array<TeamHubMessagePresentation["attachments"] | undefined>
): TeamHubMessagePresentation["attachments"] {
  for (const candidate of candidates) {
    if (candidate?.length) return candidate;
  }
  return [];
}
