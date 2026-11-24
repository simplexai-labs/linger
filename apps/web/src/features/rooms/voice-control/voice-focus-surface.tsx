import {
  AlertCircleIcon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  Loading03Icon,
  Mic01Icon,
  PauseIcon,
  PictureInPictureExitIcon,
  PictureInPictureOnIcon,
  PlayIcon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { commonMessages } from "@/i18n/common.messages";
import type { Translate } from "@/i18n/language";
import type { Message } from "@/i18n/messages";
import { useT } from "@/i18n/use-translation";
import {
  isTranscriptRecoveryPaused,
  useOptionalVoiceControl,
  type VoiceCaptureState,
  type VoiceTranscriptItem,
} from "./voice-control-context";
import { VoiceRecoveryPanel } from "./voice-recovery-panel";
import { VoiceRecordingTime } from "./voice-recording-time";
import { VoiceTranscriptViewport } from "./voice-transcript-viewport";
import styles from "./voice-focus.module.css";
import {
  armSubtitle,
  armTitle,
  useMicrophonePermission,
  useSurfaceAction,
  useVoiceArming,
} from "./voice-focus-state";
import { recordingMessages as m } from "./recording.messages";

export type RecordingView = "transcript" | "ask";

/** What a running recording adds beyond its transcript. */
export interface RecordingPanels {
  ask: ReactNode;
  askComposer: ReactNode;
}

/**
 * The Recording window: one row with the live duration and controls, then
 * the full-height transcript or the conversation with the recording's Agent
 * in Ask, with the Ask box always at the bottom. Minimizing leaves only
 * the row. It lives above the routes, so minimizing it or leaving the page
 * never stops the recording; only Stop does.
 */
export function VoiceFocusSurface({
  autoStart = false,
  fill = false,
  floating = "page",
  onExit,
  onFloat,
  onMoveStart,
  onReturn,
  onViewChange,
  panels,
  view,
}: {
  autoStart?: boolean;
  /** The in-page window has a height of its own, which the surface fills
   *  instead of growing with its transcript. */
  fill?: boolean;
  /** A picture-in-picture window fills its own window instead of floating. */
  floating?: "page" | "pip";
  onExit: () => void;
  /** Returns the page window to the always-on-top window. */
  onFloat?: () => void;
  /** Starts moving the in-page window from its title bar. */
  onMoveStart?: (event: PointerEvent<HTMLDivElement>) => void;
  /** Brings the always-on-top window back into the page. */
  onReturn?: () => void;
  onViewChange?: (view: RecordingView | undefined) => void;
  /** Present once a recording runs; before that only the transcript shows. */
  panels?: RecordingPanels;
  /** The open view; undefined minimizes the window to its top row. */
  view?: RecordingView;
}) {
  const t = useT();
  const livekit = useOptionalVoiceControl();
  const voice = livekit;
  const { actionError, actionPending, run } = useSurfaceAction();
  const captureStatus = livekit?.captureState.status ?? "idle";
  const capture =
    livekit && "capture" in livekit.captureState
      ? livekit.captureState.capture
      : undefined;
  const {
    arm,
    autoArming,
    error: armError,
    reconnect,
    status: armStatus,
    supersede: supersedeArming,
  } = useVoiceArming({ autoStart, captureStatus, voice });
  const microphonePermission = useMicrophonePermission();
  // Pausing mutes the microphone and stops the clock; the recording itself
  // keeps running, so resuming continues the same Capture.
  const [pause, setPause] = useState<{
    captureId?: string;
    pausedAt?: number;
    pausedMs: number;
  }>({ pausedMs: 0 });
  const pauseState = pause.captureId === capture?.id ? pause : { pausedMs: 0 };
  const paused = pauseState.pausedAt !== undefined;
  const [confirmingStop, setConfirmingStop] = useState(false);
  // Keep recording and Escape hand focus back to Stop once it is shown again.
  const stopButton = useRef<HTMLButtonElement>(null);
  const focusStopAfterConfirm = useRef(false);
  useEffect(() => {
    if (confirmingStop || !focusStopAfterConfirm.current) return;
    focusStopAfterConfirm.current = false;
    stopButton.current?.focus();
  }, [confirmingStop]);
  // "Reconnecting microphone" only follows a microphone that was up during
  // this recording; connecting it right after Start is not a reconnection.
  const microphoneWasUp = useMicrophoneUpDuringRecording(
    capture?.id,
    livekit?.listenerStatus === "listening" ||
      livekit?.listenerStatus === "transcribing",
  );

  if (!voice) return null;
  const captureActive =
    captureStatus === "recording" || captureStatus === "starting";
  const finalizing = captureStatus === "finalizing";
  const idle = captureStatus === "idle" || captureStatus === "completed";
  const captureFailed = captureStatus === "failed";
  const standby = voice.listenerStatus === "standby";
  const recoveryFailed = isTranscriptRecoveryPaused(voice.captureState);
  const stopFailed = Boolean(voice.retryStop);
  const failedState =
    livekit?.captureState.status === "failed"
      ? livekit.captureState
      : undefined;
  const captureError = failedState
    ? captureFailureDescription(failedState.reason, t)
    : undefined;
  const inputInterrupted =
    captureActive &&
    ["device_disconnected", "error", "disabled"].includes(voice.listenerStatus);
  const inputReconnecting =
    Boolean(livekit) &&
    captureActive &&
    microphoneWasUp &&
    voice.listenerStatus === "enabling";
  const transcriptIncomplete =
    captureActive && capture?.last_failure_code === "transcript_incomplete";
  // A Capture stays "starting" until the recorder confirms its first audio. A
  // failure code on it means Start failed and TeamHub is retrying, so the
  // transcript is all that is being kept.
  const audioNotSaved =
    captureStatus === "starting" && Boolean(capture?.last_failure_code);
  // Starting connects on demand, so an unbound or blocked microphone still
  // needs the affordance; a bound-but-idle listener and an imminent
  // auto-start do not offer it twice.
  const connected =
    voice.listenerStatus === "listening" ||
    voice.listenerStatus === "transcribing";
  const canStart =
    !captureActive &&
    !finalizing &&
    !standby &&
    armStatus !== "arming" &&
    !autoArming &&
    (idle ||
      captureFailed ||
      recoveryFailed ||
      connected ||
      armStatus === "blocked" ||
      !voice.boundDevice);
  const visibleItems = idle ? [] : voice.transcriptItems;
  const partial = idle || captureError ? undefined : voice.partialTranscript;
  const titleMessage = stopFailed
    ? m.titleStopFailed
    : recoveryFailed
      ? m.titleRecoveryPaused
      : inputInterrupted
        ? m.titleInputInterrupted
        : standby
          ? m.titleOtherTab
          : idle
            ? armTitle(armStatus)
            : focusTitle(captureStatus);
  const title = t(titleMessage);
  const subtitleMessage = stopFailed
    ? undefined
    : recoveryFailed
      ? m.subtitleRecoveryPaused
      : inputInterrupted
        ? m.subtitleInputInterrupted
        : idle
          ? armSubtitle(armStatus, microphonePermission)
          : focusSubtitle(captureStatus);
  const subtitle = subtitleMessage && t(subtitleMessage);
  const statusMessage =
    !captureError &&
    !stopFailed &&
    (inputReconnecting
      ? t(m.statusReconnectingMicrophone)
      : livekit?.transcriptStatus === "recovering"
        ? t(m.statusReconnectingTranscript)
        : livekit?.captureSyncStatus === "recovering"
          ? t(m.statusReconnectingRecording)
          : audioNotSaved
            ? t(m.statusAudioNotSaved)
            : paused && captureActive
              ? t(m.statusMicrophoneMuted)
              : transcriptIncomplete
                ? inputInterrupted
                  ? t(m.statusUnconfirmedAfterStop)
                  : t(m.statusUnconfirmed)
                : finalizing
                  ? t(m.statusGeneratingFiles)
                  : undefined);
  const surfaceError =
    (stopFailed ? t(m.stopFailed) : undefined) ??
    actionError ??
    armError ??
    captureError ??
    (autoArming || armStatus === "arming" ? undefined : voice.listenerError);
  // "Listening…" claims speech is being transcribed right now; a muted,
  // disconnected or failing microphone or transcript says none is available.
  const listeningForSpeech =
    captureActive &&
    connected &&
    !paused &&
    !transcriptIncomplete &&
    !surfaceError;
  // Stop ends the recording and releases the microphone; saving continues in
  // the background while the window shows its progress.
  const leave = async () => {
    supersedeArming();
    if (livekit?.leavePage) {
      await livekit.leavePage();
    } else if (captureActive) {
      await livekit?.stopCapture();
    }
    onExit();
  };
  const standbyOrMic = standby || voice.composerMicrophoneActive;
  // Before a recording runs, the window always shows how to start it.
  const shown: RecordingView | undefined = panels ? view : "transcript";
  const pip = floating === "pip";
  // A minimized window is one row tall, in the page or floating, and a page
  // window can sit at the bottom of the viewport; Stop asks inside that row,
  // in place of Pause and Stop.
  const confirmInRow = confirmingStop && !shown;
  // The listening title is the quiet default; anything else is news.
  const notice =
    captureActive && titleMessage !== m.titleListening ? title : undefined;
  const tabs: { id: RecordingView; label: string }[] = [
    { id: "transcript", label: t(m.transcriptTab) },
    { id: "ask", label: t(m.askTab) },
  ];
  const togglePause = () =>
    run(async () => {
      if (paused) {
        await voice.setMicrophoneMuted(false);
        setPause({
          captureId: capture?.id,
          pausedMs:
            pauseState.pausedMs + Date.now() - (pauseState.pausedAt ?? 0),
        });
      } else {
        await voice.setMicrophoneMuted(true);
        setPause({
          captureId: capture?.id,
          pausedAt: Date.now(),
          pausedMs: pauseState.pausedMs,
        });
      }
    });
  // Closing a running recording asks first; it ends and saves the recording.
  // Confirmation never changes the recording view.
  const close = () => {
    if (!captureActive) {
      void run(leave);
      return;
    }
    setConfirmingStop(true);
  };
  const keepRecording = () => {
    focusStopAfterConfirm.current = true;
    setConfirmingStop(false);
  };
  const timer = (
    <span className="flex shrink-0 items-center gap-2">
      <span aria-hidden="true" className={styles.liveBars}>
        <i />
        <i />
        <i />
        <i />
      </span>
      <span
        aria-label={t(m.duration)}
        className={`flex shrink-0 items-center gap-2 font-mono text-sm leading-5 tracking-normal tabular-nums ${paused ? "text-app-subtle" : "text-app-ink"}`}
      >
        <span className="sr-only">
          {t(paused ? m.recordingPaused : m.recording)}
        </span>
        <VoiceRecordingTime
          pausedAt={pauseState.pausedAt}
          pausedMs={pauseState.pausedMs}
          startedAt={capture?.created_at}
        />
      </span>
    </span>
  );
  const confirmation = (
    // Escape keeps recording, like the alertdialog's safe button.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape answers this alertdialog; its choices are buttons
    <div
      aria-describedby="recording-stop-description"
      aria-labelledby="recording-stop-title"
      aria-modal="true"
      className={
        confirmInRow ? "order-first flex min-w-0 max-w-full" : styles.confirm
      }
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        keepRecording();
      }}
      role="alertdialog"
    >
      <h2
        className={confirmInRow ? "sr-only" : styles.confirmTitle}
        id="recording-stop-title"
      >
        {t(m.confirmStopTitle)}
      </h2>
      <p
        className={confirmInRow ? "sr-only" : styles.confirmDescription}
        id="recording-stop-description"
      >
        {t(m.confirmStopBody)}
      </p>
      <div
        className={confirmInRow ? "flex min-w-0 gap-2" : "flex flex-col gap-2"}
      >
        <button
          className={`${styles.confirmStop} ${confirmInRow ? styles.confirmInRow : ""}`}
          onClick={() => {
            // A failed stop shows its reason in the window behind.
            setConfirmingStop(false);
            void run(leave);
          }}
          type="button"
        >
          <Icon icon={StopIcon} size={12} />
          <span className="truncate">{t(m.stopAndSave)}</span>
        </button>
        <button
          // eslint-disable-next-line jsx-a11y/no-autofocus -- the safe choice is focused on purpose because the user just asked to stop recording
          autoFocus
          className={`${styles.confirmKeep} ${confirmInRow ? styles.confirmInRow : ""}`}
          onClick={keepRecording}
          type="button"
        >
          <span className="truncate">{t(m.keepRecording)}</span>
        </button>
      </div>
    </div>
  );
  const titleBar = (
    <div
      className={`${styles.titleBar} ${pip ? "bg-app-canvas" : "voice-window-title rounded-t-2xl"}`}
      onPointerDown={pip ? undefined : onMoveStart}
    >
      {panels ? (
        <button
          aria-label={t(shown ? m.minimize : m.open)}
          className={styles.windowButton}
          disabled={confirmingStop}
          onClick={() => onViewChange?.(shown ? undefined : "transcript")}
          title={t(shown ? m.minimizeHint : m.open)}
          type="button"
        >
          {shown ? (
            <Icon icon={ArrowDown01Icon} />
          ) : (
            <Icon icon={ArrowUp01Icon} />
          )}
        </button>
      ) : null}
      <span className="flex-1">{pip ? null : t(m.meeting)}</span>
      {onFloat ? (
        <button
          aria-label={t(m.float)}
          className={styles.windowButton}
          disabled={confirmingStop}
          onClick={onFloat}
          title={t(m.floatHint)}
          type="button"
        >
          <Icon icon={PictureInPictureOnIcon} />
        </button>
      ) : null}
      {onReturn ? (
        <button
          aria-label={t(m.returnToLinger)}
          className={styles.windowButton}
          onClick={onReturn}
          title={t(m.returnHint)}
          type="button"
        >
          <Icon icon={PictureInPictureExitIcon} />
        </button>
      ) : null}
    </div>
  );
  return (
    <>
      {titleBar}
      <section
        aria-label={t(m.surface)}
        className={
          pip
            ? "relative flex min-h-0 flex-1 flex-col bg-app-canvas text-app-ink"
            : `relative flex min-h-0 flex-col overflow-hidden rounded-b-2xl bg-app-canvas text-app-ink ${styles.window} ${
                fill ? "flex-1" : "max-h-[min(720px,calc(100dvh-132px))]"
              }`
        }
        data-paused={paused || undefined}
      >
        {/* A window narrower than its controls keeps their icons and drops
          the words, which stay as each control's name. */}
        <header className="@container flex h-14 shrink-0 items-center gap-2 px-4">
          {captureActive && !notice ? (
            <h1 className="sr-only">{title}</h1>
          ) : null}
          {confirmInRow ? (
            // The question takes the place of Pause and Stop. The timer stays
            // beside it while both fit; otherwise it wraps onto a second line
            // that the row clips, so no label in any language covers it.
            <div className="-m-0.5 flex h-9 min-w-0 flex-1 flex-row-reverse flex-wrap content-start items-center justify-between gap-2 overflow-hidden p-0.5">
              {captureActive ? timer : null}
              {confirmation}
            </div>
          ) : (
            <>
              {captureActive ? (
                timer
              ) : (
                <h1
                  className="min-w-0 truncate text-sm leading-5 font-medium text-app-ink"
                  title={title}
                >
                  {title}
                </h1>
              )}
              <span className="flex-1" />
              {captureActive ? (
                <button
                  aria-label={t(paused ? m.resumeRecording : m.pauseRecording)}
                  aria-pressed={paused}
                  className={styles.control}
                  data-active={paused || undefined}
                  disabled={standbyOrMic || actionPending}
                  onClick={() => void togglePause()}
                  title={t(paused ? m.resumeRecording : m.pauseRecording)}
                  type="button"
                >
                  {paused ? (
                    <Icon icon={PlayIcon} size={14} />
                  ) : (
                    <Icon icon={PauseIcon} size={14} />
                  )}
                  <span className="@max-[255px]:sr-only">
                    {t(paused ? m.resume : m.pause)}
                  </span>
                </button>
              ) : null}
              <button
                aria-label={t(
                  captureActive ? m.stopRecording : m.closeRecording,
                )}
                className={styles.control}
                // Only Close closes the window by voice; Stop ends the recording
                // and asks first, as its English name never closed it.
                data-voice-close={captureActive ? undefined : ""}
                disabled={actionPending}
                onClick={close}
                ref={stopButton}
                title={t(captureActive ? m.stopRecording : m.closeRecording)}
                type="button"
              >
                {captureActive ? (
                  <Icon icon={StopIcon} size={14} />
                ) : (
                  <Icon icon={Cancel01Icon} size={14} />
                )}
                <span className="@max-[255px]:sr-only">
                  {t(captureActive ? m.stop : commonMessages.close)}
                </span>
              </button>
            </>
          )}
        </header>
        {confirmingStop && !confirmInRow ? (
          <div
            className={`${styles.confirmLayer} ${pip ? "overflow-y-auto" : ""}`}
          >
            {confirmation}
          </div>
        ) : null}
        {shown ? (
          <>
            {panels ? (
              <div
                aria-label={t(m.views)}
                className="flex shrink-0 items-center gap-1 border-b border-app-border px-4 py-2"
                role="tablist"
              >
                {tabs.map((tab) => (
                  <button
                    aria-selected={shown === tab.id}
                    className={`inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] leading-[18px] font-medium transition-colors focus:outline-none focus-visible:shadow-[0_0_0_2px_var(--app-ring)] ${
                      shown === tab.id
                        ? "bg-app-surface-soft text-app-ink"
                        : "text-app-muted hover:bg-app-surface-soft/50 hover:text-app-ink"
                    }`}
                    key={tab.id}
                    onClick={() => onViewChange?.(tab.id)}
                    role="tab"
                    type="button"
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            ) : null}
            <VoiceFocusNotices
              gapCount={capture?.gap_count ?? 0}
              gapDurationMs={capture?.gap_duration_ms ?? 0}
              finalizing={finalizing}
              notice={notice}
              onReconnect={
                Boolean(livekit) && captureActive && inputInterrupted
                  ? () => void run(reconnect)
                  : undefined
              }
              onRetryStop={
                voice.retryStop
                  ? () =>
                      void run(() => voice.retryStop?.() ?? Promise.resolve())
                  : undefined
              }
              reconnecting={actionPending}
              statusMessage={statusMessage}
              subtitle={subtitle}
              surfaceError={surfaceError}
            />
            {/* Kept mounted behind the other views so its scroll position survives. */}
            <div
              className="flex min-h-0 flex-1 flex-col"
              hidden={shown !== "transcript"}
            >
              <VoiceTranscriptViewport
                revealLatestKey={
                  captureStatus === "recovering" && capture
                    ? `${capture.id}:${recoveryFailed ? "failed" : "recovering"}`
                    : undefined
                }
                key={capture?.id ?? "idle"}
              >
                <div className="flex w-full flex-col items-center gap-4 px-5 py-3">
                  <div
                    aria-label={t(m.transcript)}
                    aria-live="polite"
                    className="w-full space-y-1"
                    role="log"
                  >
                    {visibleItems.map((item) => (
                      <VoiceFocusTranscriptRow item={item} key={item.id} />
                    ))}
                    {partial ? (
                      <div className="flex gap-2 rounded-lg px-2.5 py-1.5 text-sm leading-5 text-app-muted">
                        <Icon
                          icon={Loading03Icon}
                          className="mt-[3px] shrink-0 animate-spin text-app-muted"
                          size={14}
                        />
                        <span className="min-w-0 italic">{partial}</span>
                      </div>
                    ) : null}
                    {visibleItems.length === 0 && !partial ? (
                      <p className="py-3 text-center text-[12px] leading-[18px] text-app-muted">
                        {t(
                          idle
                            ? m.transcriptPlaceholder
                            : listeningForSpeech
                              ? m.listening
                              : m.noTranscript,
                        )}
                      </p>
                    ) : null}
                    {canStart ? (
                      <div className="flex justify-center pt-1">
                        <Button onClick={() => void arm()} tone="primary">
                          <Icon icon={Mic01Icon} size={16} />
                          {t(
                            captureFailed || recoveryFailed
                              ? m.startNewRecording
                              : m.startRecording,
                          )}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                  {captureStatus === "recovering" && capture ? (
                    <VoiceRecoveryPanel capture={capture} />
                  ) : null}
                </div>
              </VoiceTranscriptViewport>
            </div>
            {panels && shown === "ask" ? panels.ask : null}
            {panels?.askComposer}
          </>
        ) : null}
      </section>
    </>
  );
}

function VoiceFocusNotices({
  finalizing,
  gapCount,
  gapDurationMs,
  notice,
  onReconnect,
  onRetryStop,
  reconnecting,
  statusMessage,
  subtitle,
  surfaceError,
}: {
  finalizing: boolean;
  gapCount: number;
  gapDurationMs: number;
  notice?: string;
  onReconnect?: () => void;
  onRetryStop?: () => void;
  reconnecting: boolean;
  statusMessage: string | false | undefined;
  subtitle?: string;
  surfaceError?: string;
}) {
  const t = useT();
  if (
    !notice &&
    !subtitle &&
    !statusMessage &&
    !surfaceError &&
    gapCount === 0 &&
    !onReconnect
  )
    return null;
  return (
    // A Town notice: a quiet muted panel with 12px muted text; only the
    // icons carry the warning or danger colour.
    <div className="mx-4 mt-2 flex shrink-0 flex-col gap-1 rounded-lg border border-app-border bg-app-surface-soft/40 px-3 py-2 text-[12px] leading-[18px] font-normal tracking-[0.02em] text-app-muted">
      {notice ? (
        <h1 className="text-[12px] leading-[18px] font-medium text-app-ink">
          {notice}
        </h1>
      ) : null}
      {subtitle ? <p>{subtitle}</p> : null}
      {statusMessage ? (
        <p className="flex items-start gap-1.5" role="status">
          <Icon
            icon={Loading03Icon}
            className={`mt-[3px] shrink-0 text-app-warning ${finalizing ? "animate-spin" : ""}`}
            size={12}
          />
          {statusMessage}
        </p>
      ) : null}
      {gapCount > 0 ? (
        // Audio the service never received stays visible, not hidden by the timer.
        <p className="flex items-start gap-1.5" role="status">
          <Icon
            icon={AlertCircleIcon}
            className="mt-[3px] shrink-0 text-app-warning"
            size={12}
          />
          <span>
            {t(m.inputMissed, {
              count: gapCount,
              seconds: Math.max(1, Math.round(gapDurationMs / 1000)),
            })}
          </span>
        </p>
      ) : null}
      {surfaceError ? (
        <p className="flex items-start gap-1.5 text-app-danger" role="alert">
          <Icon
            icon={AlertCircleIcon}
            className="mt-[3px] shrink-0"
            size={12}
          />
          {surfaceError}
        </p>
      ) : null}
      {onRetryStop ? (
        <div>
          <Button
            disabled={reconnecting}
            onClick={onRetryStop}
            size="compact"
            tone="ghost"
          >
            {t(m.retryStop)}
          </Button>
        </div>
      ) : null}
      {onReconnect ? (
        <div>
          <Button
            disabled={reconnecting}
            onClick={onReconnect}
            size="compact"
            tone="ghost"
          >
            <Icon icon={Mic01Icon} size={14} />
            {t(m.reconnectMicrophone)}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// Town Nature palette (700 shades keep names readable on white); Speaker N
// keeps the same color for the whole recording.
const speakerColors = [
  "text-bluebell-700",
  "text-lavender-700",
  "text-lake-700",
  "text-sun-700",
  "text-bubblegum-700",
  "text-rain-700",
  "text-acorn-700",
  "text-grass-700",
  "text-fawn-700",
  "text-lichen-700",
];

function speakerColor(label: string) {
  const index = Number(label.match(/(\d+)$/)?.[1] ?? 1);
  return speakerColors[(Math.max(index, 1) - 1) % speakerColors.length]!;
}

function VoiceFocusTranscriptRow({ item }: { item: VoiceTranscriptItem }) {
  const t = useT();
  // The client names an unnamed speaker "Speaker N"; the number is kept.
  const number = item.speakerLabel?.match(/^Speaker (\d+)$/)?.[1];
  const speaker = number ? t(m.speaker, { number }) : item.speakerLabel;
  // Town message rows: a 13px name line over 14px body text, starting
  // straight with the speaker.
  return (
    <div className="flex flex-col gap-0.5 rounded-lg px-2.5 py-1.5">
      {item.speakerLabel ? (
        <span
          className={`text-[14px] leading-[18px] font-medium ${speakerColor(item.speakerLabel)}`}
        >
          {speaker}
        </span>
      ) : null}
      <p className="m-0 text-sm leading-5 text-app-body">{item.text}</p>
    </div>
  );
}

function focusTitle(captureStatus: VoiceCaptureState["status"]) {
  if (captureStatus === "failed") return m.titleSaveFailed;
  if (captureStatus === "recovering") return m.titleRecovering;
  if (captureStatus === "finalizing") return m.titleSaving;
  return m.titleListening;
}

function focusSubtitle(
  captureStatus: VoiceCaptureState["status"],
): Message<string> | undefined {
  if (captureStatus === "failed") return m.subtitleSaveFailed;
  if (captureStatus === "recovering") return m.subtitleRecovering;
  if (captureStatus === "finalizing") return m.subtitleSaving;
  return undefined;
}

// The server's failure codes are worded here in English until they are
// translated with the other server-sent text; the client's own fallback is not.
function captureFailureDescription(reason: unknown, t: Translate): string {
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === "string"
        ? reason
        : undefined;
  switch (message) {
    case "transcript_incomplete":
    case "transcript_integrity_lost":
      return "The transcript could not be fully confirmed, so saving is incomplete.";
    case "materialization_failed":
      return "Failed to generate the recording file.";
    case "provider_unavailable":
      return "The recording service is temporarily unavailable, so saving could not finish.";
    case "Voice Capture failed":
    case undefined:
    case "":
      return t(m.saveFailed);
    default:
      return message;
  }
}

/** Whether the microphone has been up at some point during this recording. */
function useMicrophoneUpDuringRecording(
  recordingId: string | undefined,
  up: boolean,
) {
  const [upIn, setUpIn] = useState<string>();
  const wasUp = recordingId !== undefined && upIn === recordingId;
  if (up && recordingId !== undefined && !wasUp) setUpIn(recordingId);
  return wasUp || (up && recordingId !== undefined);
}
