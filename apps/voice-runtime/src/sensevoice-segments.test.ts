import { describe, expect, it } from "vitest";
import {
  findSegmentCut,
  joinSegmentTexts,
  sampleRate,
  segmentMaxSamples,
} from "./sensevoice-segments.js";

function tone(samples: number, amplitude = 8_000) {
  return Int16Array.from({ length: samples }, (_, index) =>
    index % 2 ? amplitude : -amplitude,
  );
}

describe("findSegmentCut", () => {
  it("cuts in the middle of the quietest frame of the last five seconds", () => {
    const audio = tone(segmentMaxSamples);
    // A silent 50 ms frame, 3 s before the end.
    const silenceStart = segmentMaxSamples - 3 * sampleRate;
    audio.fill(0, silenceStart, silenceStart + 800);
    expect(findSegmentCut(audio)).toBe(silenceStart + 400);
  });

  it("takes the latest of equally quiet frames", () => {
    const audio = new Int16Array(segmentMaxSamples);
    expect(findSegmentCut(audio)).toBe(segmentMaxSamples - 400);
  });

  it("ignores silence before the last five seconds", () => {
    const audio = tone(segmentMaxSamples);
    audio.fill(0, 1_000, 1_800);
    expect(findSegmentCut(audio)).toBeGreaterThan(
      segmentMaxSamples - 5 * sampleRate,
    );
  });

  it("cuts at the end when the audio is too short to compare frames", () => {
    expect(findSegmentCut(new Int16Array(1_000))).toBe(1_000);
  });
});

describe("joinSegmentTexts", () => {
  it("joins unspaced scripts directly", () => {
    expect(joinSegmentTexts(["きょう", "いい"])).toBe("きょういい");
  });

  it("separates ASCII words and words after sentence punctuation", () => {
    expect(joinSegmentTexts(["open the", "file", "Done.", "Next"])).toBe(
      "open the file Done. Next",
    );
  });

  it("adds no space after unspaced text or before punctuation", () => {
    expect(joinSegmentTexts(["あ", "ok", ",", "yes"])).toBe("あok, yes");
  });

  it("skips blank segments", () => {
    expect(joinSegmentTexts(["  ", "a", "", "b"])).toBe("a b");
  });
});
