import { availableParallelism } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";

import type { SenseVoiceRecognizer } from "./sensevoice.js";

/** The two files the int8 SenseVoiceSmall ONNX model is made of. */
export const senseVoiceModelFile = "model.int8.onnx";
export const senseVoiceTokensFile = "tokens.txt";

interface SherpaStream {
  acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void;
}

interface SherpaRecognizer {
  createStream(): SherpaStream;
  decodeAsync(stream: SherpaStream): Promise<{ text?: string }>;
}

interface SherpaModule {
  OfflineRecognizer: {
    createAsync(config: unknown): Promise<SherpaRecognizer>;
  };
}

export interface SenseVoiceRecognizerOptions {
  /** Holds `model.int8.onnx` and `tokens.txt`. */
  modelDir: string;
  /** CPU threads; defaults to the machine's, up to four. */
  threads?: number;
}

const require = createRequire(import.meta.url);
const loading = new Map<string, Promise<SenseVoiceRecognizer>>();

/**
 * Loads the recognizer once per process and directory: a job process serves
 * one session at a time and keeps the model between them, and the idle
 * process loads it before a job arrives.
 */
export function loadSenseVoiceRecognizer(
  options: SenseVoiceRecognizerOptions,
): Promise<SenseVoiceRecognizer> {
  const key = path.resolve(options.modelDir);
  let recognizer = loading.get(key);
  if (!recognizer) {
    recognizer = createRecognizer(options);
    loading.set(key, recognizer);
    // A failed load must not be cached: the next session retries it.
    recognizer.catch(() => loading.delete(key));
  }
  return recognizer;
}

async function createRecognizer({
  modelDir,
  threads,
}: SenseVoiceRecognizerOptions): Promise<SenseVoiceRecognizer> {
  const sherpa = require("sherpa-onnx-node") as SherpaModule;
  const recognizer = await sherpa.OfflineRecognizer.createAsync({
    featConfig: { sampleRate: 16_000, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model: path.join(modelDir, senseVoiceModelFile),
        // The model names the language it hears, and the text comes back with
        // numbers and punctuation already written out.
        language: "auto",
        useInverseTextNormalization: 1,
      },
      tokens: path.join(modelDir, senseVoiceTokensFile),
      numThreads: threads ?? Math.max(1, Math.min(4, availableParallelism())),
      provider: "cpu",
      debug: 0,
    },
  });
  return {
    async decode(samples) {
      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples, sampleRate: 16_000 });
      return (await recognizer.decodeAsync(stream)).text ?? "";
    },
  };
}
