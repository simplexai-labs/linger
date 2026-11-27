// Meeting recording from the phone. The computer records the Capture from
// the Voice Bridge as it would from a browser, and the live transcript comes
// back over the voice events stream. The phone also writes the whole meeting
// to files of its own: if the live copy has a gap (the phone was away longer
// than the Bridge holds a session, or the computer's copy failed), it sends
// those files to the Another Me chat when the meeting stops. Either way the
// files are deleted once the computer has the meeting.
import { File } from "expo-file-system";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  BackHandler,
  ScrollView,
  StyleSheet,
  View,
  type ScrollViewInstance,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  getVoiceCapture,
  startVoiceCapture,
  stopVoiceCapture,
  uploadAttachment,
} from "../api/teamhub";
import type {
  MessageAttachmentUpload,
  VoiceCapture,
  VoiceTranscriptEvent,
} from "../api/types";
import { useOutbox } from "../chat/outbox-context";
import { computerDirectory } from "../computer/store";
import { t as translate } from "../i18n/language";
import { useTranslation } from "../i18n/use-translation";
import type { PhoneSession } from "../session/session";
import { useAnotherMe, useAnotherMeName, useTeamHub } from "../state/queries";
import { colors, space, touchTarget, type } from "../theme";
import { tap, thud } from "../ui/haptics";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { Button, EmptyState } from "../ui/controls";
import {
  ensureMicrophonePermission,
  hideRecordingNotification,
  showRecordingNotification,
} from "./audio";
import { ListeningBuddy } from "./listening-buddy";
import { FRAME_MS } from "./pcm";
import { voiceRecordMessages as m } from "./record-screen.messages";
import { useSessionSource, type SessionSource } from "./use-session-source";
import { followVoiceEvents } from "./voice-events";
import {
  describeVoiceError,
  openVoiceLink,
  type VoiceLink,
} from "./voice-link";
import { Text } from "../ui/text";

type Phase =
  | "idle"
  | "starting"
  | "recording"
  | "stopping"
  | "saving"
  | "done"
  | "failed";

interface Line {
  readonly id: string;
  readonly text: string;
  readonly speaker?: string;
}

interface RecordView {
  phase(phase: Phase): void;
  startedAt(ms: number): void;
  line(line: Line): void;
  partial(text: string): void;
  level(level: number): void;
  notice(text: string | undefined): void;
  interrupted(interrupted: boolean): void;
  result(text: string): void;
  error(text: string): void;
  /** The phone still holds files the computer does not have. */
  resendable(resendable: boolean): void;
}

interface RecordRun {
  stop(): Promise<void>;
  /** The screen went away: a recording stops properly, a start is undone. */
  cancel(): void;
  /** Sends the phone's files again after an upload failed. */
  retrySend(): Promise<void>;
}

const MAX_ATTACHMENTS = 5;
const CAPTURE_START_MS = 15_000;
const POLL_MS = 3_000;
/** How long the phone waits for the computer to finish saving a meeting. */
const SAVE_WAIT_MS = 20 * 60_000;
/** How long the phone waits for the computer to accept its recording copy. */
const DELIVERY_WAIT_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fileFor(path: string): File {
  return new File(path.startsWith("file://") ? path : `file://${path}`);
}

function deleteFiles(paths: readonly string[]): void {
  for (const path of paths) {
    try {
      const file = fileFor(path);
      if (file.exists) file.delete();
    } catch {
      // Unpairing deletes the directory anyway.
    }
  }
}

function speakerLabel(event: VoiceTranscriptEvent): string | undefined {
  const match = /^spk_(\d+)$/.exec(event.speaker_id ?? "");
  return match ? translate(m.speaker, { number: match[1]! }) : undefined;
}

function terminal(capture: VoiceCapture | undefined): boolean {
  return capture?.status === "finalized" || capture?.status === "failed";
}

function startRecording(input: {
  readonly roomId: string;
  readonly hostId: string;
  readonly sessions: SessionSource;
  /** The Another Me Agent's name, for the copy. */
  readonly agentName: string;
  send(
    text: string,
    uploads: readonly MessageAttachmentUpload[],
    key: string,
  ): Promise<void>;
  /** Whether the computer accepted these messages within the time. */
  delivered(keys: readonly string[], timeoutMs: number): Promise<boolean>;
  readonly view: RecordView;
}): RecordRun {
  const { view, sessions } = input;
  const abort = new AbortController();
  const name = `meeting-${new Date().toISOString().replace(/[^0-9]/g, "")}`;
  let link: VoiceLink | undefined;
  let capture: VoiceCapture | undefined;
  let stopEvents: (() => void) | undefined;
  let recording = false;
  let cancelled = false;
  /** The Bridge gave up: the computer's copy stopped while the phone kept recording. */
  let bridgeLost = false;
  let files: string[] = [];

  const session = async (ms = 10_000): Promise<PhoneSession> => {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), ms);
    try {
      return await sessions(timeout.signal);
    } finally {
      clearTimeout(timer);
    }
  };

  const sendPhoneCopy = async () => {
    if (files.length === 0) {
      // The phone's own copy did not finish; nothing here can fill the gap.
      view.notice(undefined);
      view.error(translate(m.phoneCopyNotSaved));
      view.phase("failed");
      return;
    }
    view.notice(translate(m.sendingPhoneCopy, { name: input.agentName }));
    const uploads: MessageAttachmentUpload[] = [];
    for (const path of files) {
      const file = fileFor(path);
      const bytes = await file.bytes();
      uploads.push(
        await uploadAttachment(
          await session(),
          input.roomId,
          { name: file.name, mediaType: "audio/mp4", bytes },
          `mobile:recording:${name}:${file.name}`,
        ),
      );
    }
    // The message that carries the phone's own copy of a meeting.
    const text = translate(m.gapMessage);
    const keys: string[] = [];
    for (let index = 0; index < uploads.length; index += MAX_ATTACHMENTS) {
      const key = `mobile:recording:${name}:message:${index}`;
      keys.push(key);
      await input.send(
        text,
        uploads.slice(index, index + MAX_ATTACHMENTS),
        key,
      );
    }
    // The files go only once the computer has the messages that carry them;
    // an upload alone expires if the message never arrives.
    if (!(await input.delivered(keys, DELIVERY_WAIT_MS))) {
      view.notice(undefined);
      view.result(translate(m.onItsWay));
      view.phase("done");
      return;
    }
    deleteFiles(files);
    files = [];
    view.notice(undefined);
    view.resendable(false);
    view.result(translate(m.computerHasRecording, { name: input.agentName }));
    view.phase("done");
  };

  const trySendPhoneCopy = async () => {
    try {
      await sendPhoneCopy();
    } catch {
      view.notice(undefined);
      view.resendable(true);
      view.error(translate(m.sendFailed));
      view.phase("failed");
    }
  };

  const readCapture = async (captureId: string) =>
    getVoiceCapture(await session(), captureId);

  void (async () => {
    view.phase("starting");
    if (!(await ensureMicrophonePermission())) {
      view.phase("idle");
      return;
    }
    await showRecordingNotification();
    try {
      link = await openVoiceLink({
        purpose: "hardware_control",
        roomId: input.roomId,
        hostId: input.hostId,
        sessions,
        signal: abort.signal,
        listener: {
          connection: (state) => {
            if (recording && !bridgeLost)
              view.notice(
                state === "reconnecting"
                  ? translate(m.reconnecting)
                  : undefined,
              );
          },
          failed: () => {
            bridgeLost = true;
            if (recording) view.notice(translate(m.computerCopyStopped));
          },
        },
        microphone: {
          file: {
            directory: `${computerDirectory(input.hostId)}/recordings`,
            name,
          },
          onLevel: view.level,
          onInterruption: (state) => view.interrupted(state === "began"),
        },
      });
      view.startedAt(Date.now());
      const opened = link;
      stopEvents = followVoiceEvents({
        voiceSessionId: opened.voice.id,
        session: sessions,
        handlers: {
          page: (page) => {
            for (const item of page.items) {
              const event = item.transcript;
              if (
                event &&
                event.kind === "speech" &&
                event.lane === "live" &&
                event.voice_session_id === opened.voice.id
              )
                view.line({
                  id: event.id,
                  text: event.text,
                  speaker: speakerLabel(event),
                });
              if (item.capture && item.capture.id === capture?.id)
                capture = item.capture;
            }
          },
          partial: (page) => view.partial(page.partial_transcript ?? ""),
        },
      });
      await opened.ready;
      capture = await startVoiceCapture(
        await session(),
        opened.voice.id,
        input.roomId,
        0,
      );
      // The computer records from the moment its recorder runs; held audio
      // goes out after that, so the archive starts with the first word.
      const deadline = Date.now() + CAPTURE_START_MS;
      while (capture.status === "starting" && Date.now() < deadline) {
        await sleep(500);
        capture = await readCapture(capture.id);
      }
      if (capture.status !== "recording")
        throw new Error(`Capture ${capture.status}`);
      opened.bridge.release();
      recording = true;
      view.phase("recording");
      if (cancelled) void stop();
    } catch (error) {
      stopEvents?.();
      const opened = link;
      if (opened) {
        deleteFiles(await opened.microphone.stop().catch(() => []));
        await opened.close().catch(() => undefined);
      }
      await hideRecordingNotification();
      view.error(
        error instanceof Error && error.message.startsWith("Capture ")
          ? translate(m.couldNotStart)
          : describeVoiceError(error),
      );
      view.phase("failed");
    }
  })();

  let stopping: Promise<void> | undefined;
  function stop(): Promise<void> {
    stopping ??= (async () => {
      const opened = link;
      if (!opened || !recording) return;
      recording = false;
      view.phase("stopping");
      files = await opened.microphone.stop().catch(() => []);
      let drained = !bridgeLost;
      if (drained) {
        const backlogMs = opened.bridge.unacknowledged * FRAME_MS;
        view.notice(
          backlogMs > 2_000
            ? translate(m.sendingLastSeconds, {
                seconds: Math.ceil(backlogMs / 1_000),
              })
            : undefined,
        );
        drained = await Promise.race([
          opened.bridge.drain().then(
            () => true,
            () => false,
          ),
          sleep(backlogMs + 30_000).then(() => false),
        ]);
      }
      const captureId = capture?.id;
      try {
        if (captureId)
          capture = await stopVoiceCapture(await session(), captureId);
      } catch {
        // The Capture state is read again below.
      }
      opened.bridge.stop();
      view.notice(undefined);
      view.phase("saving");
      const gap = bridgeLost || !drained || opened.bridge.gap;
      if (gap) {
        stopEvents?.();
        await opened.close().catch(() => undefined);
        await hideRecordingNotification();
        await trySendPhoneCopy();
        return;
      }
      // Wait for the computer to finish its copy before closing the session.
      const saveDeadline = Date.now() + SAVE_WAIT_MS;
      while (captureId && !terminal(capture) && Date.now() < saveDeadline) {
        await sleep(POLL_MS);
        capture = await readCapture(captureId).catch(() => capture);
      }
      stopEvents?.();
      await opened.close().catch(() => undefined);
      await hideRecordingNotification();
      if (!terminal(capture)) {
        // The phone keeps its copy: nothing says the computer has it all.
        view.result(translate(m.stillSaving, { name: input.agentName }));
        view.phase("done");
        return;
      }
      if (capture?.status === "finalized" && capture.gap_count === 0) {
        deleteFiles(files);
        files = [];
        view.result(translate(m.saved, { name: input.agentName }));
        view.phase("done");
        return;
      }
      await trySendPhoneCopy();
    })();
    return stopping;
  }

  return {
    stop,
    cancel() {
      cancelled = true;
      if (recording) void stop();
      else abort.abort();
    },
    retrySend: async () => {
      if (files.length === 0) return;
      view.phase("saving");
      await trySendPhoneCopy();
    },
  };
}

function elapsedText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

export function RecordScreen() {
  const { t } = useTranslation();
  const teamHub = useTeamHub();
  const anotherMe = useAnotherMe();
  const agentName = useAnotherMeName() ?? "Another Me";
  const sessions = useSessionSource();
  const outbox = useOutbox();
  const roomId = anotherMe.data?.room_id;
  const [phase, setPhase] = useState<Phase>("idle");
  const [startedAt, setStartedAt] = useState<number | undefined>();
  const [now, setNow] = useState(() => Date.now());
  const [lines, setLines] = useState<readonly Line[]>([]);
  const [partial, setPartial] = useState("");
  const [level, setLevel] = useState(0);
  const [notice, setNotice] = useState<string | undefined>();
  const [interrupted, setInterrupted] = useState(false);
  const [result, setResult] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [resendable, setResendable] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const run = useRef<RecordRun | undefined>(undefined);
  const scroll = useRef<ScrollViewInstance>(null);
  const latestOutbox = useRef(outbox);
  useEffect(() => {
    latestOutbox.current = outbox;
  });

  const active = phase === "starting" || phase === "recording";
  const busy = phase === "stopping" || phase === "saving";

  useEffect(() => {
    if (!startedAt || !active) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active, startedAt]);

  const leave = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  };

  const confirmStop = () => setConfirming(true);

  // The hardware back button asks before it stops a recording.
  useEffect(() => {
    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      () => {
        if (phase === "recording") {
          confirmStop();
          return true;
        }
        // Stopping and saving go on without the screen.
        return active;
      },
    );
    return () => subscription.remove();
  });

  // A recording never ends silently: leaving the screen stops it properly.
  useEffect(
    () => () => {
      run.current?.cancel();
    },
    [],
  );

  const start = () => {
    if (!roomId || !teamHub.hostId || run.current) return;
    tap();
    setLines([]);
    setPartial("");
    setNotice(undefined);
    setError(undefined);
    setResult(undefined);
    run.current = startRecording({
      roomId,
      hostId: teamHub.hostId,
      sessions,
      agentName,
      send: (text, uploads, key) =>
        latestOutbox.current.send(roomId, text, uploads, { key }),
      delivered: (keys, ms) => latestOutbox.current.delivered(keys, ms),
      view: {
        phase: (next) => {
          setPhase(next);
          if (next === "idle") run.current = undefined;
        },
        startedAt: (ms) => {
          setStartedAt(ms);
          setNow(ms);
        },
        line: (line) =>
          setLines((current) =>
            current.some((item) => item.id === line.id)
              ? current
              : [...current, line].slice(-300),
          ),
        partial: setPartial,
        level: setLevel,
        notice: setNotice,
        interrupted: setInterrupted,
        result: setResult,
        error: setError,
        resendable: setResendable,
      },
    });
  };

  if (!roomId)
    return (
      <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
        <EmptyState
          title={
            teamHub.connected
              ? t(m.gettingReady, { name: agentName })
              : t(m.connectToRecord)
          }
          busy={teamHub.connected && anotherMe.isPending}
        />
        <Button label={t(m.close)} variant="secondary" onPress={leave} />
      </SafeAreaView>
    );

  const heading: Record<Phase, string> = {
    idle: t(m.headingIdle),
    starting: t(m.headingStarting),
    recording: interrupted ? t(m.headingPaused) : t(m.headingRecording),
    stopping: t(m.headingStopping),
    saving: t(m.headingSaving),
    done: t(m.headingDone),
    failed: t(m.headingFailed),
  };

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <View style={styles.topBar}>
        {phase === "idle" ? (
          <Button label={t(m.close)} variant="quiet" compact onPress={leave} />
        ) : null}
      </View>
      <View style={styles.header}>
        <Text style={type.headline} accessibilityRole="header">
          {heading[phase]}
        </Text>
        {startedAt && phase !== "idle" ? (
          <Text
            style={styles.elapsed}
            accessibilityLabel={t(m.recordedFor, {
              time: elapsedText(now - startedAt),
            })}
          >
            {elapsedText(now - startedAt)}
          </Text>
        ) : null}
      </View>
      {phase === "idle" ? (
        <View style={styles.intro}>
          <ListeningBuddy level={0} size={150} />
          <Text style={[type.body, styles.center]}>
            {t(m.intro, { name: agentName })}
          </Text>
        </View>
      ) : (
        <>
          <View style={styles.meter}>
            <ListeningBuddy
              level={active ? level : 0}
              sleeping={!active || interrupted}
              size={104}
            />
          </View>
          <ScrollView
            ref={scroll}
            style={styles.transcript}
            contentContainerStyle={styles.transcriptContent}
            onContentSizeChange={() =>
              scroll.current?.scrollToEnd({ animated: true })
            }
            accessibilityLabel={t(m.liveTranscript)}
          >
            {lines.length === 0 && !partial ? (
              <Text style={[type.small, styles.center]}>
                {phase === "recording" ? t(m.transcriptHint) : ""}
              </Text>
            ) : null}
            {lines.map((line) => (
              <Text key={line.id} style={type.body}>
                {line.speaker ? (
                  <Text style={styles.speaker}>{`${line.speaker}  `}</Text>
                ) : null}
                {line.text}
              </Text>
            ))}
            {partial ? (
              <Text style={[type.body, styles.partial]}>{partial}</Text>
            ) : null}
          </ScrollView>
        </>
      )}
      {notice ? (
        <Text
          style={[type.small, styles.notice]}
          accessibilityLiveRegion="polite"
        >
          {notice}
        </Text>
      ) : null}
      {result ? <Text style={[type.body, styles.center]}>{result}</Text> : null}
      {error && phase === "failed" ? (
        <Text style={[type.body, styles.error]} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      <View style={styles.controls}>
        {phase === "idle" ? (
          <Button
            label={t(m.startRecording)}
            disabled={!teamHub.connected}
            onPress={start}
            style={styles.control}
          />
        ) : phase === "starting" || phase === "recording" ? (
          <Button
            label={t(m.stop)}
            variant="danger"
            disabled={phase !== "recording"}
            onPress={confirmStop}
            style={styles.control}
          />
        ) : busy ? (
          // Stopping always saves; the screen waits for it instead of
          // offering a way out that reads as discarding the meeting.
          <Button
            label={t(m.saving)}
            variant="secondary"
            busy
            disabled
            onPress={() => undefined}
            style={styles.control}
          />
        ) : (
          <>
            {phase === "failed" && resendable ? (
              <Button
                label={t(m.sendAgain)}
                variant="secondary"
                onPress={() => void run.current?.retrySend()}
                style={styles.control}
              />
            ) : null}
            <Button label={t(m.close)} onPress={leave} style={styles.control} />
          </>
        )}
      </View>
      <ConfirmDialog
        visible={confirming}
        title={t(m.confirmStopTitle)}
        confirmLabel={t(m.stop)}
        cancelLabel={t(m.keepRecording)}
        tone="danger"
        onConfirm={() => {
          thud();
          setConfirming(false);
          void run.current?.stop();
        }}
        onCancel={() => setConfirming(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.canvas,
    paddingHorizontal: space.xl,
    paddingBottom: space.lg,
    gap: space.md,
  },
  topBar: {
    minHeight: touchTarget,
    flexDirection: "row",
    justifyContent: "flex-end",
    marginRight: -space.sm,
  },
  header: { alignItems: "center", gap: space.xs },
  elapsed: {
    fontSize: 44,
    fontWeight: "300",
    color: colors.ink,
    fontVariant: ["tabular-nums"],
  },
  intro: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: space.xl,
  },
  center: { textAlign: "center", color: colors.secondary },
  meter: { alignItems: "center" },
  transcript: { flex: 1 },
  transcriptContent: { gap: space.sm, paddingVertical: space.md },
  speaker: { color: colors.muted, fontWeight: "600" },
  partial: { color: colors.muted },
  notice: { color: colors.warning, textAlign: "center" },
  error: { color: colors.danger, textAlign: "center" },
  controls: { flexDirection: "row", gap: space.md },
  control: { flex: 1 },
});
