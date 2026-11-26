import { describe, expect, it } from "vitest";

import {
  appendHistoryPoint,
  computeWhatIfForecast,
  deriveSnapshotMetrics,
  TELEMETRY_HISTORY_CAPACITY,
} from "./telemetry-math";
import type {
  SystemTelemetrySnapshot,
  SystemTelemetryView,
  SystemTelemetryWhatIf,
} from "./telemetry-types";

const GiB = 1024 ** 3;

function makeView(
  revision: number,
  overrides: Partial<SystemTelemetrySnapshot> = {},
): SystemTelemetryView {
  return {
    computer: {
      computer_id: "comp-mac",
      display_name: "Mac Studio",
      status: "online",
    },
    observed_at: new Date(1_700_000_000_000 + revision * 1000).toISOString(),
    revision,
    snapshot: {
      generated_at: new Date(1_700_000_000_000 + revision * 1000).toISOString(),
      schema: "localmodels.stack-view/v1",
      schema_version: "1.1",
      source: "live",
      components: [
        {
          id: "chat-0",
          model: "qwen3.8-27b",
          title: "Qwen3.8 27B",
          quant: "UD-Q4_K_M",
          device: "Metal",
          state: "loaded",
          slots: 8,
          window: 65536,
          vram_bytes: 16 * GiB,
          perf: {
            decode_tok_s: { basis: "live", value: 24.5 },
            prefill_tok_s: { basis: "live", value: 480 },
          },
          live_slots: [
            {
              id: 0,
              busy: true,
              phase: "decoding",
              n_ctx: 65536,
              cached: 12000,
              prompt_done: 16000,
              decoded: 420,
              tok_s: 14.2,
              ttft_ms: 210,
            },
          ],
        },
      ],
      effective_decode_bw_gb_s: { basis: "measured", value: 218 },
      memory_bw_ceiling_gb_s: { basis: "measured", value: 273 },
      p50_ttft_ms: { basis: "live", value: 240 },
      ...overrides,
    },
    viewer_is_owner: true,
  };
}

describe("appendHistoryPoint", () => {
  it("keeps at most 60 ticks and ignores duplicate revisions", () => {
    let history = appendHistoryPoint([], makeView(1));
    history = appendHistoryPoint(history, makeView(1));
    expect(history).toHaveLength(1);
    expect(history[0]?.decodeTokS).toBe(24.5);
    expect(history[0]?.prefillTokS).toBe(480);
    expect(history[0]?.ttftMs).toBe(240);
    expect(history[0]?.memBwGbS).toBe(218);

    for (let rev = 2; rev <= 75; rev += 1) {
      history = appendHistoryPoint(history, makeView(rev));
    }
    expect(history).toHaveLength(TELEMETRY_HISTORY_CAPACITY);
    expect(history[0]?.revision).toBe(16);
    expect(history.at(-1)?.revision).toBe(75);
  });
});

describe("computeWhatIfForecast", () => {
  const discreteWhatIf: SystemTelemetryWhatIf = {
    gpu: 0,
    window: 32768,
    slots: 4,
    kv_bytes_per_token: 65_536,
    compute_bytes_per_token: 4096,
    fixed_bytes: 16 * GiB,
    room_bytes: 8 * GiB,
    weights_bytes: 14 * GiB,
    active_weight_bytes: 14 * 1_000_000_000,
    memory_bw_ceiling_gb_s: 1008,
    pcie_bandwidth_gb_s: 31.5,
    pool_kind: "discrete",
    host_ram_available_bytes: 32 * GiB,
    kv_dtype_factors: { FP16: 1, Q8_0: 0.5, Q4_0: 0.25 },
  };

  it("classifies fits_gpu when projected usage stays inside pool budget", () => {
    const result = computeWhatIfForecast(discreteWhatIf, {
      concurrency: 2,
      contextTokens: 32768,
      kvQuant: "Q8_0",
    });

    expect(result.verdict).toBe("fits_gpu");
    expect(result.offloadToRamGb).toBe(0);
    expect(result.freeDeltaGb).toBeGreaterThan(0);
    expect(result.predictedDecodeTokS).not.toBeNull();
    expect(result.predictedBwPct).not.toBeNull();
  });

  it("classifies hybrid_offload when discrete GPU spills within host RAM headroom", () => {
    const result = computeWhatIfForecast(discreteWhatIf, {
      concurrency: 8,
      contextTokens: 32768,
      kvQuant: "FP16",
    });

    expect(result.verdict).toBe("hybrid_offload");
    expect(result.offloadToRamGb).toBeGreaterThan(0);
    expect(result.freeDeltaGb).toBeLessThan(0);
  });

  it("classifies oom_risk when exceeding unified pool budget", () => {
    const unifiedWhatIf: SystemTelemetryWhatIf = {
      ...discreteWhatIf,
      pool_kind: "unified",
      room_bytes: 2 * GiB,
    };

    const result = computeWhatIfForecast(unifiedWhatIf, {
      concurrency: 8,
      contextTokens: 65536,
      kvQuant: "FP16",
    });

    expect(result.verdict).toBe("oom_risk");
    expect(result.offloadToRamGb).toBeGreaterThan(0);
  });

  it("scales KV cache bytes monotonically across FP16 > Q8_0 > Q4_0", () => {
    const fp16 = computeWhatIfForecast(discreteWhatIf, {
      concurrency: 4,
      contextTokens: 32768,
      kvQuant: "FP16",
    });
    const q8 = computeWhatIfForecast(discreteWhatIf, {
      concurrency: 4,
      contextTokens: 32768,
      kvQuant: "Q8_0",
    });
    const q4 = computeWhatIfForecast(discreteWhatIf, {
      concurrency: 4,
      contextTokens: 32768,
      kvQuant: "Q4_0",
    });

    expect(fp16.kvCacheGb).toBeCloseTo(q8.kvCacheGb * 2, 2);
    expect(q8.kvCacheGb).toBeCloseTo(q4.kvCacheGb * 2, 2);
  });
});

describe("deriveSnapshotMetrics", () => {
  it("preserves null and basis none for unavailable thermal and power sensors", () => {
    const view = makeView(1, {
      host: { hostname: "sandbox-vm", system: "Linux 6.8", tier: "L4" },
      gpus: [
        {
          index: 0,
          name: "NVIDIA L4",
          total_bytes: 24 * GiB,
          used_bytes: 12 * GiB,
        },
      ],
      gpu_load: [
        {
          index: 0,
          util_pct: 48,
          temp_c: null,
          power_w: null,
          power_limit_w: null,
          basis: "live",
        },
      ],
      sensors: {
        cpu: { overall_pct: { basis: "none", value: null } },
        disk: {
          read_mb_s: { basis: "none", value: null },
          write_mb_s: { basis: "none", value: null },
        },
        memory_pressure: { basis: "none", level: "unknown" },
        watchdog: { basis: "live", status: "clean" },
      },
    });

    const metrics = deriveSnapshotMetrics(view.snapshot);
    expect(metrics.poolKind).toBe("discrete");
    expect(metrics.gpuUtilPct).toBe(48);
    expect(metrics.tempC).toBeNull();
    expect(metrics.tempBasis).toBe("none");
    expect(metrics.powerW).toBeNull();
    expect(metrics.powerBasis).toBe("none");
    expect(metrics.cpuLoadPct).toBeNull();
    expect(metrics.diskReadMbS).toBeNull();
  });

  it("detects Apple Silicon unified memory and computes slot token counts", () => {
    const view = makeView(1, {
      host: {
        hostname: "mac-studio",
        system: "macOS 15.4 (darwin)",
        tier: "M4 Pro",
      },
      gpus: [
        {
          index: 0,
          name: "Apple GPU 20-core",
          total_bytes: 64 * GiB,
          used_bytes: 40 * GiB,
          bandwidth_gb_s: 273,
        },
      ],
      what_if: {
        gpu: 0,
        window: 65536,
        slots: 8,
        kv_bytes_per_token: 32768,
        compute_bytes_per_token: 2048,
        fixed_bytes: 32 * GiB,
        room_bytes: 32 * GiB,
        pool_kind: "unified",
      },
    });

    const metrics = deriveSnapshotMetrics(view.snapshot);
    expect(metrics.poolKind).toBe("unified");
    expect(metrics.poolPct).toBe(63);
    expect(metrics.models[0]?.loading).toBe(false);
    expect(metrics.slots).toHaveLength(1);
    expect(metrics.slots[0]?.cachedTokens).toBe(12000);
    expect(metrics.slots[0]?.prefillTokens).toBe(4000);
    expect(metrics.slots[0]?.decodeTokens).toBe(420);
  });
});
