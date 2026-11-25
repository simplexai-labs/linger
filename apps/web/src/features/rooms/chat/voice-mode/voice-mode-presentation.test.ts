import { describe, expect, it } from "vitest";
import {
  voiceModeStatusLabel,
  voiceWindowStatus,
  type VoiceModePresentation,
} from "./voice-mode-presentation";

describe("Voice Mode visible status", () => {
  it.each<[Partial<VoiceModePresentation>, string]>([
    [{ status: "connecting" }, "Connecting microphone…"],
    [{ status: "listening" }, "Listening · Sends when you finish speaking"],
    [
      { status: "listening", flushing: true },
      "Finishing this message… You can keep speaking",
    ],
    [
      { status: "listening", sending: true },
      "Sending message… You can keep speaking",
    ],
    [
      { status: "closing", sending: true },
      "Microphone off · Finishing last words…",
    ],
    [{ status: "error" }, "Voice input stopped · Exit to review your draft"],
    [
      { error: "Connection lost. Your draft is kept." },
      "Connection lost. Your draft is kept.",
    ],
    [{ entered: false, status: "paused" }, "Microphone off · Draft kept"],
  ])("describes real state %j", (state, label) => {
    expect(voiceModeStatusLabel({ entered: true, text: "", ...state })).toBe(
      label,
    );
  });
});

describe("Voice Mode window status", () => {
  it.each<
    [
      Partial<VoiceModePresentation>,
      { muted?: boolean; waking?: boolean },
      string,
    ]
  >([
    [{ status: "connecting" }, {}, "Waking up"],
    // The microphone is heard, but the live model has not connected yet.
    [{ status: "listening" }, { waking: true }, "Waking up"],
    [{ status: "listening" }, { waking: false }, "Listening"],
    [{ status: "listening" }, {}, "Listening"],
    [{ status: "listening" }, { muted: true }, "Mic off"],
    [{ status: "listening", sending: true }, {}, "Sending…"],
    [{ status: "closing" }, {}, "Finishing…"],
    [{ status: "error" }, {}, "Stopped"],
    [{ entered: false, status: "paused" }, {}, "Paused"],
  ])("says %j %j in one line", (state, call, label) => {
    expect(
      voiceWindowStatus(
        { entered: true, text: "", ...state },
        { muted: false, ...call },
      ).source,
    ).toBe(label);
  });
});
