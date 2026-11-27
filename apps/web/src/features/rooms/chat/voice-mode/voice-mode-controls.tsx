import {
  AudioWave01Icon,
  Cancel01Icon,
  Mic01Icon,
  MicOff01Icon,
  RotateLeft01Icon,
  VolumeHighIcon,
  VolumeOffIcon,
} from "@hugeicons/core-free-icons";
import { useEffect, useState, type CSSProperties } from "react";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import type {
  TeamHubActorRef,
  TeamHubVoiceMediaPolicy,
} from "@/features/teamhub/teamhub-types";
import type { VoiceTurnPrefix } from "./voice-mode-room-sender";
import {
  useOptionalVoiceModeSession,
  type VoiceModeModes,
  useVoiceModeLevel,
} from "./voice-mode-session";
import styles from "./voice-mode.module.css";
import { voiceModeStatusLabel } from "./voice-mode-presentation";
import { openVoicePip } from "./voice-pip";
import { LazyVoiceKeyDialog } from "@/features/rooms/voice-control/lazy-voice-key-dialog";
import { useT } from "@/i18n/use-translation";
import { voiceModeMessages } from "./voice-mode.messages";

export type { VoiceModePresentation } from "./voice-mode-presentation";

export interface VoiceModeTarget {
  roomId: string;
  tenantId: string;
  recipient?: TeamHubActorRef;
  /** Draft scope owner, so unsent words return to this Room's draft. */
  accountId?: string;
  /** Shown on the floating voice window while the Human is elsewhere. */
  roomName?: string;
}

const waveformDotCount = 160;
const noVoiceModes: VoiceModeModes = { dictation: false, live: false };

function voiceModes(policy: TeamHubVoiceMediaPolicy | undefined) {
  return policy
    ? {
        // The downloaded speech model dictates without a Soniox key.
        dictation:
          policy.voice_media_supported === true ||
          policy.local_dictation_supported === true,
        live: policy.live_supported === true,
      }
    : noVoiceModes;
}

/**
 * The Room composer's view of the app-level Voice Mode session: it starts the
 * session for this Room and shows its live controls, but the session itself
 * outlives the composer when the Human navigates to another Room.
 */
export function VoiceModeControls(props: {
  target: VoiceModeTarget;
  disabled: boolean;
  empty: boolean;
  prefix: VoiceTurnPrefix;
  /** The deployment's voice support, read once by the composer. */
  policy: TeamHubVoiceMediaPolicy | undefined;
}) {
  const t = useT();
  const voice = useOptionalVoiceModeSession();
  const { roomId, tenantId } = props.target;
  // xAI makes Voice Mode a Live conversation; with Soniox alone it dictates.
  const policy = props.policy;
  const modes: VoiceModeModes = voiceModes(policy);
  const supported = modes.dictation || modes.live;
  // A deployment that runs voice offers Voice Mode before any key exists;
  // the click then asks for a Soniox or xAI key.
  const offered = supported || policy?.voice_available === true;
  const [keyDialogOpen, setKeyDialogOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string>();
  // Once Voice Mode is offered, its code loads in the background.
  const prepare = voice?.prepare;
  useEffect(() => {
    if (supported) prepare?.();
  }, [prepare, supported]);

  const session = voice?.session;
  const here = session?.target.roomId === roomId ? session : undefined;
  const elsewhere = session && !here ? session : undefined;
  const entered = Boolean(here?.entered);
  const closing = Boolean(here?.closing);
  const enter = (next = modes) => {
    if (!voice || props.disabled || session || starting) return;
    if (!next.dictation && !next.live) {
      if (offered) setKeyDialogOpen(true);
      return;
    }
    setStarting(true);
    setStartError(undefined);
    void voice
      .start(
        {
          accountId: props.target.accountId ?? "",
          recipient: props.target.recipient,
          roomId,
          roomName: props.target.roomName ?? "",
          tenantId,
        },
        props.prefix,
        next,
        () => openVoicePip("voice-mode"),
      )
      .catch((cause: unknown) => {
        setStartError(
          cause instanceof Error
            ? cause.message
            : t(voiceModeMessages.unableToStart),
        );
      })
      .finally(() => setStarting(false));
  };
  if (!entered && !closing && (!props.empty || !offered)) return null;
  if (!entered)
    return (
      <>
        <Button
          aria-label={t(
            closing ? voiceModeMessages.finishing : voiceModeMessages.start,
          )}
          title={
            startError ??
            (closing
              ? t(voiceModeMessages.finishingHint)
              : elsewhere
                ? elsewhere.target.roomName
                  ? t(voiceModeMessages.onInRoom, {
                      room: elsewhere.target.roomName,
                    })
                  : t(voiceModeMessages.onInAnotherRoom)
                : t(
                    modes.live
                      ? voiceModeMessages.liveHint
                      : modes.dictation
                        ? voiceModeMessages.dictationHint
                        : voiceModeMessages.keyHint,
                  ))
          }
          className="message-composer-send"
          disabled={starting || closing || props.disabled || Boolean(elsewhere)}
          onClick={() => enter()}
          size="compactIcon"
          tone="primary"
        >
          <Icon icon={AudioWave01Icon} size={16} />
        </Button>
        {startError ? (
          <span className="sr-only" role="alert">
            {startError}
          </span>
        ) : null}
        {keyDialogOpen ? (
          <LazyVoiceKeyDialog
            onClose={() => setKeyDialogOpen(false)}
            onReady={(_provider, next) => {
              setKeyDialogOpen(false);
              enter(voiceModes(next));
            }}
            policy={policy}
            providers={["xai", "soniox", "local"]}
            tenantId={tenantId}
          />
        ) : null}
      </>
    );
  const state = here!.state;
  const muted = here!.muted;
  const soundOff = here!.live?.soundOff;
  const active = Boolean(state.microphoneActive) && !muted;
  // A finished turn is still settling into a message: the bar dims and
  // three dots wait beside it, while the microphone keeps listening.
  const settling = state.sending || state.flushing;
  return (
    <div
      className={styles.panel}
      aria-label={t(voiceModeMessages.controls)}
      data-settling={settling || undefined}
      role="group"
    >
      <span className={styles.lead}>
        <Icon icon={AudioWave01Icon} size={14} />
        <span className={styles.label}>{t(voiceModeMessages.voiceInput)}</span>
      </span>
      <LiveVoiceWaveform active={active} />
      {settling ? (
        <span aria-hidden="true" className={styles.settlingDots}>
          <i />
          <i />
          <i />
        </span>
      ) : null}
      <span className="sr-only" role="status">
        {voiceModeStatusLabel({ ...state, entered }, t)}
      </span>
      {state.canRetry ? (
        <Button
          aria-label={t(voiceModeMessages.retry)}
          title={t(voiceModeMessages.retryHint)}
          size="compactIcon"
          tone="ghost"
          disabled={state.sending}
          onClick={() => voice?.retry()}
        >
          <Icon icon={RotateLeft01Icon} size={16} />
        </Button>
      ) : null}
      <Button
        aria-label={t(
          muted ? voiceModeMessages.unmute : voiceModeMessages.mute,
        )}
        aria-pressed={muted}
        className={styles.mute}
        disabled={!state.microphoneActive || state.status === "closing"}
        onClick={() => void voice?.setMuted(!muted)}
        size="compactIcon"
        tone="ghost"
      >
        {muted ? (
          <Icon icon={MicOff01Icon} size={16} />
        ) : (
          <Icon icon={Mic01Icon} size={16} />
        )}
      </Button>
      {soundOff === undefined ? null : (
        <Button
          aria-label={t(
            soundOff
              ? voiceModeMessages.replySoundOn
              : voiceModeMessages.replySoundOff,
          )}
          aria-pressed={soundOff}
          className={styles.sound}
          onClick={() => voice?.setSoundOff(!soundOff)}
          size="compactIcon"
          tone="ghost"
        >
          {soundOff ? (
            <Icon icon={VolumeOffIcon} size={16} />
          ) : (
            <Icon icon={VolumeHighIcon} size={16} />
          )}
        </Button>
      )}
      <Button
        aria-label={t(voiceModeMessages.exit)}
        className={styles.exit}
        disabled={state.status === "closing"}
        onClick={() => voice?.exit()}
        size="compactIcon"
        tone="ghost"
      >
        <Icon icon={Cancel01Icon} size={16} />
      </Button>
    </div>
  );
}

/**
 * A fine waveform across the whole bar. The voice level lifts all of it at
 * once (square-rooted so quiet speech still shows), each line is a little
 * taller toward the centre, and a staggered CSS ripple keeps it flowing.
 */
function LiveVoiceWaveform({ active }: { active: boolean }) {
  return <VoiceWaveform active={active} level={useVoiceModeLevel()} />;
}

export function VoiceWaveform({
  active,
  level,
}: {
  active: boolean;
  level: number;
}) {
  const amplitude = active ? Math.sqrt(Math.min(1, Math.max(0, level))) : 0;
  return (
    <span
      className={styles.wave}
      aria-hidden="true"
      style={{ "--voice-level": amplitude } as CSSProperties}
    >
      {Array.from({ length: waveformDotCount }, (_, bar) => {
        const center = (waveformDotCount - 1) / 2;
        const distance = Math.abs(bar - center) / center;
        const envelope = 0.45 + 0.55 * (1 - distance * distance);
        return (
          <i
            key={bar}
            style={
              {
                "--voice-weight": envelope,
                "--voice-delay": `${-(bar % 32) * 0.035}s`,
              } as CSSProperties
            }
          />
        );
      })}
    </span>
  );
}
