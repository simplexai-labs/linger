import { asError } from "@linger/service-kit";

import {
  transcriptCharacters,
  type ASRProvider,
  type ASRStream,
} from "./asr.js";
import { ASREventQueue } from "./event-queue.js";
import { EndpointDetector } from "./sensevoice-endpoint.js";
import {
  findSegmentCut,
  joinSegmentTexts,
  sampleRate,
  segmentMaxSamples,
} from "./sensevoice-segments.js";

export interface SenseVoiceRecognizer {
  /** Transcribes one mono 16 kHz recording. */
  decode(samples: Float32Array): Promise<string>;
}

/**
 * Rewrites one closed segment's text. A rejection, an abort or a blank answer
 * keeps the recognizer's text, so dictation never fails because a rewrite did.
 */
export type SegmentPolisher = (
  text: string,
  signal: AbortSignal,
) => Promise<string>;

export interface SenseVoiceProviderOptions {
  recognizer: () => Promise<SenseVoiceRecognizer>;
  polish?: SegmentPolisher;
  now?: () => number;
}

// The model is offline, so a partial re-decodes the open segment from its
// start; each decode waits for at least this much new audio.
const decodeIntervalFloor = (1_200 * sampleRate) / 1000;
// A decode that takes d seconds waits for 2d seconds of new audio before the
// next one, which keeps partial decoding at or below half of real time.
const decodeLoadBudget = 0.5;

export class SenseVoiceASRProvider implements ASRProvider {
  readonly #options: SenseVoiceProviderOptions;

  constructor(options: SenseVoiceProviderOptions) {
    this.#options = options;
  }

  /** Segments of one turn are one text, not one line each. */
  joinFinals(parts: readonly string[]): string {
    return joinSegmentTexts(parts);
  }

  async open(signal: AbortSignal): Promise<ASRStream> {
    const stream = new SenseVoiceASRStream(
      await this.#options.recognizer(),
      this.#options.polish,
      this.#options.now ?? (() => performance.now()),
    );
    signal.addEventListener("abort", () => void stream.close(), { once: true });
    return stream;
  }
}

/** What follows a closed segment's final: a pause the stream heard, a commit's
 * acknowledgement, or nothing when more of the turn may follow. */
type SegmentEnd = "utterance_end" | "finalization_ack";

interface ClosedSegment {
  raw: string;
  startMs: number;
  endMs: number;
  text: Promise<string>;
}

class SenseVoiceASRStream implements ASRStream {
  readonly #queue = new ASREventQueue();
  readonly #aborted = new AbortController();
  readonly #recognizer: SenseVoiceRecognizer;
  readonly #polisher: SegmentPolisher | undefined;
  readonly #now: () => number;
  // The open segment: audio since the last cut, in arrival order.
  #chunks: Int16Array[] = [];
  #segmentSamples = 0;
  #segmentStart = 0;
  #segmentId = 0;
  #total = 0;
  #decodeInterval = decodeIntervalFloor;
  #partialAt = 0;
  #partialBusy = false;
  #endpoint = new EndpointDetector();
  #lastPartial: { segmentId: number; text: string } | undefined;
  // One recognizer serves the stream, so decodes run one after another.
  #decoding: Promise<unknown> = Promise.resolve();
  // Finals leave in segment order, each after its rewrite.
  #emitting: Promise<void> = Promise.resolve();
  // Closed segments whose final has not gone out; partials still show them.
  #unflushed: ClosedSegment[] = [];
  #failure: unknown;
  #finished = false;
  #closed = false;

  constructor(
    recognizer: SenseVoiceRecognizer,
    polisher: SegmentPolisher | undefined,
    now: () => number,
  ) {
    this.#recognizer = recognizer;
    this.#polisher = polisher;
    this.#now = now;
  }

  async sendPCM(frame: Int16Array): Promise<void> {
    this.#assertOpen();
    if (frame.length === 0) return;
    // The caller reuses its frame buffer.
    this.#chunks.push(frame.slice());
    this.#segmentSamples += frame.length;
    this.#total += frame.length;
    const paused = this.#endpoint.push(frame);
    try {
      await this.#closeFullSegments();
      // The speaker paused: the turn ends here, as with a manual commit, and
      // the audio that follows starts the next one.
      if (paused) {
        this.#endpoint.reset();
        this.#closeOpenSegment("utterance_end").catch(() => undefined);
      }
      this.#requestPartial();
    } catch (error) {
      throw this.#fail(error);
    }
  }

  // A manual commit ends the open segment now. The acknowledgement follows
  // the segment's final, which may wait for its rewrite, while audio goes on
  // into the next segment.
  async finalize(): Promise<void> {
    this.#assertOpen();
    this.#endpoint.reset();
    this.#closeOpenSegment("finalization_ack").catch(() => undefined);
  }

  async finish(): Promise<void> {
    if (this.#finished) return;
    this.#assertNotClosed();
    this.#finished = true;
    try {
      await this.#closeOpenSegment(undefined);
      await this.#emitting;
    } catch (error) {
      throw this.#fail(error);
    }
    this.#queue.end();
  }

  events() {
    return this.#queue.events();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#aborted.abort();
    this.#queue.end();
  }

  #assertNotClosed() {
    if (this.#failure) throw asError(this.#failure);
    if (this.#closed) throw new Error("SenseVoice stream is closed");
  }

  #assertOpen() {
    this.#assertNotClosed();
    if (this.#finished) throw new Error("SenseVoice stream is finished");
  }

  #fail(error: unknown) {
    this.#failure ??= error;
    this.#queue.fail(this.#failure);
    return this.#failure;
  }

  #openAudio(): Int16Array {
    const audio = new Int16Array(this.#segmentSamples);
    let offset = 0;
    for (const chunk of this.#chunks) {
      audio.set(chunk, offset);
      offset += chunk.length;
    }
    return audio;
  }

  // The leftover audio of a cut starts the next segment.
  #startSegment(leftover: Int16Array, startSample: number) {
    this.#chunks = leftover.length ? [leftover] : [];
    this.#segmentSamples = leftover.length;
    this.#segmentStart = startSample;
    this.#segmentId += 1;
    this.#partialAt = startSample;
  }

  async #closeFullSegments() {
    while (this.#segmentSamples >= segmentMaxSamples) {
      const audio = this.#openAudio();
      const startSample = this.#segmentStart;
      const cut = findSegmentCut(audio.subarray(0, segmentMaxSamples));
      this.#startSegment(audio.slice(cut), startSample + cut);
      // Waiting for the decode alone holds audio back when the machine cannot
      // keep up with speech; a rewrite never does.
      await this.#closeSegment(
        audio.slice(0, cut),
        startSample,
        startSample + cut,
        undefined,
      );
    }
  }

  #closeOpenSegment(end: SegmentEnd | undefined): Promise<void> {
    const audio = this.#openAudio();
    const startSample = this.#segmentStart;
    this.#startSegment(new Int16Array(0), this.#total);
    return this.#closeSegment(audio, startSample, this.#total, end);
  }

  // Queues the decode and the ordered emission of one closed segment, and
  // resolves when the decode is done.
  #closeSegment(
    audio: Int16Array,
    startSample: number,
    endSample: number,
    end: SegmentEnd | undefined,
  ): Promise<void> {
    const segmentId = this.#segmentId - 1;
    const startMs = milliseconds(startSample);
    const endMs = milliseconds(endSample);
    const decoded = (
      audio.length
        ? this.#decode(audio).then(({ text }) => text)
        : Promise.resolve("")
    ).then((text): ClosedSegment | undefined => {
      // A partial that heard speech where the full decode hears none would
      // leave the turn unconfirmed, so the heard text is kept.
      const heard =
        this.#lastPartial?.segmentId === segmentId
          ? this.#lastPartial.text
          : "";
      const raw = meaningful(text) ? text : heard;
      if (!meaningful(raw)) return undefined;
      const closed = { raw, startMs, endMs, text: this.#rewrite(raw) };
      this.#unflushed.push(closed);
      return closed;
    });
    this.#emitting = this.#emitting
      .then(async () => {
        const closed = await decoded;
        if (closed) {
          const text = await closed.text;
          this.#unflushed.splice(this.#unflushed.indexOf(closed), 1);
          this.#queue.push({
            kind: "final",
            startOffsetMs: closed.startMs,
            endOffsetMs: closed.endMs,
            text,
          });
        }
        if (end)
          this.#queue.push({
            kind: end,
            startOffsetMs: endMs,
            endOffsetMs: endMs,
          });
      })
      .catch((error: unknown) => {
        this.#fail(error);
      });
    return decoded.then(() => undefined);
  }

  #rewrite(raw: string): Promise<string> {
    if (!this.#polisher) return Promise.resolve(raw);
    return this.#polisher(raw, this.#aborted.signal).then(
      (text) => text.trim() || raw,
      () => raw,
    );
  }

  #decode(audio: Int16Array) {
    const samples = Float32Array.from(audio, (value) => value / 32768);
    const run = this.#decoding.then(async () => {
      const started = this.#now();
      const text = (await this.#recognizer.decode(samples)).trim();
      return { text, elapsedMs: this.#now() - started };
    });
    this.#decoding = run.catch(() => undefined);
    return run;
  }

  #requestPartial() {
    if (
      this.#partialBusy ||
      this.#segmentSamples === 0 ||
      this.#total - this.#partialAt < this.#decodeInterval
    )
      return;
    this.#partialBusy = true;
    this.#partialAt = this.#total;
    const segmentId = this.#segmentId;
    const startSample = this.#segmentStart;
    const endSample = this.#total;
    void this.#decode(this.#openAudio())
      .then(({ text, elapsedMs }) => {
        this.#decodeInterval = Math.max(
          decodeIntervalFloor,
          Math.floor((elapsedMs / 1000 / decodeLoadBudget) * sampleRate),
        );
        // A cut or a finish has already settled this segment.
        if (
          segmentId !== this.#segmentId ||
          this.#finished ||
          this.#closed ||
          !meaningful(text)
        )
          return;
        this.#lastPartial = { segmentId, text };
        const earlier = this.#unflushed.map((closed) => closed.raw);
        this.#queue.push({
          kind: "partial",
          startOffsetMs:
            this.#unflushed[0]?.startMs ?? milliseconds(startSample),
          endOffsetMs: milliseconds(endSample),
          text: joinSegmentTexts([...earlier, text]),
        });
      })
      .catch((error: unknown) => {
        this.#fail(error);
      })
      .finally(() => {
        this.#partialBusy = false;
      });
  }
}

function meaningful(text: string) {
  return transcriptCharacters(text).length > 0;
}

function milliseconds(samples: number) {
  return Math.round((samples * 1000) / sampleRate);
}
