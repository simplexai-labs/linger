import { UserAdd01Icon, UserEdit01Icon } from "@hugeicons/core-free-icons";
import { useId, useState, type ReactNode } from "react";

import { Icon } from "@/components/ui/icon";
import type {
  TeamHubActorRef,
  TeamHubMessage,
} from "@/features/teamhub/teamhub-types";
import type { Message } from "@/i18n/messages";
import { RichMessage, useT } from "@/i18n/use-translation";

import { AgentChangeFields } from "../cards/agent-change-fields";
import { ActorAvatar } from "../members/actor-avatar";
import { chatMessages } from "./chat.messages";

type RoomNotice = NonNullable<TeamHubMessage["notice"]>;

const fieldNames: Record<string, Message<string>> = {
  description: chatMessages.noticeFieldDescription,
  instructions: chatMessages.noticeFieldInstructions,
  name: chatMessages.noticeFieldName,
  prompt: chatMessages.noticeFieldPrompt,
};

const linkClass =
  "text-app-info hover:text-app-info-hover hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-app-info";

/**
 * A Room notice: a short centered line saying an Agent created an Agent,
 * someone added a member, or an Agent's identity changed. It has
 * no avatar column, actions, Reactions or Thread; the change details of an
 * identity change stay folded until asked for.
 */
export function RoomNoticeRow({
  currentActorId,
  entering = false,
  message,
  onOpenDirectChat,
  onOpenProfile,
}: {
  currentActorId?: string;
  entering?: boolean;
  message: TeamHubMessage;
  onOpenDirectChat?: (actorId: string) => void;
  onOpenProfile: (actorId: string) => void;
}) {
  const notice = message.notice;
  return (
    <div
      className="room-notice-row flex flex-col items-center gap-2 py-1"
      data-entering={entering}
      data-message-kind="room_notice"
      role="note"
    >
      {notice ? (
        <NoticeLine
          author={message.author}
          currentActorId={currentActorId}
          fallback={message.raw_message}
          notice={notice}
          onOpenDirectChat={onOpenDirectChat}
          onOpenProfile={onOpenProfile}
        />
      ) : (
        <span className={pillClass}>{message.raw_message}</span>
      )}
    </div>
  );
}

const pillClass =
  "inline-flex max-w-full flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 rounded-xl bg-muted px-3 py-1 text-center text-xs leading-[18px] text-muted-foreground";

function NoticeLine({
  author,
  currentActorId,
  fallback,
  notice,
  onOpenDirectChat,
  onOpenProfile,
}: {
  author: TeamHubActorRef;
  currentActorId?: string;
  fallback: string;
  notice: RoomNotice;
  onOpenDirectChat?: (actorId: string) => void;
  onOpenProfile: (actorId: string) => void;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const profileLink = (actorId: string) => (
    <>
      <Separator />
      <button
        className={linkClass}
        onClick={() => onOpenProfile(actorId)}
        type="button"
      >
        {t(chatMessages.viewProfile)}
      </button>
    </>
  );
  // The sentence of a notice names its actors; the translation places them.
  const authorName = () => <ActorName actor={author} />;

  switch (notice.type) {
    case "agent_created": {
      const approver = notice.approved_by;
      const tags = {
        agent: () => <ActorName actor={notice.agent} />,
        author: authorName,
      };
      const names = {
        agent: notice.agent.display_name,
        author: author.display_name,
      };
      return (
        <Pill icon={UserAdd01Icon}>
          {!approver ? (
            <RichMessage
              message={chatMessages.noticeAgentCreated}
              tags={tags}
              values={names}
            />
          ) : approver.id === currentActorId ? (
            <RichMessage
              message={chatMessages.noticeAgentCreatedAfterYourApproval}
              tags={tags}
              values={names}
            />
          ) : (
            <RichMessage
              message={chatMessages.noticeAgentCreatedAfterApproval}
              tags={tags}
              values={{ ...names, approver: approver.display_name }}
            />
          )}
          {approver && onOpenDirectChat ? (
            <>
              <Separator />
              <button
                className={linkClass}
                onClick={() => onOpenDirectChat(notice.agent.id)}
                type="button"
              >
                {t(chatMessages.openDirectChat)}
              </button>
            </>
          ) : (
            profileLink(notice.agent.id)
          )}
        </Pill>
      );
    }
    case "member_added":
      return (
        <Pill icon={UserAdd01Icon}>
          <RichMessage
            message={chatMessages.noticeMemberAdded}
            tags={{
              author: authorName,
              member: () => <ActorName actor={notice.member} />,
            }}
            values={{
              author: author.display_name,
              member: notice.member.display_name,
            }}
          />
        </Pill>
      );
    case "agent_profile_changed": {
      const before =
        notice.changes.find((change) => change.field === "name")?.before ??
        notice.agent.display_name;
      const agentName = () => <ActorName actor={notice.agent} />;
      if (notice.initialized) {
        return (
          <Pill icon={UserEdit01Icon}>
            {author.id === notice.agent.id ? (
              <RichMessage
                message={chatMessages.noticeAgentSetUpOwnIdentity}
                tags={{ agent: agentName }}
                values={{ agent: notice.agent.display_name, before }}
              />
            ) : (
              <RichMessage
                message={chatMessages.noticeAgentSetUpBy}
                tags={{ agent: agentName, author: authorName }}
                values={{
                  agent: notice.agent.display_name,
                  author: author.display_name,
                  before,
                }}
              />
            )}
            {profileLink(notice.agent.id)}
          </Pill>
        );
      }
      const fields = [
        ...notice.changes.map((change) => change.field),
        ...(notice.instructions_changed ? ["instructions"] : []),
      ];
      return (
        <>
          <Pill icon={UserEdit01Icon}>
            <RichMessage
              message={chatMessages.noticeAgentUpdated}
              tags={{ agent: agentName, author: authorName }}
              values={{
                agent: notice.agent.display_name,
                author: author.display_name,
              }}
            />
            <Separator />
            <Words>
              {fields
                .map((field) => {
                  const name = fieldNames[field];
                  return name ? t(name) : field;
                })
                .join(t(chatMessages.listSeparator))}
            </Words>
            <Separator />
            <button
              aria-controls={detailsId}
              aria-expanded={expanded}
              className={linkClass}
              onClick={() => setExpanded((open) => !open)}
              type="button"
            >
              {expanded
                ? t(chatMessages.hideChanges)
                : t(chatMessages.showChanges)}
            </button>
          </Pill>
          {expanded ? (
            <div
              className="grid w-full max-w-[440px] gap-2 rounded-xl bg-card px-3.5 py-2.5 text-xs shadow-outline"
              id={detailsId}
            >
              {notice.changes.length ? (
                <AgentChangeFields changes={notice.changes} />
              ) : null}
              {notice.instructions_changed ? (
                <p className="m-0 text-app-muted">
                  {t(chatMessages.instructionsUpdated)}
                  <Separator />
                  <button
                    className={linkClass}
                    onClick={() => onOpenProfile(notice.agent.id)}
                    type="button"
                  >
                    {t(chatMessages.viewInAgentInfo)}
                  </button>
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      );
    }
    default:
      // A notice type this client does not know yet shows its plain line.
      return <span className={pillClass}>{fallback}</span>;
  }
}

function Pill({
  children,
  icon,
}: {
  children: ReactNode;
  icon: typeof UserAdd01Icon;
}) {
  return (
    <span className={pillClass}>
      <Icon className="shrink-0" icon={icon} size={14} />
      {children}
    </span>
  );
}

function ActorName({ actor }: { actor: TeamHubActorRef }) {
  return (
    <span className="inline-flex items-center gap-1 font-medium text-foreground">
      <ActorAvatar
        actorId={actor.id}
        kind={actor.kind}
        name={actor.display_name}
        size="micro"
      />
      {` ${actor.display_name} `}
    </span>
  );
}

function Separator() {
  return (
    <span aria-hidden="true" className="text-border-hover">
      {" · "}
    </span>
  );
}

/** Words between names; the spaces keep the line readable as text, while the
 * pill's gap does the visual spacing. */
function Words({ children }: { children: ReactNode }) {
  return <span> {children} </span>;
}
