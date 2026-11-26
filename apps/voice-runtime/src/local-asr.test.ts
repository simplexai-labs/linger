import { describe, expect, it, vi } from "vitest";

import type { ASREvent } from "./asr.js";
import { DictationASRStream } from "./dictation-asr.js";
import {
  encodePcm16Wav,
  LocalASRProvider,
  RmsSpeechActivityDetector,
  type LocalASRTranscribeInput,
} from "./local-asr.js";
import { voiceSpeechFromMetadata } from "./livekit-worker.js";
import type {
  SpeechActivity,
  SpeechActivityDetector,
} from "./voice-activity.js";

const SAMPLE_RATE = 16_000;
const WINDOW = 512;

/** Deterministic fake VAD driven by sample amplitude (non-zero = speech). */
class ScriptedVad implements SpeechActivityDetector {
  private pending = 0;
  private throughSample = 0;
  private buffer = new Int16Array(WINDOW);

  async pushPCM(frame: Int16Array): Promise<SpeechActivity[]> {
    const out: SpeechActivity[] = [];
    let offset = 0;
    while (offset < frame.length) {
      const count = Math.min(frame.length - offset, WINDOW - this.pending);
      this.buffer.set(frame.subarray(offset, offset + count), this.pending);
      this.pending += count;
      offset += count;
      if (this.pending < WINDOW) continue;
      let peak = 0;
      for (const sample of this.buffer) {
        const abs = Math.abs(sample);
        if (abs > peak) peak = abs;
      }
      this.throughSample += WINDOW;
      out.push({
        throughSample: this.throughSample,
        speech: peak > 100,
        levelDb: peak > 100 ? -12 : -90,
      });
      this.pending = 0;
    }
    return out;
  }

  close(): void {}
}

function makePcm(ms: number, amplitude: number): Int16Array {
  const samples = Math.round((ms / 1_000) * SAMPLE_RATE);
  const frame = new Int16Array(samples);
  if (amplitude !== 0) {
    for (let i = 0; i < samples; i += 1) {
      frame[i] = i % 2 === 0 ? amplitude : -amplitude;
    }
  }
  return frame;
}

async function sendChunked(
  stream: { sendPCM(frame: Int16Array): Promise<void> },
  pcm: Int16Array,
  chunkSamples = 320,
) {
  for (let offset = 0; offset < pcm.length; offset += chunkSamples) {
    await stream.sendPCM(
      pcm.subarray(offset, Math.min(pcm.length, offset + chunkSamples)),
    );
  }
}

describe("LocalASRProvider", () => {
  it("encodes valid 16 kHz mono PCM16 WAV headers", () => {
    const pcm = new Int16Array([0, 1000, -1000, 32767]);
    const wav = encodePcm16Wav(pcm);
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.subarray(12, 16).toString("ascii")).toBe("fmt ");
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.subarray(36, 40).toString("ascii")).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(8);
    expect(wav.readInt16LE(46)).toBe(1000);
    expect(wav.readInt16LE(48)).toBe(-1000);
  });

  it("opens immediately without blocking on a slow transcription backend", async () => {
    const transcribe = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      return { text: "never called during open" };
    });
    const provider = new LocalASRProvider({
      mode: "chat_dictation",
      transcribe,
      createVad: async () => new ScriptedVad(),
    });
    const started = Date.now();
    const stream = await provider.open(new AbortController().signal);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(transcribe).not.toHaveBeenCalled();
    await stream.close();
  });

  it("handles chat_dictation partials, VAD silence utterance_end, manual commit, and finish without dictation_unconfirmed", async () => {
    const calls: LocalASRTranscribeInput[] = [];
    const provider = new LocalASRProvider({
      mode: "chat_dictation",
      silenceEndMs: 600,
      partialIntervalMs: 400,
      preRollMs: 200,
      createVad: async () => new ScriptedVad(),
      transcribe: async (input) => {
        calls.push(input);
        return {
          text: input.partial ? "\u4f60\u597d" : "\u4f60\u597d\u4e16\u754c",
        };
      },
    });

    const controller = new AbortController();
    const dictation = await DictationASRStream.open(
      provider,
      controller.signal,
    );
    const events: ASREvent[] = [];
    const reading = (async () => {
      for await (const event of dictation.events()) events.push(event);
    })();

    // Turn 1: speech + VAD silence -> partial + final + turn_finalized
    await sendChunked(dictation, makePcm(200, 0));
    await sendChunked(dictation, makePcm(1_000, 8_000));
    await sendChunked(dictation, makePcm(700, 0));

    // Turn 2: speech + manual commit -> final + turn_finalized
    await sendChunked(dictation, makePcm(600, 8_000));
    await dictation.commit("req-manual-1");

    // Turn 3: speech + finish (no trailing silence) -> final + turn_finalized
    await sendChunked(dictation, makePcm(600, 8_000));
    await dictation.finish();
    await reading;
    await dictation.close();

    const turns = events.filter((event) => event.kind === "turn_finalized");
    expect(turns.map((event) => event.text)).toEqual([
      "\u4f60\u597d\u4e16\u754c",
      "\u4f60\u597d\u4e16\u754c",
      "\u4f60\u597d\u4e16\u754c",
    ]);
    expect(events.some((event) => event.kind === "partial")).toBe(true);
    expect(events.every((event) => event.speakerId === undefined)).toBe(true);
    expect(calls.some((call) => call.partial)).toBe(true);
    expect(calls.some((call) => !call.partial)).toBe(true);
  });

  it("clears partial state on finish even when final decode returns empty text", async () => {
    const provider = new LocalASRProvider({
      mode: "chat_dictation",
      partialIntervalMs: 300,
      silenceEndMs: 1_000,
      createVad: async () => new ScriptedVad(),
      transcribe: async (input) => ({
        text: input.partial ? "transient noise" : "",
      }),
    });

    const dictation = await DictationASRStream.open(
      provider,
      new AbortController().signal,
    );
    const events: ASREvent[] = [];
    const reading = (async () => {
      for await (const event of dictation.events()) events.push(event);
    })();

    await sendChunked(dictation, makePcm(700, 8_000));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await dictation.finish();
    await reading;
    await dictation.close();

    expect(events.some((event) => event.kind === "final")).toBe(true);
    expect(events.some((event) => event.kind === "turn_finalized")).toBe(false);
  });

  it("enforces hardware_control recording invariants: silence progress, active hold, no dictation endpoints, and clean max-segment cuts", async () => {
    let finalCount = 0;
    const provider = new LocalASRProvider({
      mode: "hardware_control",
      silenceEndMs: 800,
      partialIntervalMs: 400,
      maxSegmentMs: 2_000,
      progressIntervalMs: 500,
      preRollMs: 200,
      createVad: async () => new ScriptedVad(),
      transcribe: async (input) => {
        if (input.partial) return { text: "speaking..." };
        finalCount += 1;
        return { text: `segment ${finalCount}` };
      },
    });

    const stream = await provider.open(new AbortController().signal);
    const events: ASREvent[] = [];
    const reading = (async () => {
      for await (const event of stream.events()) events.push(event);
    })();

    // 1.5s of silence should advance progress periodically.
    await sendChunked(stream, makePcm(1_500, 0));
    const silenceProgress = events.filter((e) => e.kind === "progress");
    expect(silenceProgress.length).toBeGreaterThanOrEqual(2);
    expect(silenceProgress.at(-1)!.committedThroughMs).toBeGreaterThanOrEqual(
      1_000,
    );

    // 4.5s of continuous speech with a quiet 100ms dip around 1.8s -> triggers maxSegmentMs cuts!
    await sendChunked(stream, makePcm(1_700, 9_000));
    await sendChunked(stream, makePcm(100, 500)); // still speech (>100), quietest frame!
    await sendChunked(stream, makePcm(2_700, 9_000));
    await sendChunked(stream, makePcm(900, 0)); // VAD silence closes last segment
    await stream.finish();
    await reading;
    await stream.close();

    // Never emit utterance_end or finalization_ack in hardware_control mode.
    expect(
      events.some(
        (event) =>
          event.kind === "utterance_end" || event.kind === "finalization_ack",
      ),
    ).toBe(false);
    // Never emit speakerId.
    expect(events.every((event) => event.speakerId === undefined)).toBe(true);

    // Consecutive finals must be strictly monotonic and non-overlapping.
    const finals = events.filter((event) => event.kind === "final");
    expect(finals.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < finals.length; i += 1) {
      expect(finals[i]!.endOffsetMs).toBeGreaterThanOrEqual(
        finals[i]!.startOffsetMs,
      );
      if (i > 0) {
        expect(finals[i]!.startOffsetMs).toBeGreaterThanOrEqual(
          finals[i - 1]!.endOffsetMs,
        );
      }
    }

    // Final progress must cover total processed audio.
    const lastCommitted = Math.max(
      ...events
        .map((e) => e.committedThroughMs)
        .filter((v): v is number => v !== undefined),
    );
    expect(lastCommitted).toBeGreaterThanOrEqual(6_800);
  });

  it("drops stale partial ticks while one partial decode is in flight", async () => {
    let releasePartial!: () => void;
    let partialCalls = 0;
    const provider = new LocalASRProvider({
      mode: "hardware_control",
      partialIntervalMs: 300,
      silenceEndMs: 2_000,
      maxSegmentMs: 10_000,
      createVad: async () => new ScriptedVad(),
      transcribe: async (input) => {
        if (input.partial) {
          partialCalls += 1;
          await new Promise<void>((resolve) => {
            releasePartial = resolve;
          });
          return { text: "partial text" };
        }
        return { text: "final text" };
      },
    });

    const stream = await provider.open(new AbortController().signal);
    const events: ASREvent[] = [];
    const reading = (async () => {
      for await (const event of stream.events()) events.push(event);
    })();

    // Feed 1.5s of speech (would normally trigger ~5 partial ticks at 300ms interval).
    await sendChunked(stream, makePcm(1_500, 8_000));
    expect(partialCalls).toBe(1);
    releasePartial();
    await stream.finish();
    await reading;
    await stream.close();

    expect(partialCalls).toBe(1);
    expect(
      events.some((e) => e.kind === "final" && e.text === "final text"),
    ).toBe(true);
  });

  it("sends expected payload over Runner Gateway relay and supports direct HTTP fallback", async () => {
    const relayFetch = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      expect(typeof init?.body).toBe("string");
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      expect(body.tenant_id).toBe("tenant-1");
      expect(body.owner_actor_id).toBe("actor-1");
      expect(body.computer_id).toBe("computer-1");
      expect(body.model_id).toBe("sensevoice-small");
      expect(body.language).toBe("zh");
      expect(body.use_gpu).toBe(false);
      expect(body.keep_loaded_seconds).toBe(900);
      expect(typeof body.audio_wav_base64).toBe("string");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer internal-tok",
      );
      return Response.json({
        text: "relayed text",
        language: "zh",
        model: "sensevoice-small",
        requested_device: "cpu",
        effective_device: "cpu",
      });
    });

    const relayProvider = new LocalASRProvider({
      mode: "hardware_control",
      modelId: "sensevoice-small",
      language: "zh",
      useGpu: false,
      keepLoadedSeconds: 900,
      relay: {
        url: "http://127.0.0.1:4319",
        token: "internal-tok",
        tenantId: "tenant-1",
        ownerActorId: "actor-1",
        computerId: "computer-1",
      },
      fetchImpl: relayFetch as unknown as typeof fetch,
      createVad: async () => new RmsSpeechActivityDetector(),
    });
    const stream = await relayProvider.open(new AbortController().signal);
    const events: ASREvent[] = [];
    const reading = (async () => {
      for await (const event of stream.events()) events.push(event);
    })();
    await sendChunked(stream, makePcm(500, 8_000));
    await stream.finish();
    await reading;
    await stream.close();
    expect(relayFetch).toHaveBeenCalledTimes(1);
    expect(events.find((e) => e.kind === "final")?.text).toBe("relayed text");

    const directFetch = vi.fn(async (url: URL | string, init?: RequestInit) => {
      expect(String(url)).toBe(
        "http://127.0.0.1:18771/v1/audio/transcriptions",
      );
      expect(init?.body).toBeInstanceOf(FormData);
      return Response.json({ text: "direct text" });
    });
    const directProvider = new LocalASRProvider({
      mode: "hardware_control",
      modelId: "whisper-large-v3-turbo",
      language: "en",
      directUrl: "http://127.0.0.1:18771",
      fetchImpl: directFetch as unknown as typeof fetch,
      createVad: async () => new RmsSpeechActivityDetector(),
    });
    const directStream = await directProvider.open(
      new AbortController().signal,
    );
    const directEvents: ASREvent[] = [];
    const directReading = (async () => {
      for await (const event of directStream.events()) directEvents.push(event);
    })();
    await sendChunked(directStream, makePcm(500, 8_000));
    await directStream.finish();
    await directReading;
    await directStream.close();
    expect(directFetch).toHaveBeenCalledTimes(1);
    expect(directEvents.find((e) => e.kind === "final")?.text).toBe(
      "direct text",
    );
  });

  it("parses speech dispatch metadata safely and remains backward compatible when absent", () => {
    expect(
      voiceSpeechFromMetadata(
        JSON.stringify({
          voice_session_created_at: "2026-11-26T00:00:00Z",
          voice_purpose: "chat_dictation",
        }),
      ),
    ).toBeUndefined();

    expect(
      voiceSpeechFromMetadata(
        JSON.stringify({
          voice_session_created_at: "2026-11-26T00:00:00Z",
          voice_purpose: "hardware_control",
          speech: {
            provider: "local",
            computer_id: "comp-1",
            model_id: "sensevoice-small",
            language: "auto",
            use_gpu: true,
            keep_loaded_seconds: 900,
            tenant_id: "tenant-1",
            owner_actor_id: "actor-1",
          },
        }),
      ),
    ).toEqual({
      provider: "local",
      computerId: "comp-1",
      modelId: "sensevoice-small",
      language: "auto",
      useGpu: true,
      keepLoadedSeconds: 900,
      tenantId: "tenant-1",
      ownerActorId: "actor-1",
    });
  });
});
