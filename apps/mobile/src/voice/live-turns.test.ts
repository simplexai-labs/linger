import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  END_CAP_MS,
  END_TAIL_MS,
  LIVE_TURN_SETTLE_MS,
  continuesTurn,
  createLiveTurns,
  type LiveTurnsOptions,
} from "./live-turns";

function setup() {
  const options = {
    voiceSessionId: "vs_1",
    send: vi.fn(),
    save: vi.fn(),
    onTranscript: vi.fn(),
    onPartial: vi.fn(),
    interrupt: vi.fn(),
    end: vi.fn(),
    failed: vi.fn(),
  } satisfies LiveTurnsOptions;
  return { options, turns: createLiveTurns(options) };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createLiveTurns", () => {
  it("saves an answered turn once its reply is done, with the live marker", () => {
    const { options, turns } = setup();
    turns.receive({ type: "user_turn", turn_id: "t1", text: "Bonjour" });
    expect(options.save).not.toHaveBeenCalled();
    turns.receive({ type: "reply_delta", turn_id: "t1", text: "Salut" });
    turns.receive({ type: "reply_done", turn_id: "t1", text: "Salut !" });
    expect(options.save).toHaveBeenCalledWith("t1", "Bonjour", {
      voice_session_id: "vs_1",
      turn_id: "t1",
    });
    expect(options.onTranscript).toHaveBeenLastCalledWith([
      { id: "t1", speaker: "you", text: "Bonjour" },
      { id: "t1:reply", speaker: "live", text: "Salut !" },
    ]);
  });

  it("saves an unanswered turn without the marker after the settle window", () => {
    const { options, turns } = setup();
    turns.receive({ type: "user_turn", turn_id: "t1", text: "Note this" });
    vi.advanceTimersByTime(LIVE_TURN_SETTLE_MS);
    expect(options.save).toHaveBeenCalledWith("t1", "Note this", undefined);
  });

  it("saves a continued turn only as the longer one", () => {
    const { options, turns } = setup();
    turns.receive({ type: "user_turn", turn_id: "t1", text: "Call Ana" });
    turns.receive({
      type: "user_turn",
      turn_id: "t2",
      text: "Call Ana tomorrow",
    });
    turns.settle();
    expect(options.save).toHaveBeenCalledTimes(1);
    expect(options.save).toHaveBeenCalledWith(
      "t2",
      "Call Ana tomorrow",
      undefined,
    );
  });

  it("stops playback on an interruption", () => {
    const { options, turns } = setup();
    turns.receive({ type: "reply_interrupted", turn_id: "t1" });
    expect(options.interrupt).toHaveBeenCalled();
  });

  it("answers page tools as unsupported", () => {
    const { options, turns } = setup();
    turns.receive({ type: "tool_request", call_id: "c1", tool: "read_page" });
    expect(options.send).toHaveBeenCalledWith({
      type: "tool_result",
      call_id: "c1",
      text: JSON.stringify({ status: "failed", detail: "Unknown tool." }),
    });
  });

  it("ends after the goodbye has played, or at the cap", () => {
    const { options, turns } = setup();
    turns.receive({ type: "user_turn", turn_id: "t1", text: "Bye" });
    turns.receive({
      type: "tool_request",
      call_id: "c1",
      tool: "end_voice_mode",
      turn_id: "t1",
    });
    expect(
      JSON.parse(String(options.send.mock.calls[0]?.[0]?.text)),
    ).toMatchObject({ status: "done" });
    turns.receive({ type: "playout_done", turn_id: "t1" });
    vi.advanceTimersByTime(END_TAIL_MS);
    expect(options.end).toHaveBeenCalledTimes(1);

    const second = setup();
    second.turns.receive({
      type: "tool_request",
      call_id: "c2",
      tool: "end_voice_mode",
    });
    vi.advanceTimersByTime(END_CAP_MS);
    expect(second.options.end).toHaveBeenCalledTimes(1);
  });
});

describe("continuesTurn", () => {
  it("ignores punctuation and case", () => {
    expect(continuesTurn("Call Ana.", "call ana, tomorrow")).toBe(true);
    expect(continuesTurn("Call Ana", "Email Bo")).toBe(false);
  });
});
