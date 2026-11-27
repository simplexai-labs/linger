// Decision cards, answered on the phone for every kind as on the web: the
// shell (who asks, the status, the title and the full request) and each
// kind's answers. Kinds with their own flows live beside this file:
// Connected App setup and authorization in decision-setup-views.tsx, API
// keys in decision-key-views.tsx.
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { Image, Pressable, StyleSheet, View } from "react-native";

import { decisionScreenshot } from "../api/teamhub";
import type { DecisionCard as Card, MessageSegment } from "../api/types";
import { useComputer } from "../computer/computer-context";
import { toBase64 } from "../lib/bytes";
import {
  teamHubKey,
  useAgentNames,
  useRoomMembers,
  useTeamHub,
  useWorkspaceAgentIds,
} from "../state/queries";
import { colors, radius, shadow, space, touchTarget, type } from "../theme";
import { ActorAvatar } from "../ui/avatar";
import { Button } from "../ui/controls";
import { Text, TextInput } from "../ui/text";
import type { Translate } from "../i18n/language";
import type { Message as UiMessage } from "../i18n/messages";
import { useTranslation } from "../i18n/use-translation";
import { useDecisionAnswer } from "./decision-answer";
import { chatDecisionMessages as m } from "./decision-card.messages";
import { ProviderKey, SearchKey } from "./decision-key-views";
import { ApprovalActions } from "./decision-parts";
import { canDecide, denyRequest, denyTakesReason } from "./decision-rules";
import {
  ConnectionAuth,
  ProfileSetupApps,
  ProfileSetupSources,
  type DecisionViewProps,
} from "./decision-setup-views";

const STATUS_LABELS: Record<Card["status"], UiMessage<string>> = {
  pending: m.statusPending,
  approved: m.statusApproved,
  executing: m.statusExecuting,
  succeeded: m.statusSucceeded,
  failed: m.statusFailed,
  unknown: m.statusUnknown,
  denied: m.statusDenied,
  expired: m.statusExpired,
  answered: m.statusAnswered,
  consumed: m.statusAnswered,
  authorizing: m.statusAuthorizing,
};

function Detail(props: {
  readonly label: string;
  readonly value?: string;
  readonly mono?: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  if (!props.value) return null;
  const long = props.value.length > 400;
  const shown =
    long && !expanded ? `${props.value.slice(0, 400)}…` : props.value;
  return (
    <View style={styles.detail}>
      <Text style={type.caption}>{props.label}</Text>
      <Text style={props.mono ? type.mono : type.body} selectable>
        {shown}
      </Text>
      {long ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            expanded
              ? t(m.showLessOf, { label: props.label })
              : t(m.showAllOf, { label: props.label })
          }
          onPress={() => setExpanded(!expanded)}
          hitSlop={8}
        >
          <Text style={styles.more}>
            {expanded ? t(m.showLess) : t(m.showAll)}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function Screenshot(props: {
  readonly decisionId: string;
  readonly width: number;
  readonly height: number;
}) {
  const { t } = useTranslation();
  const teamHub = useTeamHub();
  const screenshot = useQuery({
    queryKey: teamHubKey(
      teamHub.hostId,
      "decision-screenshot",
      props.decisionId,
    ),
    enabled: teamHub.connected,
    staleTime: Infinity,
    queryFn: async () => {
      const image = await teamHub.run((session) =>
        decisionScreenshot(session, props.decisionId),
      );
      return `data:${image.contentType};base64,${toBase64(image.bytes)}`;
    },
  });
  if (!screenshot.data) return null;
  return (
    <Image
      source={{ uri: screenshot.data }}
      style={[
        styles.screenshot,
        { aspectRatio: props.width / Math.max(1, props.height) },
      ]}
      resizeMode="contain"
      accessibilityLabel={t(m.screenshot)}
    />
  );
}

function CardDetails(props: { readonly card: Card; readonly roomId: string }) {
  const { t } = useTranslation();
  const { card } = props;
  if (card.room_creation)
    return <RoomCreationDetails card={card} roomId={props.roomId} />;
  if (card.computer_permission) {
    const view = card.computer_permission;
    return (
      <>
        <Text style={type.label}>
          {view.permissions
            .map((permission) =>
              permission === "accessibility"
                ? t(m.permissionAccessibility)
                : t(m.permissionScreenRecording),
            )
            .join(t(m.listSeparator))}
        </Text>
        {view.reason ? <Text style={type.small}>{view.reason}</Text> : null}
      </>
    );
  }
  if (card.runtime_permission) {
    const view = card.runtime_permission;
    return (
      <>
        <Text style={type.label}>{view.title}</Text>
        <Text style={type.body}>{view.rationale}</Text>
        {view.page ? (
          <Detail
            label={t(m.page)}
            value={
              view.page.title
                ? `${view.page.title}\n${view.page.url}`
                : view.page.url
            }
          />
        ) : null}
        {view.screenshot ? (
          <Screenshot
            decisionId={card.decision_id}
            width={view.screenshot.width}
            height={view.screenshot.height}
          />
        ) : null}
        <Detail
          label={view.kind === "code" ? t(m.command) : t(m.action)}
          value={view.input}
          mono
        />
        {view.script ? (
          <Detail
            label={t(m.script, { path: view.script.path })}
            value={view.script.body}
            mono
          />
        ) : null}
        <Detail label={t(m.fileChanges)} value={view.patch} mono />
        <Detail label={t(m.tool)} value={view.tool} mono />
      </>
    );
  }
  if (card.connector_write) {
    const view = card.connector_write;
    const message = view.message;
    return (
      <>
        <Text style={type.label}>{view.title}</Text>
        <Detail
          label={t(m.appAndAccount)}
          value={`${view.app} · ${view.account}`}
        />
        {message ? (
          <>
            <Detail
              label={t(m.to)}
              value={
                [...(message.to ?? []), ...(message.cc ?? [])].join(", ") ||
                message.destination
              }
            />
            <Detail label={t(m.subject)} value={message.subject} />
            <Detail label={t(m.message)} value={message.body} />
          </>
        ) : null}
        {(view.fields ?? []).map((field) => (
          <Detail key={field.label} label={field.label} value={field.value} />
        ))}
        <Detail label={t(m.fullRequest)} value={view.input} mono />
      </>
    );
  }
  if (card.agent_change) {
    const view = card.agent_change;
    return (
      <>
        <Text style={type.label}>
          {view.action === "create"
            ? t(m.createAgent, { name: view.agent_name })
            : t(m.changeAgent, { name: view.agent_name })}
        </Text>
        {view.changes.map((change) => (
          <Detail
            key={change.field}
            label={
              change.field === "prompt"
                ? t(m.fieldInstructions)
                : change.field === "name"
                  ? t(m.fieldName)
                  : t(m.fieldDescription)
            }
            value={
              change.before !== undefined
                ? `${change.before}\n→ ${change.after}`
                : change.after
            }
          />
        ))}
      </>
    );
  }
  return null;
}

/** Text TeamHub adds for the Agent, not part of what the Human reads. */
const TASK_OUTPUT_REQUIREMENTS = "[Task output requirements v1]";

/**
 * The Room an Agent asked to create, as TeamHub froze it: its name, members
 * and first message, with the files and documents that message carries.
 */
function RoomCreationDetails(props: {
  readonly card: Card;
  readonly roomId: string;
}) {
  const { t } = useTranslation();
  const members = useRoomMembers(props.roomId).data;
  const agentNames = useAgentNames();
  const view = props.card.room_creation;
  if (!view) return null;
  const names = new Map(agentNames);
  for (const member of members ?? [])
    names.set(member.actor.id, member.actor.display_name);
  const text = view.initial_message_segments
    .flatMap((segment) =>
      segment.type === "text" &&
      segment.content.startsWith(TASK_OUTPUT_REQUIREMENTS)
        ? []
        : [segment.content],
    )
    .join("");
  const extras = view.initial_message_segments.flatMap((segment) => {
    const line = segmentLine(segment, t);
    return line ? [line] : [];
  });
  return (
    <>
      <Text style={type.label}>{t(m.newRoom, { name: view.name })}</Text>
      <Detail
        label={t(m.members)}
        value={view.member_ids
          .map((id) => names.get(id) ?? id)
          .join(t(m.listSeparator))}
      />
      <Detail label={t(m.initialTaskInput)} value={text} />
      {extras.length ? (
        <Text style={type.small}>{extras.join("\n")}</Text>
      ) : null}
    </>
  );
}

/** A first message's file, document or Skill, named on its own line. */
function segmentLine(
  segment: MessageSegment,
  t: Translate,
): string | undefined {
  switch (segment.type) {
    case "file":
      return t(m.fileSegment, { name: segment.content });
    case "document":
      return t(m.documentSegment, { name: segment.content });
    case "skill":
      return t(m.skillSegment, { name: segment.content });
    case "meeting_notes":
      return t(m.meetingSummary);
    case "artifact_tree":
      return t(m.artifactDirectory, { path: segment.root_path });
    default:
      return undefined;
  }
}

function Question(props: {
  readonly card: Card;
  readonly busy: boolean;
  readonly onSubmit: (answers: Record<string, string | string[]>) => void;
}) {
  const { t } = useTranslation();
  const questions = props.card.question?.questions ?? [];
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [written, setWritten] = useState<Record<string, string>>({});
  const answers: Record<string, string | string[]> = {};
  for (const question of questions) {
    const options = chosen[question.id] ?? [];
    const text = (written[question.id] ?? "").trim();
    if (question.input === "checkbox") {
      const all = text ? [...options, text] : options;
      if (all.length > 0) answers[question.id] = all;
    } else if (text || options[0]) {
      answers[question.id] = text || options[0] || "";
    }
  }
  const complete = questions.every(
    (question) => answers[question.id] !== undefined,
  );

  return (
    <View style={styles.questions}>
      {questions.map((question) => (
        <View key={question.id} style={styles.question}>
          {questions.length > 1 || question.prompt !== props.card.title ? (
            <Text style={type.label}>{question.prompt}</Text>
          ) : null}
          {question.options.map((option) => {
            const selected = (chosen[question.id] ?? []).includes(option.id);
            return (
              <Pressable
                key={option.id}
                accessibilityRole={
                  question.input === "checkbox" ? "checkbox" : "radio"
                }
                accessibilityState={{ checked: selected }}
                accessibilityLabel={option.label}
                onPress={() => {
                  setChosen((current) => {
                    const list = current[question.id] ?? [];
                    const next =
                      question.input === "checkbox"
                        ? selected
                          ? list.filter((id) => id !== option.id)
                          : [...list, option.id]
                        : [option.id];
                    return { ...current, [question.id]: next };
                  });
                  if (question.input === "radio")
                    setWritten((current) => ({
                      ...current,
                      [question.id]: "",
                    }));
                }}
                style={[styles.option, selected && styles.optionSelected]}
              >
                <View
                  style={[
                    styles.mark,
                    question.input === "radio" && styles.markRound,
                    selected && styles.markOn,
                  ]}
                />
                <Text style={[type.body, styles.optionLabel]}>
                  {option.label}
                </Text>
              </Pressable>
            );
          })}
          <TextInput
            style={styles.input}
            placeholder={
              question.options.length > 0
                ? t(m.writeOwnAnswer)
                : t(m.yourAnswer)
            }
            placeholderTextColor={colors.placeholder}
            value={written[question.id] ?? ""}
            onChangeText={(text) => {
              setWritten((current) => ({ ...current, [question.id]: text }));
              if (question.input === "radio" && text)
                setChosen((current) => ({ ...current, [question.id]: [] }));
            }}
            accessibilityLabel={t(m.ownAnswerTo, {
              question: question.prompt,
            })}
            multiline
          />
        </View>
      ))}
      <Button
        label={t(m.sendAnswer)}
        onPress={() => props.onSubmit(answers)}
        disabled={!complete}
        busy={props.busy}
      />
    </View>
  );
}

export function DecisionCard(props: {
  readonly card: Card;
  readonly roomId: string;
  readonly messageId: string;
  readonly myActorId: string | undefined;
}) {
  const { t } = useTranslation();
  const { card, roomId } = props;
  const decision = useDecisionAnswer(card, roomId, props.messageId);
  const workspaceAgents = useWorkspaceAgentIds();
  const pending = card.status === "pending";
  // A connection authorization stays open to its owner while the sign-in
  // runs, so it can be reopened or cancelled.
  const canAnswer =
    canDecide(card, props.myActorId, workspaceAgents) ||
    (card.kind === "connection_auth" &&
      card.status === "authorizing" &&
      card.decision_owner.id === props.myActorId);
  // A status a newer computer adds has no label here yet.
  const status = STATUS_LABELS[card.status] as UiMessage<string> | undefined;
  const view: DecisionViewProps = { card, roomId, canAnswer, decision };

  return (
    <View
      style={styles.card}
      accessibilityLabel={t(m.decision, { title: card.title })}
    >
      <View style={styles.cardHeader}>
        <ActorAvatar actor={card.requester} size={24} />
        <Text style={[type.caption, styles.asker]} numberOfLines={1}>
          {t(m.asks, { name: card.requester.display_name })}
        </Text>
        <View style={styles.status}>
          <View
            style={[
              styles.statusDot,
              { backgroundColor: dotColor(card.status) },
            ]}
          />
          <Text style={styles.statusText}>{status ? t(status) : null}</Text>
        </View>
      </View>
      <Text style={styles.cardTitle}>{card.title}</Text>
      <CardDetails card={card} roomId={roomId} />
      {card.outcome ? <Text style={type.small}>{card.outcome}</Text> : null}
      {card.answer?.comment ? (
        <Text style={type.small}>“{card.answer.comment}”</Text>
      ) : null}
      {pending && !canAnswer ? (
        <Text style={type.small}>
          {t(m.waitingFor, { name: card.decision_owner.display_name })}
        </Text>
      ) : null}
      <KindView {...view} />
      {decision.problem ? (
        <Text style={[type.small, styles.problem]} accessibilityRole="alert">
          {decision.problem}
        </Text>
      ) : null}
    </View>
  );
}

/** What a card's kind adds: its answers, or what it shows once settled. */
function KindView(props: DecisionViewProps) {
  const { card, canAnswer, decision } = props;
  switch (card.kind) {
    case "question":
      return canAnswer ? (
        <Question
          card={card}
          busy={decision.busy}
          onSubmit={(answers) =>
            void decision.answer({ decision: "submit", answers })
          }
        />
      ) : null;
    case "profile_setup_apps":
      return <ProfileSetupApps {...props} />;
    case "profile_setup_sources":
      return <ProfileSetupSources {...props} />;
    case "connection_auth":
      return <ConnectionAuth {...props} />;
    case "provider_key":
      return <ProviderKey {...props} />;
    case "search_key":
      return <SearchKey {...props} />;
    case "browser_connection":
    case "computer_permission":
      return <OnComputer {...props} />;
    case "room_creation":
    case "runtime_permission":
    case "connector_write":
    case "agent_change":
      return <Approval {...props} />;
    default:
      // A kind a newer computer adds is answered there.
      return null;
  }
}

/** The approve or deny kinds, in the words of what each approval does. */
function Approval(props: DecisionViewProps) {
  const { t } = useTranslation();
  const { card, canAnswer, decision } = props;
  const created = card.room_creation?.created_room_id;
  if (!canAnswer)
    return created ? (
      <Button
        compact
        variant="secondary"
        label={t(m.openRoom)}
        onPress={() => router.navigate(`/rooms/${created}`)}
        style={styles.openRoom}
      />
    ) : null;
  const words = approvalWords(card);
  return (
    <ApprovalActions
      approveLabel={t(words.approve)}
      denyLabel={t(words.deny)}
      reasonRequired={card.kind === "room_creation"}
      busy={decision.busy}
      onApprove={() => void decision.answer({ decision: "approve" })}
      reasonAllowed={denyTakesReason(card.kind)}
      onDeny={(reason) => void decision.answer(denyRequest(card.kind, reason))}
    />
  );
}

/** The buttons in the words of what the approval does, as the web says. */
function approvalWords(card: Card): {
  readonly approve: UiMessage<string>;
  readonly deny: UiMessage<string>;
} {
  if (card.room_creation) return { approve: m.createRoom, deny: m.dontCreate };
  if (card.agent_change?.action === "create")
    return { approve: m.create, deny: m.dontCreate };
  if (card.agent_change) return { approve: m.apply, deny: m.dontApply };
  if (card.runtime_permission)
    return { approve: m.allowOnce, deny: m.dontAllow };
  if (card.connector_write?.kind === "message")
    return { approve: m.send, deny: m.dontSend };
  return { approve: m.approve, deny: m.deny };
}

/**
 * A browser connection or a macOS permission happens in that computer's
 * Chrome or System Settings, so the phone only declines it.
 */
function OnComputer(props: DecisionViewProps) {
  const { t } = useTranslation();
  const { active } = useComputer();
  const { card, canAnswer, decision } = props;
  if (!canAnswer) return null;
  const name = active?.name || t(m.yourComputer);
  return (
    <>
      <Text style={type.small}>
        {card.kind === "browser_connection"
          ? t(m.browserOnComputer, { name })
          : t(m.permissionsOnComputer, { name })}
      </Text>
      <Button
        label={t(m.decline)}
        variant="secondary"
        onPress={() => void decision.answer({ decision: "deny" })}
        busy={decision.busy}
      />
    </>
  );
}

/** StatusPill: the state shows only in the dot, so a column of them stays calm. */
function dotColor(status: Card["status"]): string {
  if (status === "pending") return colors.accent;
  if (status === "executing") return colors.warning;
  if (status === "approved" || status === "succeeded" || status === "answered")
    return colors.success;
  if (status === "denied" || status === "failed") return colors.danger;
  return colors.muted;
}

const styles = StyleSheet.create({
  // The decision card: white, a hairline, the chat-card shadow, r12, 16 in.
  card: {
    alignSelf: "stretch",
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: space.lg,
    gap: space.md,
    ...shadow.chatCard,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  asker: { flex: 1, color: colors.secondary },
  status: {
    height: 22,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceSoft,
  },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { fontSize: 12, color: colors.secondary },
  detail: { gap: 2 },
  more: {
    ...StyleSheet.flatten(type.small),
    color: colors.link,
    paddingTop: 2,
  },
  screenshot: {
    width: "100%",
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSoft,
  },
  questions: { gap: space.lg },
  cardTitle: {
    ...StyleSheet.flatten(type.chat),
    fontWeight: "600",
    color: colors.ink,
  },
  question: { gap: space.sm },
  option: {
    minHeight: touchTarget,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  optionSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
  },
  optionLabel: { flex: 1 },
  mark: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
  },
  markRound: { borderRadius: 9 },
  markOn: { borderColor: colors.accent, backgroundColor: colors.accent },
  input: {
    ...StyleSheet.flatten(type.body),
    minHeight: touchTarget,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  openRoom: { alignSelf: "flex-start" },
  problem: { color: colors.danger },
});
