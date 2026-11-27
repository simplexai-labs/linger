// One message in the timeline: the Human's own words in an ink bubble on the
// right, everyone else's on paper on the left, notices centered, cards
// inline. A message that just arrived rises into place.
import { memo, useEffect, useRef, type ReactNode } from "react";
import { Animated, Easing, Pressable, StyleSheet, View } from "react-native";

import type { Message } from "../api/types";
import { colors, radius, space, type } from "../theme";
import { ActorAvatar } from "../ui/avatar";
import { Markdown } from "../ui/markdown";
import { bubbleSegments } from "./bubble-segments";
import { useTranslation } from "../i18n/use-translation";
import { openAgent } from "./agent-stage";
import { chatStageMessages } from "./agent-stage.messages";
import { chatMessageMessages as m } from "./message-row.messages";
import { DecisionCard } from "./decision-card";
import { FileCard, FileTile } from "./file-card";
import { mentionOnInkStyle, mentionStyle } from "./mention-style";
import { pendingText } from "./compose-message";
import type { OutboxEntry } from "./outbox";
import { Text } from "../ui/text";

/** The message's own words, with each @ drawn as a mention. */
function Spans(props: { readonly message: Message; readonly onInk?: boolean }) {
  const segments = bubbleSegments(props.message);
  return (
    <>
      {segments.map((segment, index) =>
        segment.type === "reference" ? (
          <Text
            key={index}
            style={props.onInk ? mentionOnInkStyle : mentionStyle}
          >
            {segment.content}
          </Text>
        ) : (
          <Text key={index}>
            {index === 0 ? segment.content.trimStart() : segment.content}
          </Text>
        ),
      )}
    </>
  );
}

/** How recent a message must be to animate in; older ones are history. */
const FRESH_MS = 20_000;

function Rise(props: {
  readonly fresh: boolean;
  readonly children: ReactNode;
}) {
  const progress = useRef(new Animated.Value(props.fresh ? 0 : 1)).current;
  useEffect(() => {
    if (!props.fresh) return;
    Animated.timing(progress, {
      toValue: 1,
      duration: 380,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [progress, props.fresh]);
  return (
    <Animated.View
      style={{
        opacity: progress,
        transform: [
          {
            translateY: progress.interpolate({
              inputRange: [0, 1],
              outputRange: [12, 0],
            }),
          },
        ],
      }}
    >
      {props.children}
    </Animated.View>
  );
}

export const MessageRow = memo(function MessageRow(props: {
  readonly message: Message;
  readonly myActorId: string | undefined;
  /** Whether the message above this one has the same author. */
  readonly continued: boolean;
  /** Names and avatars over other people's messages; off in a direct chat. */
  readonly showAuthor: boolean;
}) {
  const { t } = useTranslation();
  const { message } = props;
  if (message.message_kind === "room_notice")
    return (
      <Text style={[type.caption, styles.notice]} accessibilityRole="text">
        {message.raw_message}
      </Text>
    );
  const mine =
    message.author.kind === "human" && message.author.id === props.myActorId;
  const text = bubbleSegments(message)
    .map((segment) => segment.content)
    .join("")
    .trim();
  const fresh = Date.now() - Date.parse(message.created_at) < FRESH_MS;
  return (
    <Rise fresh={fresh}>
      <View
        style={[
          styles.row,
          mine ? styles.rowMine : styles.rowOther,
          props.continued && styles.continued,
        ]}
      >
        {!mine && !props.continued && props.showAuthor ? (
          <Pressable
            accessibilityRole={
              message.author.kind === "agent" ? "button" : undefined
            }
            accessibilityLabel={t(chatStageMessages.about, {
              name: message.author.display_name,
            })}
            disabled={message.author.kind !== "agent"}
            onPress={() => openAgent(message.author.id, message.room_id)}
            style={styles.author}
          >
            <ActorAvatar actor={message.author} size={24} />
            <Text style={[type.caption, styles.authorName]} numberOfLines={1}>
              {message.author.display_name}
            </Text>
          </Pressable>
        ) : null}
        {message.card_title ? (
          <Text style={type.label}>{message.card_title}</Text>
        ) : null}
        {text ? (
          mine ? (
            <View style={[styles.bubble, styles.bubbleMine]}>
              <Text style={[type.chat, styles.mineText]} selectable>
                <Spans message={message} onInk />
              </Text>
            </View>
          ) : message.author.kind === "agent" ? (
            <View
              style={[styles.bubble, styles.bubbleOther, styles.bubbleWide]}
            >
              <Markdown text={text} variant="chat" />
            </View>
          ) : (
            <View style={[styles.bubble, styles.bubbleOther]}>
              <Text style={type.chat} selectable>
                <Spans message={message} />
              </Text>
            </View>
          )
        ) : null}
        {message.attachments.map((attachment) => (
          <FileCard key={attachment.id} attachment={attachment} mine={mine} />
        ))}
        {message.card ? (
          <DecisionCard
            card={message.card}
            roomId={message.room_id}
            messageId={message.id}
            myActorId={props.myActorId}
          />
        ) : null}
      </View>
    </Rise>
  );
});

export function PendingRow(props: {
  readonly entry: OutboxEntry;
  readonly directAgentId: string | undefined;
  readonly onRetry: () => void;
  readonly onDiscard: () => void;
}) {
  const { t } = useTranslation();
  const { entry } = props;
  const failed = entry.state === "failed";
  const text = pendingText(entry.body, props.directAgentId);
  return (
    <View style={[styles.row, styles.rowMine]}>
      {text ? (
        <View style={[styles.bubble, styles.bubbleMine, styles.bubblePending]}>
          <Text style={[type.chat, styles.mineText]}>{text}</Text>
        </View>
      ) : null}
      {entry.attachmentNames.map((name) => (
        <View key={name} style={[styles.file, styles.fileMine]}>
          <FileTile filename={name} size={36} />
          <Text style={[type.label, styles.fileName]} numberOfLines={1}>
            {name}
          </Text>
        </View>
      ))}
      {failed ? (
        <View style={styles.failed}>
          <Text style={[type.caption, styles.failedText]}>{t(m.notSent)}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t(m.sendAgain)}
            onPress={props.onRetry}
            hitSlop={10}
          >
            <Text style={styles.failedAction}>{t(m.sendAgain)}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t(m.deleteMessage)}
            onPress={props.onDiscard}
            hitSlop={10}
          >
            <Text style={styles.failedAction}>{t(m.delete)}</Text>
          </Pressable>
        </View>
      ) : (
        <Text style={type.caption} accessibilityLiveRegion="polite">
          {t(m.sending)}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: space.lg, paddingTop: space.md, gap: space.sm },
  rowMine: { alignItems: "flex-end" },
  rowOther: { alignItems: "stretch" },
  continued: { paddingTop: space.sm },
  author: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingBottom: 2,
  },
  authorName: { color: colors.secondary, fontWeight: "500", flexShrink: 1 },
  // Bubbles share the card radius; the Human's are ink, Agents' muted 70%.
  bubble: {
    maxWidth: "84%",
    borderRadius: radius.xl,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
  },
  bubbleMine: { backgroundColor: colors.ink },
  mineText: { color: colors.onAction },
  bubbleOther: {
    alignSelf: "flex-start",
    backgroundColor: colors.agentBubble,
  },
  bubbleWide: { maxWidth: "90%" },
  bubblePending: { opacity: 0.55 },
  file: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    maxWidth: "80%",
    padding: 8,
    paddingRight: space.md,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    opacity: 0.7,
  },
  fileName: { flexShrink: 1 },
  fileMine: { alignSelf: "flex-end" },
  pressed: { opacity: 0.7 },
  notice: {
    textAlign: "center",
    paddingHorizontal: space.xl,
    paddingTop: space.lg,
  },
  failed: { flexDirection: "row", gap: space.lg, alignItems: "center" },
  failedText: { color: colors.danger },
  failedAction: {
    ...StyleSheet.flatten(type.small),
    color: colors.ink,
    fontWeight: "600",
  },
});
