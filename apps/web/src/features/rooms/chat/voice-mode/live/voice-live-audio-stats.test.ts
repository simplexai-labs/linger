import { describe, expect, it } from "vitest";

import {
  voiceLiveAudioBaseline,
  voiceLiveAudioStatsDelta,
  voiceLiveAudioTotals,
} from "./voice-live-audio-stats";

const report = (...stats: Array<Record<string, unknown>>) =>
  new Map(
    stats.map((stat, index) => [String(index), stat]),
  ) as unknown as RTCStatsReport;

describe("voiceLiveAudioTotals", () => {
  it("sums audio inbound-rtp and outbound-rtp counters and ignores the rest", () => {
    expect(
      voiceLiveAudioTotals(
        5,
        report(
          {
            type: "inbound-rtp",
            kind: "audio",
            concealedSamples: 10,
            packetsLost: 2,
          },
          { type: "inbound-rtp", kind: "audio", concealedSamples: 5 },
          { type: "inbound-rtp", kind: "video", concealedSamples: 99 },
          { type: "candidate-pair", packetsLost: 99 },
        ),
        report(
          { type: "outbound-rtp", kind: "audio", packetsSent: 40 },
          { type: "outbound-rtp", kind: "audio", packetsSent: "x" },
        ),
      ),
    ).toEqual({ at: 5, concealedSamples: 15, packetsLost: 2, packetsSent: 40 });
    expect(voiceLiveAudioTotals(1, undefined, undefined)).toEqual({ at: 1 });
  });
});

describe("voiceLiveAudioStatsDelta", () => {
  it("reports changes since the previous reading, not totals", () => {
    expect(
      voiceLiveAudioStatsDelta(
        {
          at: 1_000,
          samplesReceived: 48_000,
          concealedSamples: 100,
          silentConcealedSamples: 10,
          concealmentEvents: 2,
          insertedSamplesForDeceleration: 30,
          removedSamplesForAcceleration: 40,
          jitterBufferDelay: 2_400,
          jitterBufferEmittedCount: 48_000,
          packetsLost: 3,
          packetsSent: 500,
        },
        {
          at: 11_000,
          samplesReceived: 528_000,
          concealedSamples: 1_060,
          silentConcealedSamples: 10,
          concealmentEvents: 5,
          insertedSamplesForDeceleration: 130,
          removedSamplesForAcceleration: 40,
          jitterBufferDelay: 26_400,
          jitterBufferEmittedCount: 528_000,
          packetsLost: 4,
          packetsSent: 1_000,
        },
      ),
    ).toEqual({
      interval_ms: 10_000,
      samples_received: 480_000,
      concealed_samples: 960,
      silent_concealed_samples: 0,
      concealment_events: 3,
      inserted_samples_for_deceleration: 100,
      removed_samples_for_acceleration: 0,
      jitter_buffer_delay_ms: 50,
      packets_lost: 1,
      packets_sent: 500,
    });
  });

  it("reports no change for a counter that went down, such as packetsLost after late packets", () => {
    expect(
      voiceLiveAudioStatsDelta(
        { at: 0, packetsLost: 200, concealedSamples: 50 },
        { at: 10_000, packetsLost: 199, concealedSamples: 50 },
      ),
    ).toEqual({ interval_ms: 10_000, packets_lost: 0, concealed_samples: 0 });
  });

  it("counts a replaced track from zero and keeps the other stream's baseline", () => {
    const previous = {
      at: 0,
      concealedSamples: 50,
      packetsLost: 7,
      packetsSent: 100,
    };
    const current = {
      at: 10_000,
      concealedSamples: 80,
      packetsLost: 1,
      packetsSent: 600,
    };
    expect(
      voiceLiveAudioStatsDelta(
        voiceLiveAudioBaseline(previous, { reply: true, microphone: false }),
        current,
      ),
    ).toEqual({
      interval_ms: 10_000,
      concealed_samples: 80,
      packets_lost: 1,
      packets_sent: 500,
    });
    expect(
      voiceLiveAudioStatsDelta(
        voiceLiveAudioBaseline(previous, { reply: false, microphone: true }),
        current,
      ),
    ).toEqual({
      interval_ms: 10_000,
      concealed_samples: 30,
      packets_lost: 0,
      packets_sent: 600,
    });
  });

  it("omits what no stream reported and leaves out the jitter average without emitted samples", () => {
    expect(
      voiceLiveAudioStatsDelta(
        {
          at: 0,
          jitterBufferDelay: 1,
          jitterBufferEmittedCount: 10,
          packetsSent: 5,
        },
        {
          at: 10_000,
          jitterBufferDelay: 1,
          jitterBufferEmittedCount: 10,
          packetsSent: 5,
        },
      ),
    ).toEqual({ interval_ms: 10_000, packets_sent: 0 });
    expect(voiceLiveAudioStatsDelta({ at: 0 }, { at: 10_000 })).toBeUndefined();
  });
});
