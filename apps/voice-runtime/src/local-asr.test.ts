import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ASREvent } from "./asr.js";
import {
  discoverLocalASRFiles,
  type LocalASREngine,
  LocalASRProvider,
  type LocalASRStreamHandle,
  type LocalRecognizer,
} from "./local-asr.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function modelDirectory(files: string[]) {
  const directory = await mkdtemp(path.join(tmpdir(), "linger-local-asr-"));
  directories.push(directory);
  await Promise.all(
    files.map((file) => writeFile(path.join(directory, file), "")),
  );
  return directory;
}

class FakeRecognizer implements LocalRecognizer {
  samples = 0;
  pendingSamples = 0;
  text = "";
  endpoint = false;
  ready = false;
  // Streaming zipformers decode in fixed chunks, so a frame smaller than this
  // is not ready until more audio arrives.
  readonly chunkSamples = 1_600;
  readonly handle: LocalASRStreamHandle = {
    acceptWaveform: ({ samples }) => {
      // Tail padding is all zeros; it flushes a chunk but is not speech.
      if (samples.some((sample) => sample !== 0))
        this.samples += samples.length;
      this.pendingSamples += samples.length;
      this.ready = this.pendingSamples >= this.chunkSamples;
    },
    inputFinished: () => {
      this.ready = true;
    },
  };

  createStream() {
    return this.handle;
  }
  isReady() {
    return this.ready;
  }
  decode() {
    this.ready = false;
    // Only audio accepted since the previous decode can change the
    // hypothesis, as in the real recognizer.
    if (this.pendingSamples < this.chunkSamples) return;
    this.pendingSamples = 0;
    if (this.samples >= 800) this.text = "hello world";
    this.endpoint = this.samples >= 3_200;
  }
  getResult() {
    return { text: this.text };
  }
  isEndpoint() {
    return this.endpoint;
  }
  reset() {
    this.samples = 0;
    this.pendingSamples = 0;
    this.text = "";
    this.endpoint = false;
    this.ready = false;
  }
}

async function collect(events: AsyncIterable<ASREvent>) {
  const collected: ASREvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("discoverLocalASRFiles", () => {
  it("prefers an int8 model and requires the token table", async () => {
    const directory = await modelDirectory([
      "encoder-epoch-1.onnx",
      "encoder-epoch-1.int8.onnx",
      "decoder-epoch-1.onnx",
      "joiner-epoch-1.int8.onnx",
      "tokens.txt",
    ]);
    const files = await discoverLocalASRFiles(directory);
    expect(files.encoder.endsWith("encoder-epoch-1.int8.onnx")).toBe(true);
    expect(files.decoder.endsWith("decoder-epoch-1.onnx")).toBe(true);
    expect(files.joiner.endsWith("joiner-epoch-1.int8.onnx")).toBe(true);
    expect(files.tokens.endsWith("tokens.txt")).toBe(true);
  });

  it("reports a missing model file by name", async () => {
    const directory = await modelDirectory([
      "decoder-epoch-1.onnx",
      "joiner-epoch-1.onnx",
      "tokens.txt",
    ]);
    await expect(discoverLocalASRFiles(directory)).rejects.toThrow(/encoder/);
  });

  it("reports a missing token table", async () => {
    const directory = await modelDirectory(["encoder-epoch-1.onnx"]);
    await expect(discoverLocalASRFiles(directory)).rejects.toThrow(
      /tokens\.txt/,
    );
  });
});

describe("LocalASRProvider", () => {
  it("emits a partial, then the final and its endpoint, then the commit ack", async () => {
    const recognizer = new FakeRecognizer();
    let created = 0;
    const engine: LocalASREngine = {
      createRecognizer: async () => {
        created += 1;
        return recognizer;
      },
    };
    const directory = await modelDirectory([
      "encoder-epoch-1.onnx",
      "decoder-epoch-1.onnx",
      "joiner-epoch-1.onnx",
      "tokens.txt",
    ]);
    const provider = new LocalASRProvider({
      modelDir: directory,
      engine,
    });

    const control = new AbortController();
    const stream = await provider.open(control.signal);
    const events = stream.events()[Symbol.asyncIterator]();
    await stream.sendPCM(new Int16Array(1_600).fill(1));
    // A partial is observable while the turn is still open; the queue would
    // replace it with the final if nothing read it first.
    await expect(events.next()).resolves.toMatchObject({
      value: {
        kind: "partial",
        text: "hello world",
        startOffsetMs: 0,
        endOffsetMs: 100,
      },
    });
    await stream.sendPCM(new Int16Array(1_600).fill(1));
    await expect(events.next()).resolves.toMatchObject({
      value: {
        kind: "final",
        text: "hello world",
        startOffsetMs: 0,
        endOffsetMs: 200,
      },
    });
    await expect(events.next()).resolves.toMatchObject({
      value: {
        kind: "utterance_end",
        startOffsetMs: 200,
        endOffsetMs: 200,
      },
    });
    await stream.finalize?.();
    await expect(events.next()).resolves.toMatchObject({
      value: {
        kind: "finalization_ack",
        startOffsetMs: 200,
        endOffsetMs: 200,
      },
    });
    await stream.finish();
    await expect(events.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });

    // One recognizer serves every turn the worker opens.
    const second = await provider.open(control.signal);
    await second.close();
    expect(created).toBe(1);
  });

  it("decodes the last partial chunk before a manual commit", async () => {
    const recognizer = new FakeRecognizer();
    const directory = await modelDirectory([
      "encoder-epoch-1.onnx",
      "decoder-epoch-1.onnx",
      "joiner-epoch-1.onnx",
      "tokens.txt",
    ]);
    const provider = new LocalASRProvider({
      modelDir: directory,
      engine: { createRecognizer: async () => recognizer },
    });
    const stream = await provider.open(new AbortController().signal);
    // Less than one decoder chunk: nothing is ready before the commit.
    await stream.sendPCM(new Int16Array(1_000).fill(1));
    await stream.finalize?.();
    await stream.finish();
    expect(await collect(stream.events())).toEqual([
      {
        kind: "final",
        startOffsetMs: 0,
        endOffsetMs: 63,
        text: "hello world",
      },
      {
        kind: "finalization_ack",
        startOffsetMs: 63,
        endOffsetMs: 63,
      },
    ]);
  });

  it("decodes the last partial chunk before end of input", async () => {
    const recognizer = new FakeRecognizer();
    const directory = await modelDirectory([
      "encoder-epoch-1.onnx",
      "decoder-epoch-1.onnx",
      "joiner-epoch-1.onnx",
      "tokens.txt",
    ]);
    const provider = new LocalASRProvider({
      modelDir: directory,
      engine: { createRecognizer: async () => recognizer },
    });
    const stream = await provider.open(new AbortController().signal);
    await stream.sendPCM(new Int16Array(1_000).fill(1));
    await stream.finish();
    expect(await collect(stream.events())).toEqual([
      {
        kind: "final",
        startOffsetMs: 0,
        endOffsetMs: 63,
        text: "hello world",
      },
    ]);
  });

  it("stops decoding after close", async () => {
    const recognizer = new FakeRecognizer();
    const directory = await modelDirectory([
      "encoder-epoch-1.onnx",
      "decoder-epoch-1.onnx",
      "joiner-epoch-1.onnx",
      "tokens.txt",
    ]);
    const provider = new LocalASRProvider({
      modelDir: directory,
      engine: { createRecognizer: async () => recognizer },
    });
    const stream = await provider.open(new AbortController().signal);
    await stream.close();
    await stream.sendPCM(new Int16Array(1_600).fill(1));
    expect(await collect(stream.events())).toEqual([]);
  });

  it("retries a failed recognizer load instead of caching it", async () => {
    const recognizer = new FakeRecognizer();
    const directory = await modelDirectory([
      "encoder-epoch-1.onnx",
      "decoder-epoch-1.onnx",
      "joiner-epoch-1.onnx",
      "tokens.txt",
    ]);
    let attempts = 0;
    const provider = new LocalASRProvider({
      modelDir: directory,
      engine: {
        createRecognizer: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("temporary load failure");
          return recognizer;
        },
      },
    });
    await expect(provider.open(new AbortController().signal)).rejects.toThrow(
      "temporary load failure",
    );
    const stream = await provider.open(new AbortController().signal);
    expect(attempts).toBe(2);
    await stream.close();
  });

  it("rejects a send after the signal aborts", async () => {
    const recognizer = new FakeRecognizer();
    const directory = await modelDirectory([
      "encoder-epoch-1.onnx",
      "decoder-epoch-1.onnx",
      "joiner-epoch-1.onnx",
      "tokens.txt",
    ]);
    const provider = new LocalASRProvider({
      modelDir: directory,
      engine: { createRecognizer: async () => recognizer },
    });
    const control = new AbortController();
    const stream = await provider.open(control.signal);
    control.abort();
    await expect(stream.sendPCM(new Int16Array(10))).rejects.toThrow(/aborted/);
  });
});
