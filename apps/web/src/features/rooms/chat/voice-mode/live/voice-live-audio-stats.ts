import type { TeamHubVoiceLiveAudioStats } from "@/features/teamhub/teamhub-types";

/** How often a Live call reports reply audio quality to the Live worker. */
export const voiceLiveAudioStatsIntervalMs = 10_000;

/** Cumulative WebRTC audio counters read at one moment. */
export interface VoiceLiveAudioTotals {
  at: number;
  samplesReceived?: number;
  concealedSamples?: number;
  silentConcealedSamples?: number;
  concealmentEvents?: number;
  insertedSamplesForDeceleration?: number;
  removedSamplesForAcceleration?: number;
  /** Seconds, summed over every emitted sample. */
  jitterBufferDelay?: number;
  jitterBufferEmittedCount?: number;
  packetsLost?: number;
  packetsSent?: number;
}

const inboundCounters = [
  "samplesReceived",
  "concealedSamples",
  "silentConcealedSamples",
  "concealmentEvents",
  "insertedSamplesForDeceleration",
  "removedSamplesForAcceleration",
  "jitterBufferDelay",
  "jitterBufferEmittedCount",
  "packetsLost",
] as const;

const maximumCount = 1_000_000_000;

/**
 * Sums the reply track's inbound-rtp and the microphone's outbound-rtp
 * audio counters; a counter no stream reports stays absent.
 */
export function voiceLiveAudioTotals(
  at: number,
  reply: RTCStatsReport | undefined,
  microphone: RTCStatsReport | undefined,
): VoiceLiveAudioTotals {
  const totals: VoiceLiveAudioTotals = { at };
  const add = (
    key: Exclude<keyof VoiceLiveAudioTotals, "at">,
    value: unknown,
  ) => {
    if (typeof value === "number" && Number.isFinite(value))
      totals[key] = (totals[key] ?? 0) + value;
  };
  reply?.forEach((stat: Record<string, unknown>) => {
    if (stat.type !== "inbound-rtp" || stat.kind !== "audio") return;
    for (const key of inboundCounters) add(key, stat[key]);
  });
  microphone?.forEach((stat: Record<string, unknown>) => {
    if (stat.type === "outbound-rtp" && stat.kind === "audio")
      add("packetsSent", stat.packetsSent);
  });
  return totals;
}

/**
 * The previous reading as the baseline for the next one. A replaced reply or
 * microphone track counts from zero, so its counters leave the baseline.
 */
export function voiceLiveAudioBaseline(
  previous: VoiceLiveAudioTotals,
  changed: { reply: boolean; microphone: boolean },
): VoiceLiveAudioTotals {
  const baseline = { ...previous };
  if (changed.reply) for (const key of inboundCounters) delete baseline[key];
  if (changed.microphone) delete baseline.packetsSent;
  return baseline;
}

/**
 * What changed between two readings of the same streams. A counter that went
 * down, as `packetsLost` does when late packets arrive, changed by nothing.
 * Returns nothing when no counter is known.
 */
export function voiceLiveAudioStatsDelta(
  previous: VoiceLiveAudioTotals,
  current: VoiceLiveAudioTotals,
): TeamHubVoiceLiveAudioStats | undefined {
  const delta = (key: Exclude<keyof VoiceLiveAudioTotals, "at">) => {
    const now = current[key];
    if (now === undefined) return;
    const before = previous[key] ?? 0;
    return Math.max(0, now - before);
  };
  const count = (key: Exclude<keyof VoiceLiveAudioTotals, "at">) => {
    const value = delta(key);
    return value === undefined
      ? undefined
      : Math.min(maximumCount, Math.round(value));
  };
  const emitted = delta("jitterBufferEmittedCount");
  const buffered = delta("jitterBufferDelay");
  const stats: TeamHubVoiceLiveAudioStats = {
    interval_ms: Math.min(
      3_600_000,
      Math.max(0, Math.round(current.at - previous.at)),
    ),
    samples_received: count("samplesReceived"),
    concealed_samples: count("concealedSamples"),
    silent_concealed_samples: count("silentConcealedSamples"),
    concealment_events: count("concealmentEvents"),
    inserted_samples_for_deceleration: count("insertedSamplesForDeceleration"),
    removed_samples_for_acceleration: count("removedSamplesForAcceleration"),
    jitter_buffer_delay_ms:
      emitted && buffered !== undefined
        ? Math.min(60_000, Math.round((buffered / emitted) * 1_000_000) / 1_000)
        : undefined,
    packets_lost: count("packetsLost"),
    packets_sent: count("packetsSent"),
  };
  for (const key of Object.keys(stats) as Array<keyof typeof stats>)
    if (stats[key] === undefined) delete stats[key];
  return Object.keys(stats).length > 1 ? stats : undefined;
}
