import { describe, expect, it, vi } from "vitest";
import type { ASREvent } from "./asr.js";
import { DictationASRStream } from "./dictation-asr.js";
import {
  SenseVoiceASRProvider,
  type SegmentPolisher,
  type SenseVoiceRecognizer,
} from "./sensevoice.js";
import { sampleRate } from "./sensevoice-segments.js";

const second = new Int16Array(sampleRate).fill(1_000);

/** A tenth of a second of loud square wave, which the endpoint hears as speech. */
function spokenTenth(amplitude: number) {
  const samples = new Int16Array(sampleRate / 10);
  for (let index = 0; index < samples.length; index++)
    samples[index] = Math.floor(index / 40) % 2 ? amplitude : -amplitude;
  return samples;
}

function recognizerOf(
  text: (samples: Float32Array) => string,
): SenseVoiceRecognizer & { decode: ReturnType<typeof vi.fn> } {
  return {
    decode: vi.fn(async (samples: Float32Array) => text(samples)),
  };
}

async function open(
  recognizer: SenseVoiceRecognizer,
  polish?: SegmentPolisher,
) {
  const provider = new SenseVoiceASRProvider({
    recognizer: async () => recognizer,
    polish,
  });
  const stream = await provider.open(new AbortController().signal);
  const events: ASREvent[] = [];
  const reader = (async () => {
    for await (const event of stream.events()) events.push(event);
  })();
  return { provider, stream, events, reader };
}

async function feed(
  stream: { sendPCM(frame: Int16Array): Promise<void> },
  seconds: number,
) {
  for (let index = 0; index < seconds; index++) await stream.sendPCM(second);
}

describe("SenseVoiceASRStream", () => {
  it("reports the open segment as a partial once enough audio arrived", async () => {
    const recognizer = recognizerOf(
      (samples) => `heard ${samples.length / sampleRate}s`,
    );
    const { stream, events } = await open(recognizer);
    await stream.sendPCM(new Int16Array(sampleRate / 2));
    expect(recognizer.decode).not.toHaveBeenCalled();
    await stream.sendPCM(new Int16Array(sampleRate));
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toEqual({
      kind: "partial",
      startOffsetMs: 0,
      endOffsetMs: 1_500,
      text: "heard 1.5s",
    });
  });

  it("finalizes the open segment, then acknowledges at the audio end", async () => {
    const { stream, events } = await open(recognizerOf(() => "hello there"));
    await feed(stream, 2);
    await stream.finalize?.();
    await vi.waitFor(() =>
      expect(events.map((event) => event.kind)).toContain("finalization_ack"),
    );
    expect(events.slice(-2)).toEqual([
      {
        kind: "final",
        startOffsetMs: 0,
        endOffsetMs: 2_000,
        text: "hello there",
      },
      { kind: "finalization_ack", startOffsetMs: 2_000, endOffsetMs: 2_000 },
    ]);
  });

  it("starts the next segment where the commit ended", async () => {
    const { stream, events } = await open(
      recognizerOf((samples) => `${samples.length / sampleRate}s`),
    );
    await feed(stream, 2);
    await stream.finalize?.();
    await feed(stream, 3);
    await stream.finish();
    expect(events.filter((event) => event.kind === "final")).toEqual([
      { kind: "final", startOffsetMs: 0, endOffsetMs: 2_000, text: "2s" },
      { kind: "final", startOffsetMs: 2_000, endOffsetMs: 5_000, text: "3s" },
    ]);
  });

  it("cuts a segment that reaches 30 seconds and carries the rest forward", async () => {
    const decoded: number[] = [];
    const { stream, events } = await open(
      recognizerOf((samples) => {
        decoded.push(samples.length);
        return `segment ${decoded.length}`;
      }),
    );
    await feed(stream, 31);
    await vi.waitFor(() =>
      expect(events.some((event) => event.kind === "final")).toBe(true),
    );
    const closed = events.find((event) => event.kind === "final");
    expect(closed?.startOffsetMs).toBe(0);
    // Uniform audio is equally quiet everywhere, so the cut is its latest frame.
    expect(closed?.endOffsetMs).toBe(29_975);
    await stream.finish();
    expect(events.filter((event) => event.kind === "final")).toHaveLength(2);
  });

  it("emits nothing for a segment the model hears no speech in", async () => {
    const { stream, events } = await open(recognizerOf(() => "  "));
    await feed(stream, 2);
    await stream.finalize?.();
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]?.kind).toBe("finalization_ack");
  });

  it("keeps the heard text when the full decode of a heard segment is blank", async () => {
    let calls = 0;
    const { stream, events } = await open(
      recognizerOf(() => (++calls === 1 ? "partial words" : "")),
    );
    await feed(stream, 2);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    await stream.finish();
    expect(events.at(-1)).toMatchObject({
      kind: "final",
      text: "partial words",
    });
  });

  it("rewrites each final and keeps the raw text when the rewrite fails", async () => {
    const polish = vi.fn<SegmentPolisher>(async (text) => {
      if (text === "bad") throw new Error("model unavailable");
      return ` ${text.toUpperCase()} `;
    });
    let turn = 0;
    const { stream, events } = await open(
      recognizerOf(() => (++turn % 2 ? "good" : "bad")),
      polish,
    );
    await feed(stream, 1);
    await stream.finalize?.();
    await feed(stream, 1);
    await stream.finish();
    expect(events.filter((event) => event.kind === "final")).toMatchObject([
      { text: "GOOD" },
      { text: "bad" },
    ]);
  });

  it("holds the acknowledgement for the rewrite and shows the raw text meanwhile", async () => {
    let release: (text: string) => void = () => undefined;
    const polish = vi.fn<SegmentPolisher>(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const { stream, events } = await open(
      recognizerOf(() => "raw text"),
      polish,
    );
    await feed(stream, 2);
    await stream.finalize?.();
    await vi.waitFor(() =>
      expect(polish).toHaveBeenCalledWith("raw text", expect.anything()),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events.some((event) => event.kind === "finalization_ack")).toBe(
      false,
    );
    release("Polished text.");
    await vi.waitFor(() =>
      expect(events.map((event) => event.kind)).toContain("finalization_ack"),
    );
    expect(events.find((event) => event.kind === "final")?.text).toBe(
      "Polished text.",
    );
  });

  it("rejects audio after finish", async () => {
    const { stream } = await open(recognizerOf(() => "x"));
    await stream.finish();
    await expect(stream.sendPCM(second)).rejects.toThrow("finished");
  });
});

describe("SenseVoice dictation turns", () => {
  it("publishes a manual commit as one turn", async () => {
    const provider = new SenseVoiceASRProvider({
      recognizer: async () => recognizerOf(() => "Open the file"),
    });
    const stream = await DictationASRStream.open(
      provider,
      new AbortController().signal,
    );
    const events: ASREvent[] = [];
    const reader = (async () => {
      for await (const event of stream.events()) events.push(event);
    })();
    await feed(stream, 2);
    await stream.commit("commit-1");
    await vi.waitFor(() =>
      expect(events.some((event) => event.kind === "turn_finalized")).toBe(
        true,
      ),
    );
    expect(
      events.find((event) => event.kind === "turn_finalized"),
    ).toMatchObject({
      text: "Open the file",
      startOffsetMs: 0,
      endOffsetMs: 2_000,
    });
    await stream.finish();
    await reader;
  });

  it("ends a turn by itself when the speaker pauses", async () => {
    // The model hears words only where the audio is loud.
    const provider = new SenseVoiceASRProvider({
      recognizer: async () =>
        recognizerOf((samples) =>
          samples.some((value) => Math.abs(value) > 0.1) ? "Open the file" : "",
        ),
    });
    const stream = await DictationASRStream.open(
      provider,
      new AbortController().signal,
    );
    const events: ASREvent[] = [];
    const reader = (async () => {
      for await (const event of stream.events()) events.push(event);
    })();
    // Half a second of silence, a second of speech, then a pause.
    await stream.sendPCM(new Int16Array(sampleRate / 2));
    for (let index = 0; index < 5; index++) {
      await stream.sendPCM(spokenTenth(8_000));
      await stream.sendPCM(spokenTenth(8_000));
    }
    expect(events.some((event) => event.kind === "turn_finalized")).toBe(false);
    for (let index = 0; index < 15; index++)
      await stream.sendPCM(new Int16Array(sampleRate / 10));
    await vi.waitFor(() =>
      expect(events.some((event) => event.kind === "turn_finalized")).toBe(
        true,
      ),
    );
    expect(
      events.find((event) => event.kind === "turn_finalized"),
    ).toMatchObject({ text: "Open the file" });
    // The pause's own audio is no second turn.
    await stream.finish();
    await reader;
    expect(
      events.filter((event) => event.kind === "turn_finalized"),
    ).toHaveLength(1);
  });

  it("joins a long turn's segments as one text", () => {
    const provider = new SenseVoiceASRProvider({
      recognizer: async () => recognizerOf(() => ""),
    });
    expect(provider.joinFinals(["open the", "file", "Done."])).toBe(
      "open the file Done.",
    );
  });
});
