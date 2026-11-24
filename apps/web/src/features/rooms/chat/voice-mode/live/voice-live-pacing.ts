import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * Live subtitles follow the voice. The reply text arrives seconds before it
 * is spoken and in bursts, so a reply line reveals its words while the reply
 * is audible, at the pace this call's voice has spoken earlier replies. The
 * pace is measured, never assumed per language.
 */

/**
 * How a reply line's words follow the voice: "speaking" while the reply is
 * produced, "said" once all of it was produced but it may still be playing,
 * "cut" when the Human cut it off, so only what was shown stays. "typing" is
 * the Human's own words as they are transcribed: they arrive a phrase at a
 * time and flow in quickly rather than at a voice's pace. A line with none
 * shows all its words.
 */
export type VoiceLinePacing = "speaking" | "said" | "cut" | "typing";

/** Before any reply played to the end: between slow and fast speech in any script. */
const defaultCharsPerSecond = 7;
const minCharsPerSecond = 2;
const maxCharsPerSecond = 30;
/** A level older than this is not trusted: a hidden page stops measuring. */
const staleLevelMs = 400;
/** Words produced and inaudible for this long have been heard. */
const heardQuietMs = 700;
/** What is left once the voice ended shows within this long. */
const finishMs = 200;
/** A reply shorter than this says too little about the pace. */
const minLearnMs = 1_500;
/**
 * The Human's newly transcribed words flow in easing out: most of a phrase in
 * this long, the last few at the floor rate below.
 */
const typingCatchUpMs = 250;
/** The Human's last few words still flow in at least this fast. */
const minTypingCharsPerSecond = 20;
/** A frame longer than this is a paused page, not time the voice spoke. */
const maxFrameMs = 100;

let replyAudible = false;
let replyLevelAt = -Infinity;
let charsPerSecond = defaultCharsPerSecond;

/** The live reply playback is audible now, or not. */
export function noteReplyAudible(audible: boolean, at = performance.now()) {
  replyAudible = audible;
  replyLevelAt = at;
}

/** The reply playback stopped; nothing is measuring it any more. */
export function resetReplyAudible() {
  replyAudible = false;
  replyLevelAt = -Infinity;
}

function readReplyAudible(now: number) {
  // Without a fresh level (no meter, or its page is hidden) the voice is
  // taken to be playing, so the words still move at the voice's pace.
  return now - replyLevelAt <= staleLevelMs ? replyAudible : true;
}

/** Characters per audible second this call's voice has spoken so far. */
export function voicePace() {
  return charsPerSecond;
}

/** A reply of this many characters played for this long. */
export function learnVoicePace(characters: number, audibleMs: number) {
  if (audibleMs < minLearnMs || characters < 1) return;
  const observed = characters / (audibleMs / 1000);
  charsPerSecond = Math.min(
    maxCharsPerSecond,
    Math.max(minCharsPerSecond, (charsPerSecond + observed) / 2),
  );
}

/** Forgets the measured pace; for tests. */
export function resetVoicePace() {
  charsPerSecond = defaultCharsPerSecond;
}

export interface PacedTextState {
  /** Characters shown, fractional between frames. */
  shown: number;
  /** How long the voice was audible while this line was spoken. */
  audibleMs: number;
  quietMs: number;
  /** The voice ended; what is left shows at once. */
  finishing: boolean;
}

/** One frame of a paced line. */
export function advancePacedText(
  state: PacedTextState,
  frame: {
    length: number;
    pacing: VoiceLinePacing | undefined;
    elapsedMs: number;
    audible: boolean;
    rate: number;
  },
): PacedTextState {
  const shown = Math.min(state.shown, frame.length);
  if (frame.pacing === "cut") return { ...state, shown };
  if (frame.pacing === "typing") {
    // Transcription arrives a phrase at a time, about once a second; each
    // phrase flows in before the next one comes.
    const rate = Math.max(
      minTypingCharsPerSecond,
      ((frame.length - shown) * 1000) / typingCatchUpMs,
    );
    return {
      ...state,
      shown: Math.min(frame.length, shown + (rate * frame.elapsedMs) / 1000),
    };
  }
  let { audibleMs, quietMs, finishing } = state;
  // A reply that goes on after a tool round is spoken again.
  if (frame.pacing === "speaking") finishing = false;
  else if (frame.pacing === undefined) finishing = true;
  if (frame.audible) {
    audibleMs += frame.elapsedMs;
    quietMs = 0;
  } else {
    quietMs += frame.elapsedMs;
    if (frame.pacing === "said" && quietMs >= heardQuietMs) finishing = true;
  }
  const rate = finishing
    ? Math.max(frame.rate, (frame.length * 1000) / finishMs)
    : frame.audible
      ? frame.rate
      : 0;
  return {
    shown: Math.min(frame.length, shown + (rate * frame.elapsedMs) / 1000),
    audibleMs,
    quietMs,
    finishing,
  };
}

/**
 * The part of a line's text to show now. A line first seen while it is
 * spoken or transcribed starts empty and flows in; any other line shows in
 * full.
 */
export function usePacedText(
  text: string,
  pacing: VoiceLinePacing | undefined,
  element: RefObject<HTMLElement | null>,
) {
  const characters = Array.from(text);
  const length = characters.length;
  const [shown, setShown] = useState(() =>
    pacing === "speaking" || pacing === "typing" ? 0 : length,
  );
  const state = useRef<PacedTextState>({
    shown,
    audibleMs: 0,
    quietMs: 0,
    finishing: pacing !== "speaking" && pacing !== "typing",
  });
  const latest = useRef({ length, pacing });
  const wake = useRef<() => void>(undefined);
  // One frame loop per line for its whole life: new words wake it, and it
  // sleeps once every word is shown and the voice has ended.
  useEffect(() => {
    // The window the line is in: a picture-in-picture window keeps painting
    // while the page that opened it is hidden.
    const view = element.current?.ownerDocument.defaultView ?? window;
    const request =
      typeof view.requestAnimationFrame === "function"
        ? (tick: FrameRequestCallback) => view.requestAnimationFrame(tick)
        : (tick: FrameRequestCallback) =>
            view.setTimeout(() => tick(view.performance.now()), 16);
    const cancel =
      typeof view.cancelAnimationFrame === "function"
        ? (frame: number) => view.cancelAnimationFrame(frame)
        : (frame: number) => view.clearTimeout(frame);
    let frame = 0;
    let running = false;
    let last = 0;
    const asleep = () => {
      const { length, pacing } = latest.current;
      return (
        pacing === "cut" ||
        (state.current.shown >= length &&
          (state.current.finishing || pacing === "typing"))
      );
    };
    const tick = (time: number) => {
      const elapsedMs = Math.min(maxFrameMs, Math.max(0, time - last));
      last = time;
      const { length, pacing } = latest.current;
      const before = state.current;
      const next = advancePacedText(before, {
        length,
        pacing,
        elapsedMs,
        audible: readReplyAudible(performance.now()),
        rate: charsPerSecond,
      });
      state.current = next;
      if (next.finishing && !before.finishing)
        learnVoicePace(length, next.audibleMs);
      if (Math.floor(next.shown) !== Math.floor(before.shown))
        setShown(Math.floor(next.shown));
      if (asleep()) {
        running = false;
        return;
      }
      frame = request(tick);
    };
    wake.current = () => {
      if (running || asleep()) return;
      running = true;
      last = view.performance.now();
      frame = request(tick);
    };
    wake.current();
    return () => {
      wake.current = undefined;
      running = false;
      cancel(frame);
    };
  }, [element]);
  useEffect(() => {
    latest.current = { length, pacing };
    wake.current?.();
  }, [length, pacing]);
  return shown >= length ? text : characters.slice(0, shown).join("");
}
