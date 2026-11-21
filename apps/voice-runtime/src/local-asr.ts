import { readdir } from "node:fs/promises";
import path from "node:path";

import type { ASREvent, ASRProvider, ASRStream } from "./asr.js";
import { ASREventQueue } from "./event-queue.js";
import { VoiceFailure } from "./voice-failure.js";

const sampleRate = 16_000;
// Two threads decode the 190 MB int8 bilingual model about 25 times faster
// than realtime, leaving CPU for the other workers on the same computer.
const defaultThreads = 2;

/** The files one streaming zipformer model directory provides. */
export interface LocalASRFiles {
  encoder: string;
  decoder: string;
  joiner: string;
  tokens: string;
}

export interface LocalASRStreamHandle {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
  inputFinished(): void;
}

/** The subset of the sherpa-onnx OnlineRecognizer this provider uses. */
export interface LocalRecognizer {
  createStream(): LocalASRStreamHandle;
  isReady(stream: LocalASRStreamHandle): boolean;
  decode(stream: LocalASRStreamHandle): void;
  getResult(stream: LocalASRStreamHandle): { text?: string };
  isEndpoint(stream: LocalASRStreamHandle): boolean;
  reset(stream: LocalASRStreamHandle): void;
}

export interface LocalASREngine {
  createRecognizer(
    files: LocalASRFiles,
    threads: number,
  ): Promise<LocalRecognizer>;
}

let engine: LocalASREngine | undefined;

/**
 * The optional native engine, loaded on first use so a deployment that keeps
 * dictation on Soniox never needs the addon.
 */
export function sherpaLocalASREngine(): LocalASREngine {
  engine ??= {
    async createRecognizer(files, threads) {
      const { OnlineRecognizer } = await import("sherpa-onnx-node");
      return new OnlineRecognizer({
        featConfig: { sampleRate, featureDim: 80 },
        modelConfig: {
          transducer: {
            encoder: files.encoder,
            decoder: files.decoder,
            joiner: files.joiner,
          },
          tokens: files.tokens,
          numThreads: threads,
          provider: "cpu",
          debug: 0,
        },
        decodingMethod: "greedy_search",
        maxActivePaths: 4,
        enableEndpoint: true,
        // End a dictation turn after 1.2 s of silence; a speaker who pauses
        // longer between phrases leaves the earlier text final.
        rule1MinTrailingSilence: 2.4,
        rule2MinTrailingSilence: 1.2,
        rule3MinUtteranceLength: 20,
      });
    },
  };
  return engine;
}

function modelFile(entries: string[], prefix: string, modelDir: string) {
  const matches = entries
    .filter((name) => name.startsWith(prefix) && name.endsWith(".onnx"))
    .sort();
  const int8 = matches.filter((name) => name.includes(".int8."));
  const [chosen] = int8.length > 0 ? int8 : matches;
  if (!chosen)
    throw new Error(
      `Local ASR model is missing ${prefix}*.onnx in ${modelDir}`,
    );
  return path.join(modelDir, chosen);
}

/**
 * Reads the model files of one extracted sherpa-onnx streaming zipformer
 * directory. An int8 file wins over the full-precision one beside it.
 */
export async function discoverLocalASRFiles(
  modelDir: string,
): Promise<LocalASRFiles> {
  const entries = await readdir(modelDir);
  if (!entries.includes("tokens.txt"))
    throw new Error(`Local ASR model is missing tokens.txt in ${modelDir}`);
  return {
    encoder: modelFile(entries, "encoder", modelDir),
    decoder: modelFile(entries, "decoder", modelDir),
    joiner: modelFile(entries, "joiner", modelDir),
    tokens: path.join(modelDir, "tokens.txt"),
  };
}

export interface LocalASRProviderOptions {
  modelDir: string;
  threads?: number;
  engine?: LocalASREngine;
}

/**
 * Dictation and recording transcription on this computer. One recognizer is
 * shared by every stream the worker opens, because loading the model costs
 * about a second and each dictation turn opens its own stream.
 */
export class LocalASRProvider implements ASRProvider {
  readonly #options: LocalASRProviderOptions;
  #recognizer?: Promise<LocalRecognizer>;

  constructor(options: LocalASRProviderOptions) {
    this.#options = options;
  }

  open(signal: AbortSignal): Promise<ASRStream> {
    return this.#open(signal);
  }

  async #open(signal: AbortSignal): Promise<ASRStream> {
    signal.throwIfAborted();
    const recognizer = await this.#load();
    signal.throwIfAborted();
    return new LocalASRStream(recognizer, signal);
  }

  #load(): Promise<LocalRecognizer> {
    this.#recognizer ??= this.#create();
    return this.#recognizer;
  }

  async #create(): Promise<LocalRecognizer> {
    const files = await discoverLocalASRFiles(this.#options.modelDir);
    const localEngine = this.#options.engine ?? sherpaLocalASREngine();
    return localEngine.createRecognizer(
      files,
      this.#options.threads ?? defaultThreads,
    );
  }
}

class LocalASRStream implements ASRStream {
  readonly #queue = new ASREventQueue();
  readonly #handle: LocalASRStreamHandle;
  #samples = 0;
  #committedSamples = 0;
  #text = "";
  #closed = false;

  constructor(
    private readonly recognizer: LocalRecognizer,
    private readonly signal: AbortSignal,
  ) {
    this.#handle = recognizer.createStream();
  }

  async sendPCM(frame: Int16Array): Promise<void> {
    if (this.#closed) return;
    if (this.signal.aborted)
      throw new VoiceFailure(
        "asr_stream_aborted",
        "The local ASR stream was aborted",
      );
    const samples = new Float32Array(frame.length);
    for (let index = 0; index < frame.length; index += 1)
      samples[index] = (frame[index] ?? 0) / 32768;
    this.#handle.acceptWaveform({ sampleRate, samples });
    this.#samples += frame.length;
    this.#decode();
  }

  async finalize(): Promise<void> {
    if (this.#closed) return;
    this.#decode();
    this.#flush("finalization_ack");
    this.recognizer.reset(this.#handle);
  }

  async finish(): Promise<void> {
    if (this.#closed) return;
    this.#handle.inputFinished();
    this.#decode();
    this.#flushFinal();
    this.#closed = true;
    this.#queue.end();
  }

  events(): AsyncIterable<ASREvent> {
    return this.#queue.events();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue.end();
  }

  #decode() {
    while (!this.#closed && this.recognizer.isReady(this.#handle)) {
      this.recognizer.decode(this.#handle);
      const text = this.recognizer.getResult(this.#handle).text?.trim() ?? "";
      const endMs = this.#milliseconds(this.#samples);
      if (text && text !== this.#text) {
        this.#text = text;
        this.#queue.push({
          kind: "partial",
          startOffsetMs: this.#milliseconds(this.#committedSamples),
          endOffsetMs: Math.max(endMs, 1),
          text,
        });
      }
      if (this.recognizer.isEndpoint(this.#handle)) {
        this.#flush("utterance_end");
        this.recognizer.reset(this.#handle);
      }
    }
  }

  #flushFinal() {
    if (!this.#text) return;
    const startMs = this.#milliseconds(this.#committedSamples);
    const endMs = Math.max(this.#milliseconds(this.#samples), startMs + 1);
    this.#queue.push({
      kind: "final",
      startOffsetMs: startMs,
      endOffsetMs: endMs,
      text: this.#text,
    });
    this.#committedSamples = this.#samples;
    this.#text = "";
  }

  #flush(kind: "utterance_end" | "finalization_ack") {
    this.#flushFinal();
    const boundary = Math.max(this.#milliseconds(this.#samples), 1);
    this.#queue.push({
      kind,
      startOffsetMs: boundary,
      endOffsetMs: boundary,
    });
  }

  #milliseconds(samples: number) {
    return Math.round((samples / sampleRate) * 1000);
  }
}
