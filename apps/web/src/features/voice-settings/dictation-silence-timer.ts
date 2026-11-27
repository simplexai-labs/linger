/**
 * Minimum smoothed microphone level treated as active speech for silence
 * auto-stop. Matches `observeAudioLevel`'s noise floor so float64 decay tails
 * (which approach ~1.5e-323 without reaching 0) never keep resetting the timer.
 */
export const VOICE_SILENCE_ACTIVITY_THRESHOLD = 0.04;

/**
 * Client-side inactivity timer for "Stop after silence" in dictation sessions
 * (Pocket Notes & Voice Mode dictation only — never Meeting Recording).
 */
export interface DictationSilenceTimer {
  /** Updates the configured timeout in seconds (0 disables auto-stop). */
  setTimeoutSeconds: (seconds: number) => void;
  /** Marks the session as actively listening (starts/restarts countdown) or inactive (clears). */
  setActive: (active: boolean) => void;
  /** Records speech or transcript activity and resets the silence countdown. */
  noteActivity: () => void;
  /** Permanently stops and clears any scheduled timeout. */
  dispose: () => void;
}

export function createDictationSilenceTimer(
  onSilenceTimeout: () => void,
): DictationSilenceTimer {
  let timeoutSeconds = 0;
  let active = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clear = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const arm = () => {
    clear();
    if (disposed || !active || timeoutSeconds <= 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (disposed || !active || timeoutSeconds <= 0) return;
      active = false;
      onSilenceTimeout();
    }, timeoutSeconds * 1_000);
  };

  return {
    setTimeoutSeconds(seconds) {
      const normalized = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
      if (normalized === timeoutSeconds) return;
      timeoutSeconds = normalized;
      if (active) arm();
      else clear();
    },
    setActive(next) {
      if (next === active) return;
      active = next;
      if (active) arm();
      else clear();
    },
    noteActivity() {
      if (!active || timeoutSeconds <= 0) return;
      arm();
    },
    dispose() {
      disposed = true;
      active = false;
      clear();
    },
  };
}
