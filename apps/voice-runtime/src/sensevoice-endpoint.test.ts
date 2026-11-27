import { describe, expect, it } from "vitest";

import { EndpointDetector, endpointSilenceMs } from "./sensevoice-endpoint.js";
import { sampleRate } from "./sensevoice-segments.js";

/** A square wave, loud like speech at 8000 and as quiet as a room at 100. */
function tone(ms: number, amplitude: number) {
  const samples = new Int16Array((ms * sampleRate) / 1000);
  for (let index = 0; index < samples.length; index++)
    samples[index] = Math.floor(index / 40) % 2 ? amplitude : -amplitude;
  return samples;
}

/** Feeds audio in frames of `frameMs` and returns when, in ms, it ended. */
function endedAt(
  detector: EndpointDetector,
  audio: Int16Array,
  frameMs = 20,
): number | undefined {
  const frame = (frameMs * sampleRate) / 1000;
  for (let offset = 0; offset < audio.length; offset += frame)
    if (detector.push(audio.subarray(offset, offset + frame)))
      return ((offset + frame) * 1000) / sampleRate;
  return undefined;
}

function concat(...parts: Int16Array[]) {
  const all = new Int16Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    all.set(part, offset);
    offset += part.length;
  }
  return all;
}

const speech = concat(tone(300, 8000), tone(100, 0), tone(300, 8000));

describe("EndpointDetector", () => {
  it("ends a turn once a pause outlasts the endpoint after speech", () => {
    const at = endedAt(
      new EndpointDetector(),
      concat(tone(500, 0), speech, tone(2_000, 0)),
    );
    // Speech ends at 1.2 s; the end is heard one pause later, to the block.
    expect(at).toBeGreaterThanOrEqual(1_200 + endpointSilenceMs);
    expect(at).toBeLessThanOrEqual(1_200 + endpointSilenceMs + 200);
  });

  it("does not end on a pause inside the speech", () => {
    expect(
      endedAt(
        new EndpointDetector(),
        concat(speech, tone(700, 0), speech, tone(700, 0), speech),
      ),
    ).toBeUndefined();
  });

  it("does not end on silence nobody spoke in", () => {
    expect(endedAt(new EndpointDetector(), tone(10_000, 0))).toBeUndefined();
  });

  it("does not end on a click shorter than speech", () => {
    expect(
      endedAt(
        new EndpointDetector(),
        concat(tone(300, 0), tone(100, 8000), tone(3_000, 0)),
      ),
    ).toBeUndefined();
  });

  it("hears speech over steady room noise and ignores the noise alone", () => {
    const noise = tone(2_000, 650);
    expect(endedAt(new EndpointDetector(), noise)).toBeUndefined();
    expect(
      endedAt(new EndpointDetector(), concat(noise, speech, noise)),
    ).toBeDefined();
  });

  it("gives the same answer whatever the frame size", () => {
    const audio = concat(tone(500, 0), speech, tone(2_000, 0));
    const results = [10, 20, 100].map((frameMs) =>
      endedAt(new EndpointDetector(), audio, frameMs),
    );
    for (const result of results) {
      expect(result).toBeDefined();
      expect(Math.abs((result ?? 0) - (results[0] ?? 0))).toBeLessThanOrEqual(
        100,
      );
    }
  });

  it("starts the next turn from silence after a reset", () => {
    const detector = new EndpointDetector();
    expect(endedAt(detector, concat(speech, tone(2_000, 0)))).toBeDefined();
    detector.reset();
    expect(endedAt(detector, tone(3_000, 0))).toBeUndefined();
    expect(endedAt(detector, concat(speech, tone(2_000, 0)))).toBeDefined();
  });
});
