import {
  Loading03Icon,
  AiTranscribeAudioIcon,
} from "@hugeicons/core-free-icons";
import { use, useEffect, useEffectEvent, useRef, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { useT } from "@/i18n/use-translation";

import { roomListMessages } from "../room-list.messages";
import { useOptionalVoiceModeSession } from "../chat/voice-mode/voice-mode-session";
import { LazyVoiceKeyDialog } from "./lazy-voice-key-dialog";
import { openRecordingWindow } from "./recording-window-store";
import {
  isTranscriptRecoveryPaused,
  transcriptRecoveryPercent,
  useOptionalVoiceControl,
  VoiceCapabilitiesContext,
  VoiceConnectionRetryContext,
} from "./voice-control-context";

/**
 * The sidebar's Meeting tool. Every recording is kept with Another Me, so
 * its audio and transcript arrive in that chat when it finishes. Clicking it
 * opens the Recording window and starts recording when none is running.
 */
export function RecordingEntry({
  anotherMeRoomId,
  tenantId,
}: {
  anotherMeRoomId?: string;
  tenantId: string;
}) {
  const t = useT();
  const livekit = useOptionalVoiceControl();
  const voice = livekit;
  const voiceMode = useOptionalVoiceModeSession();
  const voiceInputBusy = voice?.composerMicrophoneActive && !voiceMode?.session;
  // Recording transcribes with Soniox; xAI alone does not offer it.
  const capabilities = use(VoiceCapabilitiesContext);
  const retryConnection = use(VoiceConnectionRetryContext);
  const connectionFailed = Boolean(retryConnection);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  // Without a Soniox key the entry asks for one, then starts once voice runs.
  const needsKey = capabilities?.voiceMedia === false;
  const [keyDialogOpen, setKeyDialogOpen] = useState(false);
  const startWhenReady = useRef(false);
  const status = voice?.captureState?.status;
  const recording = status === "recording" || status === "starting";
  const recoveryFailed = Boolean(
    voice &&
    status === "recovering" &&
    isTranscriptRecoveryPaused(voice.captureState),
  );
  const recovering = status === "recovering" && !recoveryFailed;
  const saving = status === "finalizing" || recovering;
  // Stop gave up with the recording still running; the window offers Retry.
  const stopFailed = Boolean(voice?.retryStop);
  const capture =
    voice?.captureState && "capture" in voice.captureState
      ? voice.captureState.capture
      : undefined;
  // Older TeamHub releases report the progress but not the attempt.
  const attempt =
    recovering &&
    capture?.transcript_recovery_attempt &&
    capture.transcript_recovery_max_attempts
      ? {
          attempt: capture.transcript_recovery_attempt,
          max: capture.transcript_recovery_max_attempts,
        }
      : undefined;
  const switchFromLive = Boolean(voiceMode?.session);
  const standby = voice?.listenerStatus === "standby";
  // Until voice connects, including while it reconnects, the icon spins.
  const connecting = !voice && !connectionFailed && !needsKey;
  const label = t(
    recording
      ? roomListMessages.returnToRecording
      : saving && switchFromLive
        ? roomListMessages.startNewMeeting
        : saving
          ? roomListMessages.viewSaveProgress
          : connectionFailed
            ? roomListMessages.retryVoiceConnection
            : roomListMessages.meetings,
  );
  const hint =
    error ??
    (connectionFailed
      ? t(roomListMessages.voiceUnavailable)
      : needsKey
        ? label
        : !voice || !anotherMeRoomId
          ? t(roomListMessages.meetingLoading)
          : voiceInputBusy
            ? t(roomListMessages.finishVoiceInput)
            : standby
              ? t(roomListMessages.recordingElsewhere)
              : stopFailed
                ? t(roomListMessages.stopFailedHint)
                : recoveryFailed
                  ? t(roomListMessages.recoveryFailedHint)
                  : attempt
                    ? t(roomListMessages.recoveringAttemptHint, attempt)
                    : recovering
                      ? t(roomListMessages.recoveringProgressHint, {
                          progress: capture
                            ? transcriptRecoveryPercent(capture)
                            : 0,
                        })
                      : label);
  function start() {
    if (retryConnection) {
      retryConnection();
      return;
    }
    if (needsKey) {
      setKeyDialogOpen(true);
      return;
    }
    if (!voice || !anotherMeRoomId || pending || voiceInputBusy) return;
    setPending(true);
    setError(undefined);
    // Keep the desktop window open request attached to the initiating click.
    const startRecording = async () => {
      const pip = import("../chat/voice-mode/voice-pip");
      // A new Meeting opens expanded in the desktop app's own window.
      const opened = pip.then(({ openVoicePip }) => openVoicePip("recording"));
      try {
        await voice.selectTargetRoom?.(anotherMeRoomId);
        await opened;
        // A failed save or recovery opens on its Retry instead.
        openRecordingWindow({
          autoStart: !(saving || recoveryFailed) || switchFromLive,
        });
      } catch (cause) {
        await opened;
        const { closeVoicePip } = await pip;
        closeVoicePip("recording");
        throw cause;
      }
    };
    void (voiceMode ? voiceMode.startMeeting(startRecording) : startRecording())
      .catch((cause: unknown) => {
        setError(
          cause instanceof Error
            ? cause.message
            : t(roomListMessages.recordingFailed),
        );
      })
      .finally(() => setPending(false));
  }

  // The engine for a just-saved key loads after the dialog closes; the
  // recording the Human asked for starts once it is here.
  const startSaved = useEffectEvent(() => start());
  const engineReady = Boolean(voice && anotherMeRoomId) && !needsKey;
  useEffect(() => {
    if (!startWhenReady.current || !engineReady) return;
    startWhenReady.current = false;
    startSaved();
  }, [engineReady]);

  if (capabilities?.voiceAvailable === false) return null;

  return (
    <>
      {/* eslint-disable-next-line jsx-a11y/role-supports-aria-props -- aria-description is a valid ARIA global attribute missing from the rule data. */}
      <button
        aria-description={hint === label ? undefined : hint}
        aria-label={label}
        className="xs-nav-btn relative"
        disabled={
          !connectionFailed &&
          !needsKey &&
          (pending || !voice || !anotherMeRoomId || voiceInputBusy)
        }
        onClick={start}
        title={hint}
        type="button"
      >
        {(status === "finalizing" && !stopFailed && !switchFromLive) ||
        connecting ? (
          <Icon icon={Loading03Icon} className="animate-spin" size={16} />
        ) : (
          <Icon icon={AiTranscribeAudioIcon} size={16} />
        )}
        <span className="xs-nav-btn-label">
          {saving && switchFromLive
            ? t(roomListMessages.newMeeting)
            : attempt
              ? t(roomListMessages.recoveringLabel, attempt)
              : t(roomListMessages.meetings)}
        </span>
        {recording ||
        connectionFailed ||
        recovering ||
        recoveryFailed ||
        stopFailed ? (
          <span
            aria-hidden="true"
            className={`absolute top-1 right-1 size-2 rounded-full ring-2 ring-app-sidebar ${recording || recoveryFailed || stopFailed ? "bg-app-danger" : "bg-app-warning"}`}
          />
        ) : null}
        {error ? (
          <span className="sr-only" role="alert">
            {error}
          </span>
        ) : null}
      </button>
      {keyDialogOpen ? (
        <LazyVoiceKeyDialog
          onClose={() => setKeyDialogOpen(false)}
          onReady={() => {
            setKeyDialogOpen(false);
            startWhenReady.current = true;
          }}
          policy={capabilities?.policy}
          providers={["soniox"]}
          tenantId={tenantId}
        />
      ) : null}
    </>
  );
}
