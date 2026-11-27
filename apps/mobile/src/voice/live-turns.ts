// Live voice on the phone follows the browser's turn rules
// (apps/web/.../voice-live-arbiter.ts): each turn the live model heard is
// saved once, as the Human's own words, after its whole reply ended or 20
// seconds passed; the marker tells TeamHub the live voice answered it. The
// phone shows no page, so it answers page tools as unsupported and keeps
// end_voice_mode.
import type {
  VoiceLiveClientEvent,
  VoiceLiveRuntimeEvent,
  VoiceLiveTurnMarker,
} from "../api/types";

/** One thing said in the call, by the Human or by the live voice. */
export interface LiveLine {
  readonly id: string;
  readonly speaker: "you" | "live";
  readonly text: string;
  /** Still being said. */
  readonly pending?: boolean;
}

/** How long a turn waits for its whole reply before it is saved anyway. */
export const LIVE_TURN_SETTLE_MS = 20_000;
/** After the goodbye reply ends, Live closes after this short tail. */
export const END_TAIL_MS = 300;
/** Live closes by then even if the goodbye reply never arrives. */
export const END_CAP_MS = 10_000;
const TRANSCRIPT_LINES = 200;

/** Punctuation and spacing never decide whether a turn continues. */
function comparableSpeech(text: string): string {
  return text.toLowerCase().replaceAll(/[\p{P}\p{S}\s]/gu, "");
}

/** The later turn repeats the earlier one and says more. */
export function continuesTurn(earlier: string, later: string): boolean {
  const before = comparableSpeech(earlier);
  const after = comparableSpeech(later);
  return (
    before.length >= 2 && after.length > before.length && after.includes(before)
  );
}

export interface LiveTurnsOptions {
  readonly voiceSessionId: string;
  /** Sends a client event on the Live topic. */
  send(event: VoiceLiveClientEvent): void;
  /** Saves one turn as the Human's Message; the marker is set when Live answered it. */
  save(
    turnId: string,
    text: string,
    marker: VoiceLiveTurnMarker | undefined,
  ): void;
  onTranscript(lines: readonly LiveLine[]): void;
  /** What the Human is saying now; empty once the turn is final. */
  onPartial(text: string): void;
  /** Stops reply playback at once. */
  interrupt(): void;
  /** Ends Live, after the goodbye was heard. */
  end(): void;
  /** The live session failed; Live cannot continue. */
  failed(code: string): void;
}

interface Turn {
  reply: string;
  interrupted: boolean;
  text?: string;
  continued?: boolean;
  posted?: boolean;
  answered?: boolean;
  superseded?: boolean;
  settled: boolean;
  timer?: ReturnType<typeof setTimeout>;
  save?: () => void;
}

export interface LiveTurns {
  receive(event: VoiceLiveRuntimeEvent): void;
  /** Saves every turn still waiting, as whatever it became. */
  settle(): void;
  dispose(): void;
}

export function createLiveTurns(options: LiveTurnsOptions): LiveTurns {
  let disposed = false;
  const turns = new Map<string, Turn>();
  const transcript: LiveLine[] = [];
  const updates = new Map<string, string>();
  let latestTurnId: string | undefined;
  let endAfterTurn: string | undefined;
  let endTimer: ReturnType<typeof setTimeout> | undefined;
  let ended = false;

  const ensureTurn = (turnId: string): Turn => {
    const existing = turns.get(turnId);
    if (existing) return existing;
    const turn: Turn = { reply: "", interrupted: false, settled: false };
    turns.set(turnId, turn);
    if (turns.size > TRANSCRIPT_LINES) {
      const oldest = turns.keys().next().value;
      if (oldest !== undefined) turns.delete(oldest);
    }
    return turn;
  };

  const settleTurn = (turn: Turn) => {
    if (turn.settled) return;
    turn.settled = true;
    if (turn.timer) clearTimeout(turn.timer);
    turn.save?.();
  };

  const writeLine = (line: LiveLine) => {
    if (disposed) return;
    const index = transcript.findIndex((item) => item.id === line.id);
    if (index >= 0) transcript[index] = line;
    else {
      const replyIndex =
        line.speaker === "you"
          ? transcript.findIndex((item) => item.id === `${line.id}:reply`)
          : -1;
      if (replyIndex >= 0) transcript.splice(replyIndex, 0, line);
      else transcript.push(line);
    }
    transcript.splice(0, Math.max(0, transcript.length - TRANSCRIPT_LINES));
    options.onTranscript([...transcript]);
  };

  const showReply = (turnId: string, turn: Turn, saying: boolean) => {
    if (!turn.reply) return;
    writeLine({
      id: `${turnId}:reply`,
      speaker: "live",
      text: turn.reply,
      ...(saying ? { pending: true } : {}),
    });
  };

  const endLive = () => {
    if (endTimer) clearTimeout(endTimer);
    if (ended || disposed) return;
    ended = true;
    options.end();
  };

  const toolRequest = (event: VoiceLiveRuntimeEvent) => {
    const callId = event.call_id;
    if (!callId) return;
    const reply = (result: Record<string, unknown>) =>
      options.send({
        type: "tool_result",
        call_id: callId,
        text: JSON.stringify(result),
      });
    if (event.tool === "end_voice_mode") {
      endAfterTurn = event.turn_id ?? latestTurnId;
      if (endTimer) clearTimeout(endTimer);
      endTimer = setTimeout(endLive, END_CAP_MS);
      reply({
        status: "done",
        detail:
          "Voice mode ends after your goodbye. Now say a very short goodbye in the user's language.",
      });
      return;
    }
    reply({ status: "failed", detail: "Unknown tool." });
  };

  const userTurn = (turnId: string, text: string) => {
    writeLine({ id: turnId, speaker: "you", text });
    options.onPartial("");
    const previous = latestTurnId ? turns.get(latestTurnId) : undefined;
    if (
      previous &&
      !previous.posted &&
      previous.text !== undefined &&
      continuesTurn(previous.text, text)
    ) {
      previous.continued = true;
      settleTurn(previous);
    } else if (previous && !previous.posted) previous.superseded = true;
    latestTurnId = turnId;
    const turn = ensureTurn(turnId);
    if (turn.text !== undefined) return;
    turn.text = text;
    turn.save = () => {
      // A turn the Human went on with is saved once, as the longer turn.
      if (turn.continued || turn.posted) return;
      turn.posted = true;
      options.save(
        turnId,
        text,
        turn.answered || turn.superseded
          ? { voice_session_id: options.voiceSessionId, turn_id: turnId }
          : undefined,
      );
    };
    if (turn.settled) turn.save();
    else turn.timer = setTimeout(() => settleTurn(turn), LIVE_TURN_SETTLE_MS);
  };

  return {
    receive(event) {
      if (disposed) return;
      if (event.type === "reply_interrupted") options.interrupt();
      if (event.type === "session_failure") {
        options.failed(event.code ?? "unknown");
        return;
      }
      // A background update the runtime said has its own bubble.
      if (event.speech_id) {
        const id = event.speech_id;
        if (event.type === "speech_started") updates.set(id, event.text ?? "");
        if (!updates.has(id)) return;
        if (event.type === "reply_delta")
          updates.set(id, (updates.get(id) ?? "") + (event.text ?? ""));
        else if (event.type === "reply_done" && event.text)
          updates.set(id, event.text);
        const words = updates.get(id) ?? "";
        if (words) writeLine({ id, speaker: "live", text: words });
        if (event.type === "reply_done" || event.type === "reply_interrupted")
          updates.delete(id);
        return;
      }
      if (event.type === "user_partial") {
        if (event.turn_id) ensureTurn(event.turn_id);
        options.onPartial(event.text ?? "");
        return;
      }
      if (event.type === "user_turn") {
        if (event.turn_id) userTurn(event.turn_id, event.text ?? "");
        return;
      }
      if (event.type === "tool_request") {
        toolRequest(event);
        return;
      }
      if (
        endAfterTurn &&
        event.turn_id === endAfterTurn &&
        (event.type === "playout_done" || event.type === "reply_interrupted")
      ) {
        if (endTimer) clearTimeout(endTimer);
        endTimer = setTimeout(endLive, END_TAIL_MS);
      }
      if (event.type === "playout_done" || !event.turn_id) return;
      const turn =
        event.type === "reply_delta" || event.type === "reply_done"
          ? ensureTurn(event.turn_id)
          : turns.get(event.turn_id);
      if (!turn) return;
      turn.answered = true;
      if (event.type === "reply_interrupted") {
        turn.interrupted = true;
        settleTurn(turn);
        showReply(event.turn_id, turn, false);
        return;
      }
      if (event.type === "reply_done") {
        if (!turn.interrupted && event.text) turn.reply = event.text;
        settleTurn(turn);
        showReply(event.turn_id, turn, false);
        return;
      }
      if (turn.interrupted) return;
      if (event.type === "reply_delta") {
        turn.reply += event.text ?? "";
        showReply(event.turn_id, turn, true);
      }
    },
    settle() {
      for (const turn of turns.values()) settleTurn(turn);
    },
    dispose() {
      for (const turn of turns.values()) settleTurn(turn);
      disposed = true;
      if (endTimer) clearTimeout(endTimer);
    },
  };
}
