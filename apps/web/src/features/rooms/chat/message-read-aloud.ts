import { useCallback, useEffect, useRef, useState } from "react";

// The Linger TTS service: a small local HTTP wrapper around edge-tts that
// stays resident on this computer (Task Scheduler "LingerTtsService").
const TTS_ENDPOINT = "http://127.0.0.1:5678/speak";
const VOICE_KEY = "linger.tts.voice";
const RATE_KEY = "linger.tts.rate";
export const DEFAULT_TTS_VOICE = "zh-CN-XiaoxiaoNeural";

export type ReadAloudState = "idle" | "loading" | "playing" | "error";

export interface MessageReadAloud {
  readonly state: ReadAloudState;
  readonly speak: () => void;
  readonly stop: () => void;
}

// One playback at a time across the page: starting a new read-aloud
// supersedes (and stops) the previous one.
let currentOwner: string | null = null;
let currentAudio: HTMLAudioElement | null = null;
let currentUrl: string | null = null;
const supersedeListeners = new Map<string, (owner: string) => void>();

function stopPlayback(owner: string): void {
  if (currentOwner !== owner) return;
  currentAudio?.pause();
  currentAudio = null;
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = null;
  currentOwner = null;
}

export function useMessageReadAloud(
  messageId: string,
  rawMessage: string,
): MessageReadAloud {
  const [state, setState] = useState<ReadAloudState>("idle");
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const superseded = (owner: string): void => {
      if (owner !== messageId) setState("idle");
    };
    supersedeListeners.set(messageId, superseded);
    return () => {
      alive.current = false;
      supersedeListeners.delete(messageId);
      stopPlayback(messageId);
    };
  }, [messageId]);

  const stop = useCallback((): void => {
    stopPlayback(messageId);
    setState("idle");
  }, [messageId]);

  const speak = useCallback((): void => {
    const text = rawMessage.trim();
    if (!text) {
      setState("error");
      return;
    }
    void (async () => {
      let voice = DEFAULT_TTS_VOICE;
      let rate = "+0%";
      try {
        voice = localStorage.getItem(VOICE_KEY) ?? voice;
        rate = localStorage.getItem(RATE_KEY) ?? rate;
      } catch {
        // Private mode: the defaults still work.
      }
      setState("loading");
      try {
        const response = await fetch(TTS_ENDPOINT, {
          body: JSON.stringify({ text, voice, rate }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        if (!response.ok) throw new Error(`tts ${response.status}`);
        const audio = new Audio(
          URL.createObjectURL(
            new Blob([await response.arrayBuffer()], { type: "audio/mpeg" }),
          ),
        );
        // A new playback supersedes the old one and all stale buttons.
        stopPlayback(currentOwner ?? "");
        for (const [owner, listener] of supersedeListeners)
          if (owner !== messageId) listener(messageId);
        currentOwner = messageId;
        currentAudio = audio;
        currentUrl = audio.src;
        audio.addEventListener("ended", () => {
          if (currentOwner === messageId) stopPlayback(messageId);
          if (alive.current) setState("idle");
        });
        audio.addEventListener("error", () => {
          if (currentOwner === messageId) stopPlayback(messageId);
          if (alive.current) setState("error");
        });
        await audio.play();
        if (alive.current) setState("playing");
      } catch {
        if (currentOwner === messageId) stopPlayback(messageId);
        if (alive.current) setState("error");
      }
    })();
  }, [messageId, rawMessage]);

  return { speak, state, stop };
}
