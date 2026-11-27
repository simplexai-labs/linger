import { describe, expect, it } from "vitest";

import {
  FRAME_SAMPLES,
  FrameChunker,
  encodeFrame,
  float32ToInt16,
  int16BytesToFloat32,
  resample,
  rms,
} from "./pcm";

describe("float32ToInt16", () => {
  it("scales, rounds and clamps samples", () => {
    expect(
      Array.from(
        float32ToInt16(new Float32Array([0, 1, -1, 0.5, -0.5, 2, -3])),
      ),
    ).toEqual([0, 32767, -32768, 16384, -16384, 32767, -32768]);
  });
});

describe("int16BytesToFloat32", () => {
  it("decodes little-endian samples", () => {
    const bytes = new Uint8Array([0x00, 0x40, 0x00, 0xc0, 0xff, 0x7f]);
    const samples = int16BytesToFloat32(bytes);
    expect(samples[0]).toBeCloseTo(0.5);
    expect(samples[1]).toBeCloseTo(-0.5);
    expect(samples[2]).toBeCloseTo(32767 / 32768);
  });
});

describe("resample", () => {
  it("keeps the input at the same rate and halves its length at half the rate", () => {
    const input = new Float32Array([0, 0.5, 1, 0.5]);
    expect(resample(input, 24_000, 24_000)).toBe(input);
    expect(Array.from(resample(input, 48_000, 24_000))).toEqual([0, 1]);
  });
});

describe("rms", () => {
  it("measures full scale and silence", () => {
    expect(rms(new Int16Array(10))).toBe(0);
    expect(rms(new Float32Array([1, -1]))).toBe(1);
  });
});

describe("FrameChunker", () => {
  it("cuts arbitrary blocks into whole frames and flushes the rest", () => {
    const chunker = new FrameChunker();
    const block = (length: number, start: number) =>
      Int16Array.from({ length }, (_, index) => start + index);
    const half = FRAME_SAMPLES / 2;
    expect(chunker.push(block(half, 0))).toEqual([]);
    const frames = chunker.push(block(2 * FRAME_SAMPLES, half));
    expect(frames).toHaveLength(2);
    expect(frames[0]).toHaveLength(FRAME_SAMPLES);
    expect(frames[0]![0]).toBe(0);
    expect(frames[1]![0]).toBe(FRAME_SAMPLES);
    expect(frames[1]![FRAME_SAMPLES - 1]).toBe(2 * FRAME_SAMPLES - 1);
    const rest = chunker.flush();
    expect(rest).toHaveLength(half);
    expect(rest![0]).toBe(2 * FRAME_SAMPLES);
    expect(chunker.flush()).toBeUndefined();
  });
});

describe("encodeFrame", () => {
  it("writes a big-endian sequence number before little-endian samples", () => {
    const bytes = encodeFrame(0x01020304, new Int16Array([1, -1]));
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 1, 0, 0xff, 0xff]);
  });
});
