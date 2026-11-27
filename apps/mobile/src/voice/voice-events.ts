// Follows one VoiceSession's events stream: transcript events with the
// current VoiceSession and Capture snapshots, and the latest partial. A
// dropped stream reconnects after the last cursor it saw, so every committed
// transcript event arrives once.
import { voiceEventsStreamPath } from "../api/teamhub";
import type { VoiceEventPage, VoiceTranscriptEventPage } from "../api/types";
import { subscribe } from "../session/http";
import type { PhoneSession } from "../session/session";

export interface VoiceEventHandlers {
  page(page: VoiceEventPage): void;
  partial(page: VoiceTranscriptEventPage): void;
  /** The login session expired or lost access; the stream will not return. */
  ended?(): void;
}

const RETRY_MS = 1_000;

/** Starts following; the returned function stops it. */
export function followVoiceEvents(input: {
  readonly voiceSessionId: string;
  session(signal: AbortSignal): Promise<PhoneSession>;
  readonly handlers: VoiceEventHandlers;
}): () => void {
  const abort = new AbortController();
  let cursor: string | undefined;
  let cancel: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const retry = () => {
    if (abort.signal.aborted) return;
    timer = setTimeout(() => void connect(), RETRY_MS);
  };

  const connect = async () => {
    let session: PhoneSession;
    try {
      session = await input.session(abort.signal);
    } catch {
      retry();
      return;
    }
    if (abort.signal.aborted) return;
    let ended = false;
    try {
      cancel = subscribe(
        session,
        voiceEventsStreamPath(input.voiceSessionId, cursor),
        {
          onEvent(event) {
            try {
              if (event.event === "voice.events") {
                const page = JSON.parse(event.data) as VoiceEventPage;
                if (page.next_cursor) cursor = page.next_cursor;
                input.handlers.page(page);
              } else if (event.event === "voice.partial") {
                input.handlers.partial(
                  JSON.parse(event.data) as VoiceTranscriptEventPage,
                );
              } else if (
                event.event === "session.expired" ||
                event.event === "access.revoked"
              ) {
                ended = true;
                input.handlers.ended?.();
              }
            } catch {
              // A frame that is not the documented JSON is skipped.
            }
          },
          onClose() {
            cancel = undefined;
            if (!ended) retry();
          },
        },
      );
    } catch {
      retry();
    }
  };

  void connect();
  return () => {
    abort.abort();
    if (timer) clearTimeout(timer);
    cancel?.();
  };
}
