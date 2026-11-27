import { sampleRate } from "./sensevoice-segments.js";

/** How long a pause after speech ends the turn, as Soniox's endpoint does. */
export const endpointSilenceMs = 1_000;

const minSpeechMs = 300;
// Loudness is measured over blocks this long, as a fraction of full scale.
const blockSamples = (100 * sampleRate) / 1000;
// A block is speech when it is this loud and well above the quiet blocks
// heard lately, which stand for the room's noise.
const speechLevel = 0.01;
const speechOverNoise = 3;
const noiseWindowBlocks = 100;
const noiseQuantile = 0.2;
const quantileFromBlocks = 20;

/**
 * Hears the end of a spoken turn by loudness alone, so it serves any language
 * and needs no second model: speech was heard, then a pause lasted long enough.
 * The model that transcribes is offline and reports no endpoint of its own.
 */
export class EndpointDetector {
  #energy = 0;
  #count = 0;
  #levels: number[] = [];
  #speechSamples = 0;
  #silentSamples = 0;

  /** Feeds samples; true once speech was followed by a long enough pause. */
  push(frame: Int16Array): boolean {
    let ended = false;
    for (const sample of frame) {
      const value = sample / 32768;
      this.#energy += value * value;
      if (++this.#count === blockSamples && this.#endBlock()) ended = true;
    }
    return ended;
  }

  /** Forgets the speech heard so far; the next turn starts from silence. */
  reset() {
    this.#speechSamples = 0;
    this.#silentSamples = 0;
  }

  #endBlock() {
    const level = Math.sqrt(this.#energy / this.#count);
    this.#energy = 0;
    this.#count = 0;
    this.#levels.push(level);
    if (this.#levels.length > noiseWindowBlocks) this.#levels.shift();
    // A low quantile, not the minimum: a microphone that gates its pauses to
    // digital silence must not make the room's own noise sound like speech.
    // Until enough has been heard for a quantile to mean anything, the
    // quietest block stands for the noise.
    const sorted = [...this.#levels].sort((a, b) => a - b);
    const noise =
      sorted[
        sorted.length < quantileFromBlocks
          ? 0
          : Math.floor(sorted.length * noiseQuantile)
      ] ?? 0;
    if (level > speechLevel && level > noise * speechOverNoise) {
      this.#speechSamples += blockSamples;
      this.#silentSamples = 0;
    } else this.#silentSamples += blockSamples;
    return (
      this.#speechSamples >= (minSpeechMs * sampleRate) / 1000 &&
      this.#silentSamples >= (endpointSilenceMs * sampleRate) / 1000
    );
  }
}
