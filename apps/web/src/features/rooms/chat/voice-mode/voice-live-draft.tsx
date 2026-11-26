import type { TeamHubActorRef } from "@/features/teamhub/teamhub-types";
import { ActorAvatar } from "../../members/actor-avatar";
import { useT } from "@/i18n/use-translation";
import { voiceChatMessages as m } from "./voice-chat.messages";
import { FadingText } from "./fading-text";

export interface VoiceLiveDraft {
  actor: TeamHubActorRef;
  error?: string;
  statusLabel: string;
  text: string;
}

export function VoiceLiveDraftRow({
  draft,
  startsGroup = true,
}: {
  draft: VoiceLiveDraft;
  startsGroup?: boolean;
}) {
  const t = useT();
  if (!draft.text && !draft.error) return null;
  return (
    <article
      aria-label={t(m.liveDraft)}
      className="room-message-card message-row"
      data-author-kind="human"
      data-current-actor="true"
      data-group-start={startsGroup}
      data-voice-live-draft="true"
    >
      <div className="room-message-avatar">
        {startsGroup ? (
          <ActorAvatar
            actorId={draft.actor.id}
            kind={draft.actor.kind}
            name={draft.actor.display_name}
            size="sm"
          />
        ) : null}
      </div>
      <div className="room-message-content min-w-0">
        {draft.text ? (
          // Words arrive as in the voice window: the bubble fades in, then
          // each new phrase fades in whole while earlier words stay put.
          <div className="room-message-bubble voice-live-fade-in text-sm leading-5 text-app-body">
            <p className="whitespace-pre-wrap break-words">
              <FadingText text={draft.text} />
            </p>
          </div>
        ) : null}
        {draft.error ? (
          <p className="mt-1 text-xs text-app-danger" role="alert">
            {draft.error}
          </p>
        ) : null}
      </div>
    </article>
  );
}
