// PCM helpers for the Voice Bridge: the microphone delivers Float32 samples,
// the Bridge takes 20 ms frames of signed 16-bit little-endian mono at
// 24 kHz, and Live reply audio comes back in that format too.

export const BRIDGE_SAMPLE_RATE = 24_000;
/**
 * One uplink frame is 20 ms: the phone sends audio as soon as it has it, so a
 * word reaches the computer about 20 ms after it is spoken, not 100.
 */
export const FRAME_MS = 20;
/** Samples in one uplink frame. */
export const FRAME_SAMPLES = (BRIDGE_SAMPLE_RATE * FRAME_MS) / 1_000;

/** Clamps each sample to [-1, 1] and scales it to a signed 16-bit integer. */
export function float32ToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index] ?? 0));
    out[index] =
      sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
  }
  return out;
}

/** Decodes signed 16-bit little-endian PCM bytes into Float32 samples. */
export function int16BytesToFloat32(
  bytes: Uint8Array,
): Float32Array<ArrayBuffer> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(Math.floor(bytes.byteLength / 2));
  for (let index = 0; index < out.length; index += 1)
    out[index] = view.getInt16(index * 2, true) / 0x8000;
  return out;
}

/**
 * Linear resampling. The recorder delivers the rate it was asked for when
 * the device can, so this only runs when a device cannot.
 */
export function resample(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const length = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const out = new Float32Array(length);
  const step = fromRate / toRate;
  for (let index = 0; index < length; index += 1) {
    const position = index * step;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const fraction = position - left;
    const a = input[Math.min(left, input.length - 1)] ?? 0;
    const b = input[right] ?? 0;
    out[index] = a + (b - a) * fraction;
  }
  return out;
}

/** Root mean square of a block, 0 to 1, for level meters. */
export function rms(samples: Int16Array | Float32Array): number {
  if (samples.length === 0) return 0;
  const scale = samples instanceof Int16Array ? 0x8000 : 1;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = (samples[index] ?? 0) / scale;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}

/** Cuts a stream of samples into whole frames. */
export class FrameChunker {
  #pending = new Int16Array(FRAME_SAMPLES);
  #filled = 0;

  /** Returns every frame the new samples completed, in order. */
  push(samples: Int16Array): Int16Array[] {
    const frames: Int16Array[] = [];
    let offset = 0;
    while (offset < samples.length) {
      const take = Math.min(
        FRAME_SAMPLES - this.#filled,
        samples.length - offset,
      );
      this.#pending.set(samples.subarray(offset, offset + take), this.#filled);
      this.#filled += take;
      offset += take;
      if (this.#filled === FRAME_SAMPLES) {
        frames.push(this.#pending);
        this.#pending = new Int16Array(FRAME_SAMPLES);
        this.#filled = 0;
      }
    }
    return frames;
  }

  /** The samples of an unfinished frame, if any; the Bridge takes short frames. */
  flush(): Int16Array | undefined {
    if (this.#filled === 0) return undefined;
    const rest = this.#pending.slice(0, this.#filled);
    this.#pending = new Int16Array(FRAME_SAMPLES);
    this.#filled = 0;
    return rest;
  }
}

/** One uplink message: a u32 big-endian sequence number, then s16le PCM. */
export function encodeFrame(seq: number, samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(4 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, seq, false);
  for (let index = 0; index < samples.length; index += 1)
    view.setInt16(4 + index * 2, samples[index] ?? 0, true);
  return bytes;
}
