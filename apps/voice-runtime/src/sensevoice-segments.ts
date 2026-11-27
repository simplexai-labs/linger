// Cutting a long dictation into recognizer-sized segments. SenseVoice stays
// accurate within about 30 seconds of audio, so a segment never grows past it.
export const sampleRate = 16_000;
export const segmentMaxSamples = 30 * sampleRate;
// A full segment is cut where it is quietest within its last few seconds, so
// a word is not split in two.
const segmentSnapSamples = 5 * sampleRate;
const segmentFrameSamples = (50 * sampleRate) / 1000;

/**
 * Returns the sample index at which to end a full segment: the middle of the
 * lowest-energy 50 ms frame in the last five seconds. Among equally quiet
 * frames the latest wins, which keeps the segment long. A window too short to
 * compare frames cuts at the end.
 */
export function findSegmentCut(samples: Int16Array): number {
  const total = samples.length;
  const window = Math.min(total, segmentSnapSamples);
  if (window < segmentFrameSamples * 2) return total;
  const start = total - window;
  const frames = Math.floor(window / segmentFrameSamples);
  const energy: number[] = [];
  for (let frame = 0; frame < frames; frame++) {
    const from = start + frame * segmentFrameSamples;
    let sum = 0;
    for (let index = from; index < from + segmentFrameSamples; index++) {
      const sample = samples[index] ?? 0;
      sum += sample * sample;
    }
    energy.push(Math.sqrt(sum / segmentFrameSamples));
  }
  const threshold = Math.min(...energy) * 1.0001 + 1e-6;
  let quietest = 0;
  for (let frame = 0; frame < frames; frame++)
    if ((energy[frame] ?? Infinity) <= threshold) quietest = frame;
  return Math.max(
    1,
    start +
      quietest * segmentFrameSamples +
      Math.floor(segmentFrameSamples / 2),
  );
}

const asciiWordCharacter = /^[A-Za-z0-9]$/u;

/**
 * Joins segment texts into one text: directly, except that a space goes
 * between an ASCII word and a following ASCII word, and after sentence
 * punctuation before one, because only those boundaries need it.
 */
export function joinSegmentTexts(parts: readonly string[]): string {
  let joined = "";
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    const first = part[0] ?? "";
    const last = joined.at(-1) ?? "";
    if (
      joined &&
      asciiWordCharacter.test(first) &&
      (asciiWordCharacter.test(last) || ".,!?;:".includes(last))
    )
      joined += " ";
    joined += part;
  }
  return joined;
}
