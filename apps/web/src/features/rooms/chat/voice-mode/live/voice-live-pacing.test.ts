import { afterEach, describe, expect, it } from "vitest";

import {
  advancePacedText,
  learnVoicePace,
  resetVoicePace,
  voicePace,
  type PacedTextState,
} from "./voice-live-pacing";

const start: PacedTextState = {
  shown: 0,
  audibleMs: 0,
  quietMs: 0,
  finishing: false,
};

function run(
  state: PacedTextState,
  frames: number,
  frame: Partial<Parameters<typeof advancePacedText>[1]>,
) {
  let next = state;
  for (let index = 0; index < frames; index++)
    next = advancePacedText(next, {
      length: 100,
      pacing: "speaking",
      elapsedMs: 50,
      audible: true,
      rate: 10,
      ...frame,
    });
  return next;
}

afterEach(resetVoicePace);

describe("live subtitle pacing", () => {
  it("reveals words only while the voice is audible, at the voice's pace", () => {
    const heard = run(start, 20, {});
    expect(heard.shown).toBeCloseTo(10);
    expect(heard.audibleMs).toBe(1_000);
    expect(run(heard, 20, { audible: false }).shown).toBeCloseTo(10);
  });

  it("shows the rest at once when the voice has ended", () => {
    const heard = run(start, 20, {});
    const ended = run(heard, 4, { pacing: undefined });
    expect(ended.finishing).toBe(true);
    expect(ended.shown).toBe(100);
  });

  it("keeps only what was shown when the reply is cut off", () => {
    const heard = run(start, 20, {});
    expect(run(heard, 40, { pacing: "cut" }).shown).toBeCloseTo(10);
  });

  it("finishes a said reply once it has fallen quiet", () => {
    const heard = run(start, 20, { pacing: "said" });
    expect(
      run(heard, 10, { pacing: "said", audible: false }).shown,
    ).toBeCloseTo(10);
    expect(run(heard, 20, { pacing: "said", audible: false }).shown).toBe(100);
  });

  it("paces a reply again when it goes on after a tool round", () => {
    const ended = run(run(start, 20, {}), 4, { pacing: undefined, length: 10 });
    const resumed = run(ended, 10, { length: 40 });
    expect(resumed.finishing).toBe(false);
    expect(resumed.shown).toBeCloseTo(15);
  });

  it("learns the pace from replies heard to the end, never too short ones", () => {
    learnVoicePace(60, 500);
    expect(voicePace()).toBe(7);
    learnVoicePace(60, 4_000);
    expect(voicePace()).toBe(11);
  });
});
