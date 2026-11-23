import {
  AlertCircleIcon,
  Cancel01Icon,
  Clock01Icon,
  CommandLineIcon,
  Cursor01Icon,
  HelpCircleIcon,
  Loading03Icon,
  Tick02Icon,
  UserAdd01Icon,
  UserEdit01Icon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { lazy, type ReactNode, Suspense, useState } from "react";

import { Button } from "@/components/ui/button";
import { Icon, type IconSvgElement } from "@/components/ui/icon";
import type { VoiceRisk } from "@/features/rooms/chat/voice-mode/voice-ui-bridge";
import type { TeamHubMessageCard } from "@/features/teamhub/teamhub-types";
import {
  formatLocale,
  translate,
  type Translate,
  type Translation,
} from "@/i18n/language";
import type { Message } from "@/i18n/messages";
import { useTranslation } from "@/i18n/use-translation";
import { formatDateTime } from "@/lib/date-format";

import {
  CardActions,
  CardError,
  CardRow,
  CardRowDetails,
  DecisionActions,
} from "./approval-card-parts";
import { decisionCardHeading } from "./card-prompts";
import { CardBox, CardDone, type ReceiptTone } from "./card-shell";
import { cardsMessages } from "./cards.messages";
import { ConnectedAppIcon } from "./connected-app-identity";
import { connectedAppDisplayName } from "./connected-app-names";
import { AgentChangeDecisionView } from "./decision-agent-change-view";
import {
  ConnectorWriteDecisionView,
  EmailDecisionView,
} from "./decision-connector-write-view";
import {
  OpenCreatedRoomLink,
  RoomCreationDecisionView,
} from "./decision-room-creation-view";
import {
  diffStats,
  PermissionScreenshot,
  RuntimePermissionDecisionView,
} from "./decision-runtime-permission-view";
import type { RoomCardDecision } from "./room-message-card-contract";

const QuestionDecision = lazy(async () => {
  const module = await import("./decision-question-view");
  return { default: module.QuestionDecision };
});
const ProfileSetupDecision = lazy(async () => {
  const module = await import("./decision-profile-setup-view");
  return { default: module.ProfileSetupDecision };
});
const ConnectionAuthDecision = lazy(async () => {
  const module = await import("./decision-connection-auth-view");
  return { default: module.ConnectionAuthDecision };
});
const ProviderKeyDecision = lazy(async () => {
  const module = await import("./decision-provider-key-view");
  return { default: module.ProviderKeyDecision };
});
const SearchKeyDecision = lazy(async () => {
  const module = await import("./decision-search-key-view");
  return { default: module.SearchKeyDecision };
});
const BrowserConnectionDecision = lazy(async () => {
  const module = await import("./decision-browser-connection-view");
  return { default: module.BrowserConnectionDecision };
});
const ComputerPermissionDecision = lazy(async () => {
  const module = await import("./decision-computer-permission-view");
  return { default: module.ComputerPermissionDecision };
});

export type DecisionMessageCard = Extract<
  TeamHubMessageCard,
  { intent: "decision_requested" }
>;
type DecisionState =
  | "pending"
  | "approved"
  | "used"
  | "running"
  | "done"
  | "failed"
  | "unknown"
  | "denied"
  | "expired";

interface DecisionCardProps {
  actorDisplayNames?: Readonly<Record<string, string>>;
  card: DecisionMessageCard;
  currentActorId?: string;
  messageId: string;
  onDecision: (decision: RoomCardDecision) => Promise<void> | void;
  roomId: string;
  /** Any member may decide a Room creation an Agent visible to the whole
   * workspace asked for. */
  roomMemberDecisionAllowed?: boolean;
  tenantId: string;
}

/**
 * Every card that waits on one Human's decision. A question, the AnotherMe
 * setup cards, a connection authorization (its OAuth connection), a
 * Composio or web search key request, a browser connection and a computer
 * permission take their answer in their own slot; every other kind shows its
 * request and the view its kind adds, Approve or Deny with a reason, and how
 * it ended.
 */
export function DecisionCard(props: DecisionCardProps) {
  const { card } = props;
  switch (card.kind) {
    case "question":
      return (
        <Suspense fallback={null}>
          <QuestionDecision {...props} />
        </Suspense>
      );
    case "profile_setup_apps":
    case "profile_setup_sources":
      return (
        <Suspense fallback={null}>
          <ProfileSetupDecision {...props} />
        </Suspense>
      );
    case "connection_auth":
      return (
        <Suspense fallback={null}>
          <ConnectionAuthDecision {...props} />
        </Suspense>
      );
    case "provider_key":
      return (
        <Suspense fallback={null}>
          <ProviderKeyDecision {...props} />
        </Suspense>
      );
    case "search_key":
      return (
        <Suspense fallback={null}>
          <SearchKeyDecision {...props} />
        </Suspense>
      );
    case "browser_connection":
      return (
        <Suspense fallback={null}>
          <BrowserConnectionDecision {...props} />
        </Suspense>
      );
    case "computer_permission":
      return (
        <Suspense fallback={null}>
          <ComputerPermissionDecision {...props} />
        </Suspense>
      );
    default:
      return <ApprovalDecision {...props} />;
  }
}

/**
 * An approval: the request as one more bubble from the Agent, then a box
 * with the one thing TeamHub will run, which opens to its full view, and the
 * buttons, or how it ended. TeamHub runs an approved Connector write or Agent
 * change itself, and creates an approved Room at once; an approved Runtime
 * permission lets the Agent retry its call once.
 */
function ApprovalDecision({
  actorDisplayNames,
  card,
  currentActorId,
  messageId,
  onDecision,
  roomMemberDecisionAllowed,
  tenantId,
}: DecisionCardProps) {
  const translation = useTranslation();
  const { t } = translation;
  const [now] = useState(Date.now);
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const state = decisionState(card, now);
  const roomCreation = card.kind === "room_creation";
  const write = card.connector_write;
  const email =
    write?.kind === "message" &&
    (write.app === "gmail" ||
      write.app === "outlook" ||
      write.app === "feishu_mail")
      ? write.message
      : undefined;
  const canDecide =
    state === "pending" &&
    Boolean(currentActorId) &&
    (currentActorId === card.decision_owner.id ||
      (roomCreation && Boolean(roomMemberDecisionAllowed)));

  async function decide(decision: "approve" | "deny", reason?: string) {
    setDecisionError(null);
    setSubmitting(true);
    try {
      await onDecision({
        decision,
        expectedVersion: card.version,
        feedback: reason || undefined,
        messageId,
        requestId: card.decision_id,
      });
    } catch (error) {
      setDecisionError(
        error instanceof Error
          ? error.message
          : translate(cardsMessages.cardDecisionFailed),
      );
    } finally {
      setSubmitting(false);
    }
  }

  const label = t(
    card.kind === "runtime_permission"
      ? cardsMessages.labelPermissionRequest
      : roomCreation
        ? cardsMessages.labelRoomCreation
        : cardsMessages.labelConfirmationRequest,
  );
  const words = approvalWords(card);
  // The title heads the box; the row then names what runs without repeating it.
  const summary = approvalSummary(card, actorDisplayNames, card.title, t);
  const done = doneLine(state, card, words, translation);
  const screenshot = card.runtime_permission?.screenshot ? (
    <PermissionScreenshot
      canSee={currentActorId === card.decision_owner.id}
      ownerName={card.decision_owner.display_name}
      screenshot={card.runtime_permission.screenshot}
    />
  ) : null;

  return (
    <>
      <CardBox
        heading={email ? undefined : decisionCardHeading(card, t)}
        label={label}
      >
        {email ? (
          <EmailDecisionView account={write?.account ?? ""} message={email} />
        ) : (
          <CardRow
            detail={summary.detail}
            icon={summary.icon}
            onToggle={() => setOpen((current) => !current)}
            open={open}
            title={summary.title}
          />
        )}
        {/* Why the review stopped the call: what a person weighs before
            allowing it, so it stays in view. */}
        {card.runtime_permission?.rationale?.trim() ? (
          <p className="pb-1.5 text-xs text-app-muted [overflow-wrap:anywhere]">
            {card.runtime_permission.rationale}
          </p>
        ) : null}
        <CardRowDetails open={!email && open}>
          {state === "pending" ? null : screenshot}
          {card.connector_write ? (
            <ConnectorWriteDecisionView view={card.connector_write} />
          ) : null}
          {card.agent_change ? (
            <AgentChangeDecisionView view={card.agent_change} />
          ) : null}
          {card.runtime_permission ? (
            <RuntimePermissionDecisionView view={card.runtime_permission} />
          ) : null}
          {card.room_creation ? (
            <RoomCreationDecisionView
              actorDisplayNames={actorDisplayNames}
              view={card.room_creation}
            />
          ) : null}
        </CardRowDetails>
        {state === "pending" && screenshot ? (
          <div className="pb-2">{screenshot}</div>
        ) : null}
        {canDecide ? (
          <CardActions>
            {email ? (
              <div
                aria-label={t(cardsMessages.approvalActions)}
                className="flex gap-2"
                role="group"
              >
                <Button
                  data-voice-risk={words.approveRisk}
                  disabled={submitting}
                  onClick={() => void decide("approve")}
                  size="large"
                  tone="primary"
                >
                  {t(words.approve)}
                </Button>
                <Button
                  data-voice-risk={words.denyRisk}
                  disabled={submitting}
                  onClick={() => void decide("deny")}
                  size="large"
                  tone="ghost"
                >
                  {t(words.deny)}
                </Button>
              </div>
            ) : (
              <DecisionActions
                approveLabel={t(words.approve)}
                approveRisk={words.approveRisk}
                denyLabel={t(words.deny)}
                denyRisk={words.denyRisk}
                disabled={submitting}
                onApprove={() => void decide("approve")}
                onDeny={(reason) => void decide("deny", reason)}
                reasonRequired={roomCreation}
              />
            )}
          </CardActions>
        ) : done ? (
          <div className="flex min-w-0 items-center justify-between gap-2">
            <CardDone icon={done.icon} text={done.text} tone={done.tone} />
            {card.room_creation?.created_room_id ? (
              <div className="shrink-0 pr-2 pb-1">
                <OpenCreatedRoomLink
                  roomId={card.room_creation.created_room_id}
                  tenantId={tenantId}
                />
              </div>
            ) : null}
          </div>
        ) : null}
        {decisionError ? <CardError>{decisionError}</CardError> : null}
      </CardBox>
    </>
  );
}

function decisionState(card: DecisionMessageCard, now: number): DecisionState {
  const lapsed =
    card.expires_at !== undefined && Date.parse(card.expires_at) <= now;
  if (card.kind === "runtime_permission") {
    if (card.status === "consumed") return "used";
    if (card.status === "approved") return lapsed ? "expired" : "approved";
  }
  switch (card.status) {
    case "approved":
    case "executing":
      return "running";
    case "succeeded":
      return "done";
    case "failed":
    case "unknown":
    case "denied":
    case "expired":
      return card.status;
    default:
      return lapsed ? "expired" : "pending";
  }
}

interface ApprovalWords {
  approve: Message<string>;
  /** What Voice Mode risks by clicking approve or deny (`data-voice-risk`). */
  approveRisk?: VoiceRisk;
  approved: Message<string>;
  deny: Message<string>;
  denyRisk?: VoiceRisk;
  denied: Message<string>;
  running: Message<string>;
}

/** The buttons and outcomes in the words of what the approval does. */
function approvalWords(card: DecisionMessageCard): ApprovalWords {
  if (card.room_creation)
    return {
      approve: cardsMessages.createRoom,
      approved: cardsMessages.created,
      deny: cardsMessages.dontCreate,
      denied: cardsMessages.notCreated,
      running: cardsMessages.creating,
    };
  if (card.agent_change?.action === "create")
    return {
      approve: cardsMessages.create,
      approved: cardsMessages.created,
      deny: cardsMessages.dontCreate,
      denied: cardsMessages.notCreated,
      running: cardsMessages.creating,
    };
  if (card.agent_change)
    return {
      approve: cardsMessages.apply,
      approved: cardsMessages.applied,
      deny: cardsMessages.dontApply,
      denied: cardsMessages.notApplied,
      running: cardsMessages.applying,
    };
  if (card.runtime_permission)
    return {
      approve: cardsMessages.allowOnce,
      approved: cardsMessages.allowedOnce,
      deny: cardsMessages.dontAllow,
      denied: cardsMessages.notAllowed,
      running: cardsMessages.running,
    };
  if (card.connector_write?.kind === "message")
    return {
      approve: cardsMessages.send,
      approveRisk: "never",
      approved: cardsMessages.sent,
      deny: cardsMessages.dontSend,
      denyRisk: "never",
      denied: cardsMessages.notSent,
      running: cardsMessages.sending,
    };
  return {
    approve: cardsMessages.approve,
    approveRisk: "confirm",
    approved: cardsMessages.done,
    deny: cardsMessages.deny,
    denyRisk: "confirm",
    denied: cardsMessages.denied,
    running: cardsMessages.running,
  };
}

const fieldNames: Record<string, Message<string>> = {
  description: cardsMessages.agentFieldDescription,
  name: cardsMessages.agentFieldName,
  prompt: cardsMessages.agentFieldInstructions,
};

/** The one row that says what will actually run, as TeamHub froze it. */
function approvalSummary(
  card: DecisionMessageCard,
  actorDisplayNames: Readonly<Record<string, string>> = {},
  prompt: string,
  t: Translate,
): { detail?: string; icon: ReactNode; title: string } {
  const write = card.connector_write;
  if (write) {
    const source = [connectedAppDisplayName(write.app), write.account.trim()]
      .filter(Boolean)
      .join(" · ");
    const to = write.message?.to?.join(", ");
    const subject = write.message?.subject?.trim();
    const title = to ? [to, subject].filter(Boolean).join(" · ") : write.title;
    // A change titled like the bubble names its app and account instead.
    return title === prompt.trim()
      ? {
          detail: write.tool,
          icon: <ConnectedAppIcon appKey={write.app} size={16} />,
          title: source || write.tool,
        }
      : {
          detail: source,
          icon: <ConnectedAppIcon appKey={write.app} size={16} />,
          title,
        };
  }
  const permission = card.runtime_permission;
  if (permission) {
    const detail = permissionDetail(permission);
    const icon = (
      <Icon
        icon={permission.kind === "gui" ? Cursor01Icon : CommandLineIcon}
        size={16}
      />
    );
    // Without a reason the bubble already reads the title; name the tool.
    return permission.title === prompt.trim()
      ? {
          detail: detail === permission.tool ? undefined : detail,
          icon,
          title: permission.tool,
        }
      : { detail, icon, title: permission.title };
  }
  const change = card.agent_change;
  if (change) {
    const create = change.action === "create";
    const description = change.changes.find(
      (item) => item.field === "description",
    )?.after;
    const changed = change.changes.map((item) => {
      const name = fieldNames[item.field];
      return name ? t(name) : item.field;
    });
    return {
      detail: create
        ? description || undefined
        : changed.length
          ? capitalize(changed.join(t(cardsMessages.listSeparator)))
          : undefined,
      icon: <Icon icon={create ? UserAdd01Icon : UserEdit01Icon} size={16} />,
      title: create
        ? t(cardsMessages.newAgent, { name: change.agent_name })
        : t(cardsMessages.changeAgent, { name: change.agent_name }),
    };
  }
  const room = card.room_creation;
  if (room) {
    const count = room.member_ids.length;
    const names = room.member_ids
      .map((id) => actorDisplayNames[id])
      .filter(Boolean)
      .join(t(cardsMessages.listSeparator));
    return {
      detail: names
        ? t(cardsMessages.memberCountWithNames, { count, names })
        : t(cardsMessages.memberCount, { count }),
      icon: <Icon icon={UserGroupIcon} size={16} />,
      title: t(cardsMessages.newRoom, { name: room.name }),
    };
  }
  return {
    icon: <Icon icon={HelpCircleIcon} size={16} />,
    title: card.title,
  };
}

function permissionDetail(
  view: NonNullable<DecisionMessageCard["runtime_permission"]>,
) {
  if (view.patch) {
    const { added, removed } = diffStats(view.patch);
    return `+${added} −${removed}`;
  }
  if (view.script) return view.script.path;
  if (view.page) {
    try {
      return new URL(view.page.url).host;
    } catch {
      return view.page.url;
    }
  }
  return view.tool;
}

function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What takes the buttons' place once the request is no longer waiting. */
function doneLine(
  state: DecisionState,
  card: DecisionMessageCard,
  words: ApprovalWords,
  translation: Translation,
): { icon: IconSvgElement; text: string; tone: ReceiptTone } | null {
  const { t } = translation;
  const approved = t(words.approved);
  const outcome = card.outcome?.trim();
  switch (state) {
    case "approved":
      return {
        icon: Tick02Icon,
        text: card.expires_at
          ? t(cardsMessages.approvedUntil, {
              approved,
              time: formatTime(card.expires_at, translation),
            })
          : approved,
        tone: "success",
      };
    case "used":
      return {
        icon: Tick02Icon,
        text: t(cardsMessages.approvedUsed, { approved }),
        tone: "success",
      };
    case "running":
      return { icon: Loading03Icon, text: t(words.running), tone: "muted" };
    case "done":
      return { icon: Tick02Icon, text: approved, tone: "success" };
    case "failed":
      return {
        icon: AlertCircleIcon,
        text: outcome
          ? t(cardsMessages.failedWithOutcome, { outcome })
          : t(cardsMessages.failed),
        tone: "danger",
      };
    case "unknown":
      return {
        icon: HelpCircleIcon,
        text: outcome
          ? t(cardsMessages.resultUnknownWithOutcome, { outcome })
          : t(cardsMessages.resultUnknown),
        tone: "warning",
      };
    case "denied": {
      const reason = card.answer?.comment?.trim();
      return {
        icon: Cancel01Icon,
        text: reason
          ? t(cardsMessages.deniedWithReason, {
              denied: t(words.denied),
              reason,
            })
          : t(words.denied),
        tone: "muted",
      };
    }
    case "expired":
      return {
        icon: Clock01Icon,
        text: t(cardsMessages.expired),
        tone: "muted",
      };
    default:
      return null;
  }
}

const expiryOptions: Intl.DateTimeFormatOptions = {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
};

/** In the language of the card and the viewer's time zone. */
function formatTime(value: string, translation: Translation) {
  return formatDateTime(
    value,
    expiryOptions,
    formatLocale(translation.language),
  );
}
