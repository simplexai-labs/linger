// Live: a spoken conversation with Another Me. The phone publishes its
// microphone through the Voice Bridge, plays the live voice's reply, shows
// subtitles of both, and saves each turn as the browser does.
import { useKeepAwake } from "expo-keep-awake";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StatusBar, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import type { VoiceLiveRuntimeEvent, VoiceLiveTurnMarker } from "../api/types";
import { useOutbox } from "../chat/outbox-context";
import { t as translate } from "../i18n/language";
import type { Message } from "../i18n/messages";
import { useTranslation } from "../i18n/use-translation";
import {
  useAnotherMe,
  useAnotherMeName,
  useDirectAgent,
  useTeamHub,
} from "../state/queries";
import { colors, night, radius, space, type } from "../theme";
import { thud, tick } from "../ui/haptics";
import { PressScale } from "../ui/press-scale";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { Button, EmptyState } from "../ui/controls";
import { Icon } from "../ui/icon";
import { ensureMicrophonePermission, openSpeaker, type Speaker } from "./audio";
import { BridgeFailed } from "./bridge-client";
import { LiveFace } from "./live-face";
import { voiceLiveMessages as m } from "./live-screen.messages";
import { createLiveTurns, type LiveLine, type LiveTurns } from "./live-turns";
import { useSessionSource, type SessionSource } from "./use-session-source";
import {
  describeVoiceError,
  openVoiceLink,
  type VoiceLink,
} from "./voice-link";
import { Text } from "../ui/text";

type LiveStatus =
  | "starting"
  | "listening"
  | "reconnecting"
  | "paused"
  | "ending";

interface LiveView {
  status(status: LiveStatus): void;
  error(message: string): void;
  lines(lines: readonly LiveLine[]): void;
  partial(text: string): void;
  micLevel(level: number): void;
  replyLevel(level: number): void;
  /** Live is over; leave the screen. */
  left(): void;
}

interface LiveRun {
  end(): Promise<void>;
  setMuted(muted: boolean): void;
}

/** How long ending waits for the turns it saved to reach the computer. */
const SAVE_WAIT_MS = 10_000;

function startLive(input: {
  readonly roomId: string;
  readonly hostId: string;
  readonly sessions: SessionSource;
  /** Saves one turn through the outbox and returns its key. */
  save(
    turnId: string,
    text: string,
    marker: VoiceLiveTurnMarker | undefined,
  ): string;
  settled(keys: readonly string[], timeoutMs: number): Promise<void>;
  readonly view: LiveView;
}): LiveRun {
  const { view } = input;
  const abort = new AbortController();
  const saved: string[] = [];
  let link: VoiceLink | undefined;
  let speaker: Speaker | undefined;
  let turns: LiveTurns | undefined;
  let activity = false;
  let ready = false;
  let ending: Promise<void> | undefined;

  // Assigned below; end() waits for the start so nothing it opened leaks.
  let startup: Promise<void> = Promise.resolve();
  const end = () => {
    ending ??= (async () => {
      view.status("ending");
      abort.abort();
      await startup;
      await link?.microphone.stop().catch(() => []);
      await speaker?.close();
      // Turns still waiting are saved now, as whatever they became.
      turns?.dispose();
      await input.settled(saved, SAVE_WAIT_MS);
      await link?.close().catch(() => undefined);
    })();
    return ending;
  };
  const fail = (message: string) => {
    view.error(message);
    void end();
  };

  startup = (async () => {
    if (!(await ensureMicrophonePermission())) {
      view.left();
      return;
    }
    try {
      link = await openVoiceLink({
        purpose: "chat_live",
        roomId: input.roomId,
        hostId: input.hostId,
        sessions: input.sessions,
        signal: abort.signal,
        activity: () => activity,
        listener: {
          live: (payload) => {
            activity = true;
            turns?.receive(payload as VoiceLiveRuntimeEvent);
          },
          replyAudio: (pcm) => speaker?.play(pcm),
          connection: (state) => {
            if (ready && !ending)
              view.status(state === "connected" ? "listening" : "reconnecting");
          },
          failed: (code) => fail(describeVoiceError(new BridgeFailed(code))),
        },
        microphone: {
          onLevel: view.micLevel,
          onInterruption: (state) => {
            if (state === "began") speaker?.clear();
            if (ready && !ending)
              view.status(state === "began" ? "paused" : "listening");
          },
        },
      });
      const opened = link;
      if (abort.signal.aborted) return;
      // The audio session the microphone configured carries the reply too,
      // so the speaker opens after it.
      speaker = await openSpeaker(view.replyLevel);
      turns = createLiveTurns({
        voiceSessionId: opened.voice.id,
        send: (event) => opened.bridge.sendLive({ ...event }),
        save: (turnId, text, marker) => {
          saved.push(input.save(turnId, text, marker));
        },
        onTranscript: view.lines,
        onPartial: view.partial,
        interrupt: () => speaker?.clear(),
        end: () => void end().then(view.left),
        failed: (code) => fail(translate(m.liveStopped, { code })),
      });
      if (ending) return;
      await opened.ready;
      opened.bridge.release();
      ready = true;
      if (!ending) view.status("listening");
    } catch (error) {
      if (!abort.signal.aborted) fail(describeVoiceError(error));
    }
  })();

  return { end, setMuted: (muted) => link?.microphone.setMuted(muted) };
}

const statusText: Record<LiveStatus, Message<string>> = {
  starting: m.starting,
  listening: m.listening,
  reconnecting: m.reconnecting,
  paused: m.paused,
  ending: m.ending,
};

export function LiveScreen(props: {
  readonly roomId?: string;
  /** Opened by the app itself; otherwise the Human confirms first. */
  readonly autoStart?: boolean;
}) {
  useKeepAwake();
  const { t } = useTranslation();
  const teamHub = useTeamHub();
  const anotherMe = useAnotherMe();
  const anotherMeName = useAnotherMeName();
  const sessions = useSessionSource();
  const outbox = useOutbox();
  const roomId = props.roomId ?? anotherMe.data?.room_id;
  // Live talks with the Agent of a direct chat; a group's Live is Another Me.
  const roomAgent = useDirectAgent(roomId);
  const agentName = roomAgent?.display_name ?? anotherMeName;
  const agentId = roomAgent?.id ?? anotherMe.data?.agent_actor_id;
  const hostId = teamHub.hostId;
  const [status, setStatus] = useState<LiveStatus>("starting");
  const [error, setError] = useState<string | undefined>();
  const [lines, setLines] = useState<readonly LiveLine[]>([]);
  const [partial, setPartial] = useState("");
  const [micLevel, setMicLevel] = useState(0);
  const [replyLevel, setReplyLevel] = useState(0);
  const [muted, setMuted] = useState(false);
  const run = useRef<LiveRun | undefined>(undefined);
  const left = useRef(false);
  const latestOutbox = useRef(outbox);
  useEffect(() => {
    latestOutbox.current = outbox;
  });

  const leave = () => {
    if (left.current) return;
    left.current = true;
    if (router.canGoBack()) router.back();
    else router.replace("/");
  };

  const [confirmed, setConfirmed] = useState(!!props.autoStart);
  useEffect(() => {
    if (!roomId || !hostId || !confirmed) return;
    const current = startLive({
      roomId,
      hostId,
      sessions,
      save: (turnId, text, marker) => {
        const key = `voice-mode:${turnId}`;
        void latestOutbox.current
          .send(roomId, text, [], { key, voiceLiveTurn: marker })
          .catch(() => undefined);
        return key;
      },
      settled: (keys, ms) => latestOutbox.current.settled(keys, ms),
      view: {
        status: setStatus,
        error: setError,
        lines: setLines,
        partial: setPartial,
        micLevel: setMicLevel,
        replyLevel: setReplyLevel,
        left: () => {
          if (left.current) return;
          left.current = true;
          if (router.canGoBack()) router.back();
          else router.replace("/");
        },
      },
    });
    run.current = current;
    return () => {
      run.current = undefined;
      void current.end();
    };
  }, [confirmed, hostId, roomId, sessions]);

  const lastYou = [...lines].reverse().find((line) => line.speaker === "you");
  const lastLive = [...lines].reverse().find((line) => line.speaker === "live");
  const youText = partial || lastYou?.text || "";
  // Subtitles read in the order they were said: the Human's words go below
  // the reply only while they are newer than it.
  const youNewer =
    !!partial ||
    (lastYou !== undefined &&
      (lastLive === undefined ||
        lines.indexOf(lastYou) > lines.indexOf(lastLive)));

  const youBubble = (
    <View
      style={styles.youBubble}
      accessibilityLabel={t(m.you, { text: youText })}
    >
      <Text
        style={[styles.you, partial ? styles.youPartial : null]}
        numberOfLines={3}
      >
        {youText}
      </Text>
    </View>
  );

  if (!roomId)
    return (
      <SafeAreaView style={styles.waiting} edges={["top", "bottom"]}>
        <EmptyState
          title={
            teamHub.connected
              ? t(m.gettingReady, { name: anotherMeName ?? "Another Me" })
              : t(m.waitingForComputer)
          }
          busy={teamHub.connected && anotherMe.isPending}
        />
        <Button label={t(m.close)} variant="secondary" onPress={leave} />
      </SafeAreaView>
    );

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <StatusBar barStyle="light-content" />
      <ConfirmDialog
        visible={!confirmed}
        title={t(m.confirmTitle, { name: agentName ?? "Another Me" })}
        body={t(m.confirmBody)}
        confirmLabel={t(m.start)}
        onConfirm={() => setConfirmed(true)}
        onCancel={leave}
      />
      <View style={styles.header}>
        <Text style={styles.headerTitle} accessibilityRole="header">
          {agentName ?? t(m.live)}
        </Text>
        <Text style={styles.headerStatus} accessibilityLiveRegion="polite">
          {error
            ? t(m.stopped)
            : muted && status === "listening"
              ? t(m.muted)
              : t(statusText[status])}
        </Text>
      </View>
      <View style={styles.stage}>
        <LiveFace
          agentId={agentId}
          level={Math.max(muted ? 0 : micLevel, replyLevel)}
          replying={replyLevel > 0.02}
          dimmed={status !== "listening" || !!error}
        />
      </View>
      {/* The Agent speaks in large type on the left under its name; the
          Human's words sit in a quiet bubble on the right, as in the chat. */}
      <View style={styles.subtitles} accessibilityLiveRegion="polite">
        {youText && !youNewer ? youBubble : null}
        {lastLive ? (
          <View style={styles.replyBlock}>
            <Text style={styles.replyName}>{agentName ?? t(m.live)}</Text>
            <Text style={styles.reply} numberOfLines={6}>
              {lastLive.text}
            </Text>
          </View>
        ) : null}
        {youText && youNewer ? youBubble : null}
        {error ? (
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
      </View>
      <View style={styles.controls}>
        {error ? null : (
          <PressScale
            accessibilityRole="button"
            accessibilityLabel={muted ? t(m.unmute) : t(m.mute)}
            disabled={status === "ending"}
            onPress={() => {
              const next = !muted;
              tick();
              setMuted(next);
              run.current?.setMuted(next);
            }}
            scale={0.94}
            style={[styles.round, muted && styles.roundOn]}
          >
            <Icon
              name={muted ? "micOff" : "mic"}
              size={24}
              color={muted ? night.canvas : night.ink}
            />
          </PressScale>
        )}
        <PressScale
          accessibilityRole="button"
          accessibilityLabel={error ? t(m.close) : t(m.end)}
          accessibilityState={{ busy: status === "ending" && !error }}
          onPress={() => {
            const current = run.current;
            if (!current) {
              leave();
              return;
            }
            thud();
            void current.end().then(leave);
          }}
          scale={0.94}
          style={[styles.round, !error && styles.roundEnd]}
        >
          {status === "ending" && !error ? (
            <ActivityIndicator color={night.ink} />
          ) : (
            <Icon name="close" size={24} color={night.ink} />
          )}
        </PressScale>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: night.canvas,
    paddingHorizontal: space.xl,
    paddingBottom: space.lg,
  },
  waiting: {
    flex: 1,
    backgroundColor: colors.canvas,
    paddingHorizontal: space.xl,
    paddingBottom: space.lg,
  },
  header: { alignItems: "center", paddingTop: space.lg, gap: space.xs },
  headerTitle: { ...type.headline, color: night.ink },
  headerStatus: { ...type.small, color: night.muted },
  stage: { flex: 1, alignItems: "center", justifyContent: "center" },
  subtitles: { minHeight: 160, gap: space.lg, paddingBottom: space.xl },
  replyBlock: { gap: space.xs },
  replyName: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
    color: colors.brand,
  },
  reply: { fontSize: 21, lineHeight: 29, color: night.ink },
  youBubble: {
    alignSelf: "flex-end",
    maxWidth: "85%",
    borderRadius: radius.xxl,
    borderBottomRightRadius: radius.sm,
    paddingHorizontal: space.md + 2,
    paddingVertical: space.sm,
    backgroundColor: night.fill,
  },
  you: { fontSize: 15, lineHeight: 22, color: night.body },
  youPartial: { color: night.faint },
  error: { fontSize: 15, color: night.danger, textAlign: "center" },
  controls: { flexDirection: "row", gap: space.xl, justifyContent: "center" },
  round: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: night.fill,
    alignItems: "center",
    justifyContent: "center",
  },
  roundOn: { backgroundColor: night.ink },
  roundEnd: { backgroundColor: colors.danger },
});
