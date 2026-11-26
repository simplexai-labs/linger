// Decision cards answered on the phone with their full details: questions,
// and the approve-or-deny kinds whose whole request fits on a screen. The
// rest say to open the computer. A stale card version refetches the card.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Image, Pressable, StyleSheet, View } from "react-native";

import { decide, decisionScreenshot, getMessage } from "../api/teamhub";
import type {
  DecisionCard as Card,
  DecisionRequest,
  Message,
} from "../api/types";
import { toBase64 } from "../lib/bytes";
import { messagesKey } from "../realtime/realtime-context";
import { HttpError } from "../session/http";
import { teamHubKey, useTeamHub } from "../state/queries";
import { colors, radius, shadow, space, touchTarget, type } from "../theme";
import { ActorAvatar } from "../ui/avatar";
import { Button } from "../ui/controls";
import { replaceMessage, type MessagePages } from "./message-cache";
import { Text, TextInput } from "../ui/text";
import type { Message as UiMessage } from "../i18n/messages";
import { useTranslation } from "../i18n/use-translation";
import { chatDecisionMessages as m } from "./decision-card.messages";

/** Kinds whose details the phone shows in full and can answer. */
const PHONE_KINDS = new Set<Card["kind"]>([
  "question",
  "runtime_permission",
  "connector_write",
  "agent_change",
]);

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

function CardDetails(props: { readonly card: Card }) {
  const { t } = useTranslation();
  const { card } = props;
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
  const { card } = props;
  const teamHub = useTeamHub();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const pending = card.status === "pending";
  const mine = card.decision_owner.id === props.myActorId;
  const supported = PHONE_KINDS.has(card.kind);
  // A status a newer computer adds has no label here yet.
  const status = STATUS_LABELS[card.status] as UiMessage<string> | undefined;

  const store = (message: Message) =>
    client.setQueryData<MessagePages>(
      messagesKey(teamHub.hostId, props.roomId),
      (data) => replaceMessage(data, message),
    );

  const answer = async (request: Omit<DecisionRequest, "expected_version">) => {
    setBusy(true);
    setProblem(undefined);
    try {
      const message = await teamHub.run((session) =>
        decide(session, card.decision_id, {
          ...request,
          expected_version: card.version,
        }),
      );
      store(message);
    } catch (error) {
      if (error instanceof HttpError && error.status === 409) {
        setProblem(t(m.cardChanged));
        const fresh = await teamHub
          .run((session) => getMessage(session, props.roomId, props.messageId))
          .catch(() => undefined);
        if (fresh) store(fresh);
      } else {
        setProblem(t(m.answerNotSent));
      }
    } finally {
      setBusy(false);
    }
  };

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
      {supported ? <CardDetails card={card} /> : null}
      {card.outcome ? <Text style={type.small}>{card.outcome}</Text> : null}
      {card.answer?.comment ? (
        <Text style={type.small}>“{card.answer.comment}”</Text>
      ) : null}
      {pending && !mine ? (
        <Text style={type.small}>
          {t(m.waitingFor, { name: card.decision_owner.display_name })}
        </Text>
      ) : null}
      {pending && mine && !supported ? (
        <Text style={type.small}>{t(m.openOnComputer)}</Text>
      ) : null}
      {pending && mine && supported && card.kind === "question" ? (
        <Question
          card={card}
          busy={busy}
          onSubmit={(answers) => void answer({ decision: "submit", answers })}
        />
      ) : null}
      {pending && mine && supported && card.kind !== "question" ? (
        <View style={styles.actions}>
          <Button
            label={t(m.approve)}
            onPress={() => void answer({ decision: "approve" })}
            busy={busy}
            style={styles.action}
          />
          <Button
            label={t(m.deny)}
            variant="secondary"
            onPress={() => void answer({ decision: "deny" })}
            disabled={busy}
            style={styles.action}
          />
        </View>
      ) : null}
      {problem ? (
        <Text style={[type.small, styles.problem]} accessibilityRole="alert">
          {problem}
        </Text>
      ) : null}
    </View>
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
  actions: { flexDirection: "row", gap: space.md },
  action: { flex: 1 },
  problem: { color: colors.danger },
});
