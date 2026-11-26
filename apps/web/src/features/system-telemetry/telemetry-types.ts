import type { components } from "@linger/wire-contracts/teamhub-public/types";

export type TelemetryBasis = components["schemas"]["TelemetryBasis"];
export type SystemTelemetryBottleneck =
  components["schemas"]["SystemTelemetryBottleneck"];
export type SystemTelemetryFigure =
  components["schemas"]["SystemTelemetryFigure"];
export type SystemTelemetrySegment =
  components["schemas"]["SystemTelemetrySegment"];
export type SystemTelemetryGpu = components["schemas"]["SystemTelemetryGpu"];
export type SystemTelemetryGpuLoad =
  components["schemas"]["SystemTelemetryGpuLoad"];
export type SystemTelemetryMemory =
  components["schemas"]["SystemTelemetryMemory"];
export type SystemTelemetrySlot = components["schemas"]["SystemTelemetrySlot"];
export type SystemTelemetrySlotPhase =
  components["schemas"]["SystemTelemetrySlotPhase"];
export type SystemTelemetryComponent =
  components["schemas"]["SystemTelemetryComponent"];
export type SystemTelemetryClient =
  components["schemas"]["SystemTelemetryClient"];
export type SystemTelemetryGateway =
  components["schemas"]["SystemTelemetryGateway"];
export type SystemTelemetryWhatIf =
  components["schemas"]["SystemTelemetryWhatIf"];
export type SystemTelemetryPoolKind =
  components["schemas"]["SystemTelemetryPoolKind"];
export type SystemTelemetryHostSensors =
  components["schemas"]["SystemTelemetryHostSensors"];
export type SystemTelemetryMemoryPressureLevel =
  components["schemas"]["SystemTelemetryMemoryPressureLevel"];
export type SystemTelemetryWatchdogStatus =
  components["schemas"]["SystemTelemetryWatchdogStatus"];
export type SystemTelemetryWaterfallEntry =
  components["schemas"]["SystemTelemetryWaterfallEntry"];
export type SystemTelemetrySnapshot =
  components["schemas"]["SystemTelemetrySnapshot"];
export type SystemTelemetryView = components["schemas"]["SystemTelemetryView"];
export type SystemTelemetryErrorCode =
  components["schemas"]["SystemTelemetryErrorCode"];

export interface SystemTelemetryStreamStatus {
  readonly computer_id: string;
  readonly status: "offline" | "unsupported" | "unavailable";
  readonly code: SystemTelemetryErrorCode;
  readonly message: string;
}

export type TelemetryStreamPhase =
  | "loading"
  | "live"
  | "paused"
  | "offline"
  | "unsupported"
  | "forbidden"
  | "error";

export type TelemetryAccentKey = "rain" | "lichen" | "bluebell" | "lavender";

export type MemorySegmentCategory =
  | "weights"
  | "kv_cache"
  | "compute_buf"
  | "external_apps"
  | "reserve"
  | "free";

export interface TelemetryHistoryPoint {
  readonly revision: number;
  readonly observedAtMs: number;
  readonly decodeTokS: number;
  readonly prefillTokS: number;
  readonly ttftMs: number;
  readonly memBwGbS: number;
  readonly effectiveDecodeBwGbS: number;
}

export type TelemetryOpticalTarget =
  | { readonly kind: "none" }
  | {
      readonly kind: "client";
      readonly id: string;
      readonly name: string;
      readonly targetModelId?: string;
    }
  | {
      readonly kind: "model";
      readonly id: string;
      readonly name: string;
    };

export type WhatIfContextOption = 8192 | 16384 | 32768 | 65536 | 131072;
export type WhatIfKvQuant = "FP16" | "Q8_0" | "Q4_0";

export interface WhatIfInput {
  readonly concurrency: number;
  readonly contextTokens: WhatIfContextOption;
  readonly kvQuant: WhatIfKvQuant;
}

export type WhatIfVerdict = "fits_gpu" | "hybrid_offload" | "oom_risk";

export interface WhatIfForecast {
  readonly weightsGb: number;
  readonly kvCacheGb: number;
  readonly computeGb: number;
  readonly fixedGb: number;
  readonly totalRequiredGb: number;
  readonly poolBudgetGb: number;
  readonly freeDeltaGb: number;
  readonly offloadToRamGb: number;
  readonly predictedDecodeTokS: number | null;
  readonly predictedBwPct: number | null;
  readonly predictedTtftMs: number | null;
  readonly verdict: WhatIfVerdict;
  readonly poolKind: SystemTelemetryPoolKind;
}

export interface DerivedMemorySegment {
  readonly id: string;
  readonly category: MemorySegmentCategory;
  readonly label: string;
  readonly bytes: number;
  readonly gb: number;
  readonly basis: TelemetryBasis;
}

export interface DerivedPiClientNode {
  readonly id: string;
  readonly name: string;
  readonly targetModelId: string;
  readonly accent: TelemetryAccentKey;
  readonly activeStreams: number;
  readonly recentRequests: number;
  readonly recentTokS: number | null;
}

export interface DerivedModelNode {
  readonly id: string;
  readonly componentId: string;
  readonly name: string;
  readonly quant: string;
  readonly device: string;
  readonly state: string;
  readonly memoryGb: number;
  readonly maxSlots: number;
  readonly activeSlots: number;
  readonly decodeTokS: number | null;
  readonly loading: boolean;
}

export interface DerivedLiveSlot {
  readonly key: string;
  readonly slotIndex: number;
  readonly modelName: string;
  readonly active: boolean;
  readonly phase: SystemTelemetrySlotPhase;
  readonly nCtx: number;
  readonly cachedTokens: number;
  readonly prefillTokens: number;
  readonly decodeTokens: number;
  readonly tokS: number | null;
  readonly ttftMs: number | null;
}

export interface DerivedProvenanceItem {
  readonly id: string;
  readonly basis: TelemetryBasis;
  readonly detail?: string;
}

export interface DerivedTelemetryMetrics {
  readonly poolKind: SystemTelemetryPoolKind;
  readonly gpuLabel: string;
  readonly poolTotalGb: number | null;
  readonly poolUsedGb: number | null;
  readonly poolFreeGb: number | null;
  readonly poolPct: number | null;
  readonly hostRamTotalGb: number | null;
  readonly hostRamUsedGb: number | null;
  readonly segments: readonly DerivedMemorySegment[];
  readonly externalHolders: readonly string[];
  readonly externalBytesGb: number;
  readonly decodeTokS: number | null;
  readonly prefillTokS: number | null;
  readonly effectiveDecodeBwGbS: number | null;
  readonly effectiveDecodeBwBasis: TelemetryBasis;
  readonly bwCeilingGbS: number | null;
  readonly bwCeilingPct: number | null;
  readonly activeWeightGb: number | null;
  readonly gpuUtilPct: number | null;
  readonly gpuUtilBasis: TelemetryBasis;
  readonly memCtrlUtilPct: number | null;
  readonly tempC: number | null;
  readonly tempBasis: TelemetryBasis;
  readonly powerW: number | null;
  readonly powerLimitW: number | null;
  readonly powerBasis: TelemetryBasis;
  readonly cpuLoadPct: number | null;
  readonly cpuBasis: TelemetryBasis;
  readonly cpuCores: readonly { readonly core: number; readonly pct: number }[];
  readonly logicalCores: number | null;
  readonly diskReadMbS: number | null;
  readonly diskReadBasis: TelemetryBasis;
  readonly inFlight: number;
  readonly maxSlots: number;
  readonly deferredCount: number | null;
  readonly p50TtftMs: number | null;
  readonly prefixHitPct: number | null;
  readonly kvCacheUsagePct: number | null;
  readonly pressureLevel: SystemTelemetryMemoryPressureLevel;
  readonly watchdogStatus: SystemTelemetryWatchdogStatus;
  readonly bottleneck: SystemTelemetryBottleneck;
  readonly gatewayAddr: string | null;
  readonly clients: readonly DerivedPiClientNode[];
  readonly models: readonly DerivedModelNode[];
  readonly slots: readonly DerivedLiveSlot[];
  readonly waterfall: readonly SystemTelemetryWaterfallEntry[];
  readonly collectorSummary: string | null;
  readonly hostSystem: string | null;
  readonly provenance: readonly DerivedProvenanceItem[];
}
