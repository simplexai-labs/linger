import { asError } from "@linger/service-kit";

import type { ASREvent, ASRProvider, ASRStream } from "./asr.js";
import { ASREventQueue } from "./event-queue.js";
import {
  SileroSpeechActivityDetector,
  type SpeechActivity,
  type SpeechActivityDetector,
} from "./voice-activity.js";
import { VoiceFailure } from "./voice-failure.js";

const SAMPLE_RATE = 16_000;
const SAMPLES_PER_MS = SAMPLE_RATE / 1_000;
const QUIET_FRAME_SAMPLES = 50 * SAMPLES_PER_MS; // 50 ms = 800 samples
const DEFAULT_PRE_ROLL_MS = 300;
const DEFAULT_PARTIAL_INTERVAL_MS = 700;
const DEFAULT_MAX_SEGMENT_MS = 22_000;
const DEFAULT_PROGRESS_INTERVAL_MS = 500;
const DEFAULT_DICTATION_SILENCE_END_MS = 1_000;
const DEFAULT_RECORDING_SILENCE_END_MS = 1_500;
const RMS_WINDOW_SAMPLES = 512;
const RMS_SPEECH_ONSET_DB = -40;
const RMS_SPEECH_HOLD_DB = -46;

export interface LocalASRRelayTarget {
  readonly url: string;
  readonly token: string;
  readonly tenantId: string;
  readonly ownerActorId: string;
  readonly computerId: string;
}

export interface LocalASRTranscribeInput {
  readonly wav: Buffer;
  readonly modelId?: string;
  readonly language?: string;
  readonly useGpu?: boolean;
  readonly keepLoadedSeconds?: number;
  readonly partial: boolean;
  readonly signal: AbortSignal;
}

export interface LocalASRTranscribeOutput {
  readonly text: string;
  readonly language?: string;
}

export type LocalASRTranscribeFn = (
  input: LocalASRTranscribeInput,
) => Promise<LocalASRTranscribeOutput>;

export interface LocalASRProviderOptions {
  readonly mode: "chat_dictation" | "hardware_control";
  readonly modelId?: string;
  readonly language?: string;
  readonly useGpu?: boolean;
  readonly keepLoadedSeconds?: number;
  readonly relay?: LocalASRRelayTarget;
  readonly directUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly transcribe?: LocalASRTranscribeFn;
  readonly createVad?: () => Promise<SpeechActivityDetector>;
  readonly silenceEndMs?: number;
  readonly partialIntervalMs?: number;
  readonly maxSegmentMs?: number;
  readonly preRollMs?: number;
  readonly progressIntervalMs?: number;
}

/** Encodes mono 16-bit signed little-endian PCM into a standard RIFF/WAVE buffer. */
export function encodePcm16Wav(
  samples: Int16Array,
  sampleRate = SAMPLE_RATE,
): Buffer {
  const dataByteLength = samples.length * 2;
  const buffer = Buffer.allocUnsafe(44 + dataByteLength);
  buffer.write("RIFF", 0, 4, "ascii");
  buffer.writeUInt32LE(36 + dataByteLength, 4);
  buffer.write("WAVE", 8, 4, "ascii");
  buffer.write("fmt ", 12, 4, "ascii");
  buffer.writeUInt32LE(16, 16); // PCM fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM linear quantization
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, 4, "ascii");
  buffer.writeUInt32LE(dataByteLength, 40);
  for (let index = 0; index < samples.length; index += 1) {
    buffer.writeInt16LE(samples[index]!, 44 + index * 2);
  }
  return buffer;
}

/** Energy-based fallback VAD used when native Silero is unavailable. */
export class RmsSpeechActivityDetector implements SpeechActivityDetector {
  private readonly window = new Int16Array(RMS_WINDOW_SAMPLES);
  private pending = 0;
  private throughSample = 0;
  private speech = false;
  private closed = false;

  async pushPCM(frame: Int16Array): Promise<SpeechActivity[]> {
    if (this.closed) throw new Error("Local ASR VAD is closed");
    const activities: SpeechActivity[] = [];
    let offset = 0;
    while (offset < frame.length) {
      const count = Math.min(
        frame.length - offset,
        this.window.length - this.pending,
      );
      this.window.set(frame.subarray(offset, offset + count), this.pending);
      this.pending += count;
      offset += count;
      if (this.pending < this.window.length) continue;
      const db = windowLevelDb(this.window);
      this.speech =
        db >= (this.speech ? RMS_SPEECH_HOLD_DB : RMS_SPEECH_ONSET_DB);
      this.throughSample += this.window.length;
      activities.push({
        throughSample: this.throughSample,
        speech: this.speech,
        levelDb: db,
      });
      this.pending = 0;
    }
    return activities;
  }

  close(): void {
    this.closed = true;
    this.window.fill(0);
  }
}

/**
 * Streams 16 kHz mono PCM through local VAD segmentation and relays WAV
 * segments to either the Runner Gateway internal transcribe endpoint or a
 * direct OpenAI-compatible local speech sidecar.
 */
export class LocalASRProvider implements ASRProvider {
  private readonly transcribeFn: LocalASRTranscribeFn;

  constructor(private readonly options: LocalASRProviderOptions) {
    if (options.transcribe) {
      this.transcribeFn = options.transcribe;
    } else if (options.relay) {
      this.transcribeFn = createRelayTranscribe(
        options.relay,
        options.fetchImpl ?? fetch,
      );
    } else if (options.directUrl) {
      this.transcribeFn = createDirectTranscribe(
        options.directUrl,
        options.fetchImpl ?? fetch,
      );
    } else {
      throw new Error(
        "LocalASRProvider requires a relay target, directUrl, or transcribe function",
      );
    }
  }

  /** Resolves promptly without waiting for a cold local speech model load. */
  async open(signal: AbortSignal): Promise<ASRStream> {
    signal.throwIfAborted();
    const vad = await openVad(this.options.createVad);
    if (signal.aborted) {
      vad.close();
      signal.throwIfAborted();
    }
    return new LocalASRStream(this.options, this.transcribeFn, vad, signal);
  }
}

class LocalASRStream implements ASRStream {
  private readonly queue = new ASREventQueue();
  private readonly controller = new AbortController();
  private readonly onCallerAbort: () => void;
  private readonly silenceEndSamples: number;
  private readonly partialIntervalSamples: number;
  private readonly maxSegmentSamples: number;
  private readonly preRollSamples: number;
  private readonly progressIntervalMs: number;

  private vadPendingChunks: Int16Array[] = [];
  private vadPendingLength = 0;
  private vadConsumedSamples = 0;
  private processedSamples = 0;
  private committedThroughSample = 0;

  private preRollChunks: Int16Array[] = [];
  private preRollLength = 0;
  private preRollStartSample = 0;

  private inSpeech = false;
  private segmentId = 0;
  private segmentStartSample = 0;
  private segmentChunks: Int16Array[] = [];
  private segmentSampleCount = 0;
  private trailingSilenceSamples = 0;
  private lastPartialSample = 0;
  private lastPartialEndMs?: number;
  private partialToken = 0;
  private partialInFlight?: Promise<void>;

  private maxFinalEndMs = 0;
  private lastProgressMs = -1;
  private serialOps: Promise<void> = Promise.resolve();
  private finishing = false;
  private closed = false;
  private failure?: unknown;
  private finishTask?: Promise<void>;

  constructor(
    private readonly options: LocalASRProviderOptions,
    private readonly transcribeFn: LocalASRTranscribeFn,
    private readonly vad: SpeechActivityDetector,
    private readonly callerSignal: AbortSignal,
  ) {
    const defaultSilenceMs =
      options.mode === "chat_dictation"
        ? DEFAULT_DICTATION_SILENCE_END_MS
        : DEFAULT_RECORDING_SILENCE_END_MS;
    this.silenceEndSamples = Math.max(
      RMS_WINDOW_SAMPLES,
      Math.round((options.silenceEndMs ?? defaultSilenceMs) * SAMPLES_PER_MS),
    );
    this.partialIntervalSamples = Math.max(
      RMS_WINDOW_SAMPLES,
      Math.round(
        (options.partialIntervalMs ?? DEFAULT_PARTIAL_INTERVAL_MS) *
          SAMPLES_PER_MS,
      ),
    );
    this.maxSegmentSamples = Math.max(
      QUIET_FRAME_SAMPLES * 4,
      Math.round(
        (options.maxSegmentMs ?? DEFAULT_MAX_SEGMENT_MS) * SAMPLES_PER_MS,
      ),
    );
    this.preRollSamples = Math.max(
      0,
      Math.round((options.preRollMs ?? DEFAULT_PRE_ROLL_MS) * SAMPLES_PER_MS),
    );
    this.progressIntervalMs = Math.max(
      50,
      options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS,
    );
    this.onCallerAbort = () => {
      this.controller.abort(callerSignal.reason);
    };
    callerSignal.addEventListener("abort", this.onCallerAbort, { once: true });
  }

  async sendPCM(frame: Int16Array): Promise<void> {
    if (this.closed || this.finishing) {
      throw new Error("Local ASR stream is closed");
    }
    if (this.failure) throw asError(this.failure);
    this.controller.signal.throwIfAborted();
    if (frame.length === 0) return;

    const copy = frame.slice();
    this.vadPendingChunks.push(copy);
    this.vadPendingLength += copy.length;

    const activities = await this.vad.pushPCM(copy);
    for (const activity of activities) {
      const count = activity.throughSample - this.vadConsumedSamples;
      if (count <= 0) continue;
      const windowSamples = this.takeVadPending(count);
      const windowStartSample = this.vadConsumedSamples;
      const windowEndSample = activity.throughSample;
      this.vadConsumedSamples = windowEndSample;
      this.processedSamples = windowEndSample;
      this.handleVadWindow(
        windowSamples,
        windowStartSample,
        windowEndSample,
        activity.speech,
      );
    }
  }

  async finalize(): Promise<void> {
    if (this.closed || this.finishing) return;
    if (this.failure) throw asError(this.failure);
    this.controller.signal.throwIfAborted();

    this.flushVadPendingIntoActiveSegment();
    if (this.inSpeech && this.segmentSampleCount > 0) {
      this.closeActiveSegment(this.processedSamples, {
        emitUtteranceEnd: false,
      });
    }
    const targetSample = this.processedSamples;
    void this.enqueueSerial(async () => {
      this.committedThroughSample = Math.max(
        this.committedThroughSample,
        targetSample,
      );
      if (this.options.mode === "chat_dictation") {
        const endMs = Math.max(samplesToMs(targetSample), this.maxFinalEndMs);
        this.queue.push({
          kind: "finalization_ack",
          startOffsetMs: endMs,
          endOffsetMs: endMs,
        });
      }
    }).catch(() => undefined);
  }

  finish(): Promise<void> {
    if (this.finishTask) return this.finishTask;
    this.finishing = true;
    this.finishTask = (async () => {
      if (this.closed) return;
      this.flushVadPendingIntoActiveSegment();
      if (this.inSpeech && this.segmentSampleCount > 0) {
        this.closeActiveSegment(this.processedSamples, {
          emitUtteranceEnd: false,
        });
      }
      const finalSample = this.processedSamples;
      const done = this.enqueueSerial(async () => {
        this.committedThroughSample = Math.max(
          this.committedThroughSample,
          finalSample,
        );
        const finalMs = Math.max(samplesToMs(finalSample), this.maxFinalEndMs);
        if (finalMs > this.lastProgressMs) {
          this.queue.push({
            kind: "progress",
            startOffsetMs: 0,
            endOffsetMs: finalMs,
            committedThroughMs: finalMs,
          });
          this.lastProgressMs = finalMs;
        }
        this.queue.end();
      });
      await done;
    })();
    return this.finishTask;
  }

  events(): AsyncIterable<ASREvent> {
    return this.queue.events();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.callerSignal.removeEventListener("abort", this.onCallerAbort);
    this.controller.abort();
    this.vad.close();
    this.queue.end();
  }

  private handleVadWindow(
    windowSamples: Int16Array,
    windowStartSample: number,
    windowEndSample: number,
    speech: boolean,
  ): void {
    if (!this.inSpeech) {
      this.appendPreRoll(windowSamples, windowStartSample);
      if (speech) {
        const segmentStart = Math.max(
          this.committedThroughSample,
          this.preRollStartSample,
        );
        const initialSamples = this.slicePreRollFrom(segmentStart);
        this.inSpeech = true;
        this.segmentId += 1;
        this.segmentStartSample = segmentStart;
        this.segmentChunks = initialSamples.length > 0 ? [initialSamples] : [];
        this.segmentSampleCount = initialSamples.length;
        this.trailingSilenceSamples = 0;
        this.lastPartialSample = windowEndSample;
        this.lastPartialEndMs = undefined;
        this.clearPreRoll();
        return;
      }
      this.committedThroughSample = Math.max(
        this.committedThroughSample,
        windowEndSample,
      );
      const committedMs = samplesToMs(this.committedThroughSample);
      if (
        (this.lastProgressMs < 0 && committedMs >= this.progressIntervalMs) ||
        (this.lastProgressMs >= 0 &&
          committedMs - this.lastProgressMs >= this.progressIntervalMs)
      ) {
        this.lastProgressMs = committedMs;
        this.queue.push({
          kind: "progress",
          startOffsetMs: 0,
          endOffsetMs: committedMs,
          committedThroughMs: committedMs,
        });
      }
      return;
    }

    // Active speech segment: keep committedThroughMs pinned at segmentStartMs.
    this.segmentChunks.push(windowSamples);
    this.segmentSampleCount += windowSamples.length;
    if (speech) {
      this.trailingSilenceSamples = 0;
    } else {
      this.trailingSilenceSamples += windowSamples.length;
    }

    if (this.trailingSilenceSamples >= this.silenceEndSamples) {
      this.closeActiveSegment(windowEndSample, {
        emitUtteranceEnd: this.options.mode === "chat_dictation",
      });
      return;
    }

    if (this.segmentSampleCount >= this.maxSegmentSamples) {
      const merged = concatInt16(this.segmentChunks, this.segmentSampleCount);
      const cutOffset = findQuietestCutOffset(merged);
      const head = merged.subarray(0, cutOffset);
      const tail = merged.subarray(cutOffset);
      const cutSample = this.segmentStartSample + cutOffset;
      this.closeActiveSegmentWithBuffer(
        this.segmentStartSample,
        cutSample,
        head.slice(),
        {
          emitUtteranceEnd: false,
          carryTail: tail.slice(),
          windowEndSample,
        },
      );
      return;
    }

    if (
      windowEndSample - this.lastPartialSample >=
      this.partialIntervalSamples
    ) {
      this.lastPartialSample = windowEndSample;
      this.schedulePartial(windowEndSample);
    }
  }

  private schedulePartial(snapshotEndSample: number): void {
    // At most one partial decode in flight; drop stale ticks instead of queueing.
    if (this.partialInFlight || this.closed || this.finishing) return;
    const activeSegmentId = this.segmentId;
    const segStartSample = this.segmentStartSample;
    const segStartMs = samplesToMs(segStartSample);
    const snapshotEndMs = samplesToMs(snapshotEndSample);
    const pcmSnapshot = concatInt16(
      this.segmentChunks,
      this.segmentSampleCount,
    );
    const wav = encodePcm16Wav(pcmSnapshot);

    const token = ++this.partialToken;
    this.partialInFlight = (async () => {
      try {
        const result = await this.transcribeFn({
          wav,
          modelId: this.options.modelId,
          language: this.options.language,
          useGpu: this.options.useGpu,
          keepLoadedSeconds: this.options.keepLoadedSeconds,
          partial: true,
          signal: this.controller.signal,
        });
        if (
          this.closed ||
          this.finishing ||
          !this.inSpeech ||
          this.segmentId !== activeSegmentId
        ) {
          return;
        }
        const text = result.text.trim();
        if (!text) return;
        const endMs = Math.max(snapshotEndMs, this.lastPartialEndMs ?? 0);
        this.lastPartialEndMs = endMs;
        this.queue.push({
          kind: "partial",
          startOffsetMs: segStartMs,
          endOffsetMs: endMs,
          committedThroughMs: segStartMs,
          text,
        });
      } catch {
        // Partial failures are non-fatal; final transcription still runs on segment close.
      } finally {
        if (this.partialToken === token) {
          this.partialInFlight = undefined;
        }
      }
    })();
  }

  private closeActiveSegment(
    endSample: number,
    options: { readonly emitUtteranceEnd: boolean },
  ): void {
    const pcm = concatInt16(this.segmentChunks, this.segmentSampleCount);
    this.closeActiveSegmentWithBuffer(
      this.segmentStartSample,
      endSample,
      pcm,
      options,
    );
  }

  private closeActiveSegmentWithBuffer(
    segStartSample: number,
    endSample: number,
    pcm: Int16Array,
    options: {
      readonly emitUtteranceEnd: boolean;
      readonly carryTail?: Int16Array;
      readonly windowEndSample?: number;
    },
  ): void {
    const capturedPartialEndMs = this.lastPartialEndMs;
    const endMs = samplesToMs(endSample);
    let carriedPartialEndMs: number | undefined;
    let partialForThisSegment = capturedPartialEndMs;

    if (options.carryTail && options.carryTail.length > 0) {
      // Carry any partial timestamp past cutSample to the continuation segment
      // so consecutive finals remain strictly non-overlapping.
      if (capturedPartialEndMs !== undefined && capturedPartialEndMs > endMs) {
        carriedPartialEndMs = capturedPartialEndMs;
        partialForThisSegment = endMs;
      }
      this.inSpeech = true;
      this.segmentId += 1;
      this.segmentStartSample = endSample;
      this.segmentChunks = [options.carryTail];
      this.segmentSampleCount = options.carryTail.length;
      this.trailingSilenceSamples = 0;
      this.lastPartialSample = options.windowEndSample ?? endSample;
      this.lastPartialEndMs = carriedPartialEndMs;
    } else {
      this.inSpeech = false;
      this.segmentId += 1;
      this.segmentChunks = [];
      this.segmentSampleCount = 0;
      this.trailingSilenceSamples = 0;
      this.lastPartialEndMs = undefined;
      this.clearPreRoll();
    }

    const wav = encodePcm16Wav(pcm);
    void this.enqueueSerial(async () => {
      const result = await this.transcribeFn({
        wav,
        modelId: this.options.modelId,
        language: this.options.language,
        useGpu: this.options.useGpu,
        keepLoadedSeconds: this.options.keepLoadedSeconds,
        partial: false,
        signal: this.controller.signal,
      });
      if (this.closed) return;
      const text = result.text.trim();
      const rawStartMs = samplesToMs(segStartSample);
      const startMs = Math.max(rawStartMs, this.maxFinalEndMs);
      const targetEndMs =
        this.options.mode === "chat_dictation"
          ? Math.max(endMs, partialForThisSegment ?? 0, startMs)
          : Math.max(endMs, startMs);

      const mustConfirmPartial =
        this.options.mode === "chat_dictation" &&
        partialForThisSegment !== undefined &&
        partialForThisSegment > this.maxFinalEndMs;

      if (text.length > 0 || mustConfirmPartial) {
        this.queue.push({
          kind: "final",
          startOffsetMs: startMs,
          endOffsetMs: targetEndMs,
          committedThroughMs: targetEndMs,
          text,
        });
        this.maxFinalEndMs = Math.max(this.maxFinalEndMs, targetEndMs);
        this.lastProgressMs = Math.max(this.lastProgressMs, targetEndMs);
      } else if (targetEndMs > this.lastProgressMs) {
        this.queue.push({
          kind: "progress",
          startOffsetMs: 0,
          endOffsetMs: targetEndMs,
          committedThroughMs: targetEndMs,
        });
        this.lastProgressMs = targetEndMs;
      }

      this.committedThroughSample = Math.max(
        this.committedThroughSample,
        endSample,
      );

      if (options.emitUtteranceEnd && this.options.mode === "chat_dictation") {
        const utteranceEndMs = Math.max(endMs, this.maxFinalEndMs);
        this.queue.push({
          kind: "utterance_end",
          startOffsetMs: utteranceEndMs,
          endOffsetMs: utteranceEndMs,
        });
      }
    }).catch(() => undefined);
  }

  private enqueueSerial(operation: () => Promise<void>): Promise<void> {
    const task = this.serialOps
      .then(async () => {
        if (this.closed || this.failure) return;
        await operation();
      })
      .catch((error: unknown) => {
        if (this.closed) return;
        this.failure ??= error;
        this.queue.fail(this.failure);
        throw this.failure;
      });
    this.serialOps = task.catch(() => undefined);
    return task;
  }

  private flushVadPendingIntoActiveSegment(): void {
    if (this.vadPendingLength === 0) return;
    const remaining = this.takeVadPending(this.vadPendingLength);
    this.vadConsumedSamples += remaining.length;
    this.processedSamples = this.vadConsumedSamples;
    if (this.inSpeech) {
      this.segmentChunks.push(remaining);
      this.segmentSampleCount += remaining.length;
    }
  }

  private takeVadPending(count: number): Int16Array {
    const output = new Int16Array(count);
    let written = 0;
    while (written < count && this.vadPendingChunks.length > 0) {
      const head = this.vadPendingChunks[0]!;
      const needed = count - written;
      if (head.length <= needed) {
        output.set(head, written);
        written += head.length;
        this.vadPendingChunks.shift();
      } else {
        output.set(head.subarray(0, needed), written);
        written += needed;
        this.vadPendingChunks[0] = head.subarray(needed);
      }
    }
    this.vadPendingLength -= written;
    return output;
  }

  private appendPreRoll(windowSamples: Int16Array, startSample: number): void {
    if (this.preRollSamples === 0) {
      this.preRollStartSample = startSample + windowSamples.length;
      return;
    }
    if (this.preRollLength === 0) {
      this.preRollStartSample = startSample;
    }
    this.preRollChunks.push(windowSamples);
    this.preRollLength += windowSamples.length;
    let excess = this.preRollLength - this.preRollSamples;
    while (excess > 0 && this.preRollChunks.length > 0) {
      const head = this.preRollChunks[0]!;
      if (head.length <= excess) {
        this.preRollChunks.shift();
        this.preRollLength -= head.length;
        this.preRollStartSample += head.length;
        excess -= head.length;
      } else {
        this.preRollChunks[0] = head.subarray(excess);
        this.preRollLength -= excess;
        this.preRollStartSample += excess;
        excess = 0;
      }
    }
  }

  private slicePreRollFrom(fromSample: number): Int16Array {
    if (this.preRollLength === 0) return new Int16Array(0);
    const merged = concatInt16(this.preRollChunks, this.preRollLength);
    const skip = Math.max(0, fromSample - this.preRollStartSample);
    return skip >= merged.length ? new Int16Array(0) : merged.subarray(skip);
  }

  private clearPreRoll(): void {
    this.preRollChunks = [];
    this.preRollLength = 0;
  }
}

function createRelayTranscribe(
  relay: LocalASRRelayTarget,
  fetchImpl: typeof fetch,
): LocalASRTranscribeFn {
  const endpoint = new URL(
    "/internal/v1/voice/local-asr/transcribe",
    relay.url,
  );
  return async (input) => {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${relay.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        tenant_id: relay.tenantId,
        owner_actor_id: relay.ownerActorId,
        computer_id: relay.computerId,
        ...(input.modelId ? { model_id: input.modelId } : {}),
        ...(input.language ? { language: input.language } : {}),
        ...(input.useGpu === undefined ? {} : { use_gpu: input.useGpu }),
        ...(input.keepLoadedSeconds === undefined
          ? {}
          : { keep_loaded_seconds: input.keepLoadedSeconds }),
        audio_wav_base64: input.wav.toString("base64"),
      }),
      signal: input.signal,
    });
    if (!response.ok) {
      const detail = await readErrorCode(response);
      throw new VoiceFailure(
        detail.code ?? `local_asr_http_${response.status}`,
        detail.message ??
          `Local ASR relay request failed with HTTP ${response.status}`,
        { recoverable: response.status >= 500 || response.status === 429 },
      );
    }
    const payload = (await response.json()) as {
      text?: unknown;
      language?: unknown;
    };
    if (typeof payload.text !== "string") {
      throw new VoiceFailure(
        "local_asr_invalid_response",
        "Local ASR relay returned an invalid response",
      );
    }
    return {
      text: payload.text,
      ...(typeof payload.language === "string"
        ? { language: payload.language }
        : {}),
    };
  };
}

function createDirectTranscribe(
  directUrl: string,
  fetchImpl: typeof fetch,
): LocalASRTranscribeFn {
  const endpoint = new URL(
    `${directUrl.replace(/\/+$/, "")}/v1/audio/transcriptions`,
  );
  return async (input) => {
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(input.wav)], { type: "audio/wav" }),
      "segment.wav",
    );
    form.append("model", input.modelId || "default");
    if (input.language && input.language !== "auto") {
      form.append("language", input.language);
    }
    form.append("response_format", "json");
    const response = await fetchImpl(endpoint, {
      method: "POST",
      body: form,
      signal: input.signal,
    });
    if (!response.ok) {
      const detail = await readErrorCode(response);
      throw new VoiceFailure(
        detail.code ?? `local_asr_http_${response.status}`,
        detail.message ??
          `Local ASR sidecar request failed with HTTP ${response.status}`,
        { recoverable: response.status >= 500 || response.status === 429 },
      );
    }
    const payload = (await response.json()) as {
      text?: unknown;
      language?: unknown;
    };
    if (typeof payload.text !== "string") {
      throw new VoiceFailure(
        "local_asr_invalid_response",
        "Local ASR sidecar returned an invalid response",
      );
    }
    return {
      text: payload.text,
      ...(typeof payload.language === "string"
        ? { language: payload.language }
        : {}),
    };
  };
}

async function readErrorCode(
  response: Response,
): Promise<{ code?: string; message?: string }> {
  try {
    const parsed = (await response.json()) as {
      error?: { code?: unknown; message?: unknown };
    };
    return {
      code:
        typeof parsed?.error?.code === "string"
          ? parsed.error.code.toLowerCase()
          : undefined,
      message:
        typeof parsed?.error?.message === "string"
          ? parsed.error.message
          : undefined,
    };
  } catch {
    return {};
  }
}

async function openVad(
  createVad?: () => Promise<SpeechActivityDetector>,
): Promise<SpeechActivityDetector> {
  if (createVad) return createVad();
  try {
    return await SileroSpeechActivityDetector.openPrewarmed();
  } catch {
    return new RmsSpeechActivityDetector();
  }
}

/**
 * Picks the quietest 50 ms frame inside the tail window (last 3 seconds or 25%
 * of the segment) so long speech cuts happen cleanly between syllables.
 */
function findQuietestCutOffset(samples: Int16Array): number {
  const searchWindow = Math.min(
    3 * SAMPLE_RATE,
    Math.floor(samples.length / 4),
  );
  const start = Math.max(QUIET_FRAME_SAMPLES, samples.length - searchWindow);
  let bestOffset = samples.length;
  let bestEnergy = Number.POSITIVE_INFINITY;
  for (
    let offset = start;
    offset + QUIET_FRAME_SAMPLES <= samples.length;
    offset += QUIET_FRAME_SAMPLES
  ) {
    let energy = 0;
    for (let i = 0; i < QUIET_FRAME_SAMPLES; i += 1) {
      const sample = samples[offset + i]!;
      energy += sample * sample;
    }
    if (energy < bestEnergy) {
      bestEnergy = energy;
      bestOffset = offset + Math.floor(QUIET_FRAME_SAMPLES / 2);
    }
  }
  return bestOffset;
}

function concatInt16(chunks: readonly Int16Array[], totalLength: number) {
  const result = new Int16Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function samplesToMs(samples: number): number {
  return Math.round(samples / SAMPLES_PER_MS);
}

function windowLevelDb(window: Int16Array): number {
  let sum = 0;
  for (const sample of window) sum += sample * sample;
  return 10 * Math.log10(Math.max(sum / window.length, 1) / 32_768 ** 2);
}
