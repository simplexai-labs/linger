import { TeamHubError } from "@/features/teamhub/teamhub-error";

import type {
  CustomModelFormat,
  CustomModelHub,
  CustomModelProbeHost,
  CustomModelQuantVariant,
} from "./custom-models-queries";
import type {
  LocalModel,
  LocalModelHost,
  LocalModelsView,
  LocalModelView,
} from "./local-models-queries";
import { memorySummary } from "./local-models-rules";

const GIB = 1024 ** 3;
const MEMORY_MULTIPLIER = 1.2;
const MEMORY_OVERHEAD_BYTES = Math.round(0.8 * GIB);
const DISK_HEADROOM_MULTIPLIER = 1.1;
const TIGHT_MEMORY_RATIO = 0.78;
const SAFER_MEMORY_RATIO = 0.85;

export type CustomMemoryTier = "comfortable" | "tight" | "exceeds" | "unknown";
export type CustomModelBadge = "untested" | "verified" | "failed";

export interface ParsedOmniboxInput {
  fileName?: string;
  hub?: CustomModelHub;
  mode: "empty" | "repo" | "search";
  query: string;
  repoId?: string;
  revision?: string;
}

/**
 * Parses omnibox input into a direct repository probe target (Hugging Face URL,
 * ModelScope URL, or `owner/repo` shorthand) or a keyword search query.
 */
export function parseOmniboxInput(
  rawInput: string,
  activeHub: CustomModelHub,
): ParsedOmniboxInput {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return { mode: "empty", query: "" };
  }

  const hfMatch = trimmed.match(
    /^(?:https?:\/\/)?(?:www\.)?huggingface\.co\/([^/\s]+\/[^/\s?#]+)(?:\/(?:blob|resolve)\/([^/\s]+)\/([^?\s#]+))?/i,
  );
  if (hfMatch?.[1]) {
    return {
      fileName: hfMatch[3],
      hub: "huggingface",
      mode: "repo",
      query: trimmed,
      repoId: hfMatch[1].replace(/\.git$/i, ""),
      revision: hfMatch[2],
    };
  }

  const msMatch = trimmed.match(
    /^(?:https?:\/\/)?(?:www\.)?modelscope\.cn\/models\/([^/\s]+\/[^/\s?#]+)(?:\/(?:file\/view|resolve)\/([^/\s]+)\/([^?\s#]+))?/i,
  );
  if (msMatch?.[1]) {
    return {
      fileName: msMatch[3],
      hub: "modelscope",
      mode: "repo",
      query: trimmed,
      repoId: msMatch[1].replace(/\.git$/i, ""),
      revision: msMatch[2],
    };
  }

  const shorthandMatch = trimmed.match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/);
  if (shorthandMatch?.[1]) {
    return {
      hub: activeHub,
      mode: "repo",
      query: trimmed,
      repoId: shorthandMatch[1].replace(/\.git$/i, ""),
    };
  }

  return { hub: activeHub, mode: "search", query: trimmed };
}

export interface CustomHostHeadroom {
  activeCuratedModel?: LocalModel;
  arch?: LocalModelHost["arch"];
  diskFreeBytes: number;
  maxUsableMemoryBytes: number;
  platform?: LocalModelHost["platform"];
  platformLabel: string;
  shortLabel: string;
  softMemoryBudgetBytes: number;
  supportedFormats: readonly CustomModelFormat[];
  supportsMlx: boolean;
}

/**
 * Derives disk and memory headroom for custom-model preflight from a real
 * Computer snapshot, preferring fresher probe host figures when available.
 */
export function deriveCustomHostHeadroom(
  view: LocalModelsView,
  probeHost?: CustomModelProbeHost,
): CustomHostHeadroom {
  const host = view.computer.host;
  const summary = view.available ? memorySummary(view) : undefined;
  const supportedFormats: readonly CustomModelFormat[] = probeHost
    ?.supported_formats?.length
    ? probeHost.supported_formats
    : host?.supported_formats?.length
      ? host.supported_formats
      : ["gguf"];
  const maxUsableMemoryBytes =
    probeHost?.pool_hard_ceiling_bytes ??
    probeHost?.pool_total_bytes ??
    summary?.totalBytes ??
    0;
  const softMemoryBudgetBytes =
    probeHost?.pool_soft_budget_bytes ??
    Math.round(maxUsableMemoryBytes * TIGHT_MEMORY_RATIO);
  const diskFreeBytes =
    probeHost?.disk_free_bytes ?? host?.disk_free_bytes ?? 0;
  const platformLabel =
    [host?.os_label, host?.engine_label].filter(Boolean).join(" · ") ||
    view.computer.display_name;
  const activeCuratedModel = view.models.find(
    (entry) =>
      entry.model.state === "loaded" && entry.model.origin !== "custom",
  )?.model;

  return {
    activeCuratedModel,
    arch: probeHost?.arch ?? host?.arch,
    diskFreeBytes,
    maxUsableMemoryBytes,
    platform: probeHost?.platform ?? host?.platform,
    platformLabel,
    shortLabel: view.computer.display_name,
    softMemoryBudgetBytes,
    supportedFormats,
    supportsMlx: supportedFormats.includes("mlx"),
  };
}

/** Required free disk bytes including 1.1x headroom for `.part` temp files. */
export function requiredDiskBytes(totalDownloadBytes: number): number {
  return Math.ceil(Math.max(0, totalDownloadBytes) * DISK_HEADROOM_MULTIPLIER);
}

/** Transparent fallback memory estimate (`weights * 1.2 + 0.8 GB`). */
export function estimateMemoryBytes(
  weightsBytes: number,
  mmprojBytes = 0,
): number {
  return Math.round(
    Math.max(0, weightsBytes + mmprojBytes) * MEMORY_MULTIPLIER +
      MEMORY_OVERHEAD_BYTES,
  );
}

function variantDiskRequiredBytes(variant: CustomModelQuantVariant): number {
  return variant.disk_required_bytes > 0
    ? variant.disk_required_bytes
    : requiredDiskBytes(variant.total_download_bytes);
}

function variantEstimatedMemoryBytes(variant: CustomModelQuantVariant): number {
  return variant.estimated_memory_bytes > 0
    ? variant.estimated_memory_bytes
    : estimateMemoryBytes(variant.weights_bytes, variant.mmproj_bytes);
}

export interface PreflightAssessment {
  canStartDownload: boolean;
  diskFreeBytes: number;
  diskOk: boolean;
  diskRequiredBytes: number;
  diskShortfallBytes: number;
  estimatedMemoryBytes: number;
  hostMaxMemoryBytes: number;
  memoryEstimateBasis: CustomModelQuantVariant["memory_estimate_basis"];
  memoryTier: CustomMemoryTier;
  metadataNote?: string;
  requiresEscapeHatch: boolean;
  smallerDiskFitQuant: CustomModelQuantVariant | null;
  smallerMemoryQuant: CustomModelQuantVariant | null;
}

/**
 * Evaluates disk hard-stop (1.1x headroom) and transparent memory comfort tiers.
 * Disk insufficiency blocks download; memory estimates never dead-end and
 * instead require the explicit Standby-First escape hatch.
 */
export function evaluatePreflight(input: {
  host: CustomHostHeadroom;
  metadataComplete?: boolean;
  metadataNote?: string;
  quantVariants: readonly CustomModelQuantVariant[];
  selectedQuant: CustomModelQuantVariant;
}): PreflightAssessment {
  const {
    host,
    metadataComplete = true,
    metadataNote,
    quantVariants,
    selectedQuant,
  } = input;

  const diskReq = variantDiskRequiredBytes(selectedQuant);
  const diskOk =
    host.diskFreeBytes > 0
      ? diskReq <= host.diskFreeBytes
      : selectedQuant.disk_ok;
  const diskShortfallBytes = Math.max(0, diskReq - host.diskFreeBytes);

  const estMem = variantEstimatedMemoryBytes(selectedQuant);
  const maxMem = host.maxUsableMemoryBytes;
  const softMem =
    host.softMemoryBudgetBytes > 0
      ? host.softMemoryBudgetBytes
      : Math.round(maxMem * TIGHT_MEMORY_RATIO);

  const smallerDiskFitQuant =
    quantVariants
      .filter((candidate) => {
        const req = variantDiskRequiredBytes(candidate);
        return (
          candidate.id !== selectedQuant.id &&
          (host.diskFreeBytes > 0
            ? req <= host.diskFreeBytes
            : candidate.disk_ok)
        );
      })
      .sort((a, b) => b.total_download_bytes - a.total_download_bytes)[0] ??
    null;

  const smallerMemoryQuant =
    quantVariants
      .filter((candidate) => {
        if (candidate.id === selectedQuant.id) return false;
        if (
          candidate.total_download_bytes >= selectedQuant.total_download_bytes
        )
          return false;
        const req = variantDiskRequiredBytes(candidate);
        const fitsDisk =
          host.diskFreeBytes > 0
            ? req <= host.diskFreeBytes
            : candidate.disk_ok;
        if (!fitsDisk) return false;
        const candMem = variantEstimatedMemoryBytes(candidate);
        return maxMem > 0
          ? candMem <= maxMem * SAFER_MEMORY_RATIO
          : candidate.memory_status === "comfortable";
      })
      .sort((a, b) => b.total_download_bytes - a.total_download_bytes)[0] ??
    null;

  let memoryTier: CustomMemoryTier;
  if (!metadataComplete) {
    memoryTier = "unknown";
  } else if (
    selectedQuant.memory_status === "exceeds" ||
    (maxMem > 0 && estMem > maxMem)
  ) {
    memoryTier = "exceeds";
  } else if (
    selectedQuant.memory_status === "tight" ||
    (softMem > 0 && estMem > softMem)
  ) {
    memoryTier = "tight";
  } else {
    memoryTier = "comfortable";
  }

  const requiresEscapeHatch =
    memoryTier === "exceeds" || memoryTier === "unknown";

  return {
    canStartDownload: diskOk,
    diskFreeBytes: host.diskFreeBytes,
    diskOk,
    diskRequiredBytes: diskReq,
    diskShortfallBytes,
    estimatedMemoryBytes: estMem,
    hostMaxMemoryBytes: maxMem,
    memoryEstimateBasis: selectedQuant.memory_estimate_basis,
    memoryTier,
    metadataNote,
    requiresEscapeHatch,
    smallerDiskFitQuant,
    smallerMemoryQuant,
  };
}

/** Picks the default quantization variant for a probed repository on this host. */
export function selectSweetSpotQuant(
  variants: readonly CustomModelQuantVariant[],
  host: CustomHostHeadroom,
  options?: {
    matchedFileName?: string;
    recommendedVariantId?: string;
    selectedQuantId?: string;
  },
): CustomModelQuantVariant | null {
  if (variants.length === 0) return null;

  if (options?.matchedFileName) {
    const target = options.matchedFileName.toLowerCase();
    const fileMatch = variants.find((variant) =>
      variant.files.some((file) => file.path.toLowerCase().includes(target)),
    );
    if (fileMatch) return fileMatch;
  }

  if (options?.selectedQuantId) {
    const exact = variants.find((v) => v.id === options.selectedQuantId);
    if (exact) return exact;
  }

  if (options?.recommendedVariantId) {
    const recommended = variants.find(
      (v) => v.id === options.recommendedVariantId,
    );
    if (recommended) return recommended;
  }

  const q4 = variants.find(
    (v) =>
      v.quant.toUpperCase() === "Q4_K_M" || v.label.toUpperCase() === "Q4_K_M",
  );
  if (q4) {
    const check = evaluatePreflight({
      host,
      quantVariants: variants,
      selectedQuant: q4,
    });
    if (check.diskOk && !check.requiresEscapeHatch) {
      return q4;
    }
  }

  const diskFitting = variants.filter((v) =>
    host.diskFreeBytes > 0
      ? variantDiskRequiredBytes(v) <= host.diskFreeBytes
      : v.disk_ok,
  );
  const comfortable = diskFitting
    .filter(
      (v) =>
        evaluatePreflight({ host, quantVariants: variants, selectedQuant: v })
          .memoryTier === "comfortable",
    )
    .sort((a, b) => b.total_download_bytes - a.total_download_bytes);
  if (comfortable[0]) return comfortable[0];

  const tight = diskFitting
    .filter(
      (v) =>
        evaluatePreflight({ host, quantVariants: variants, selectedQuant: v })
          .memoryTier === "tight",
    )
    .sort((a, b) => b.total_download_bytes - a.total_download_bytes);
  if (tight[0]) return tight[0];

  return q4 ?? variants[0] ?? null;
}

/** Whether a library entry was installed from a custom community hub repository. */
export function isCustomModel(model: LocalModel): boolean {
  return model.origin === "custom";
}

/** Standby-First verification badge state for an installed custom model. */
export function customModelBadge(model: LocalModel): CustomModelBadge {
  if (model.verification?.status === "verified") return "verified";
  if (model.verification?.status === "failed") return "failed";
  return "untested";
}

/** Installed custom models on disk (excluding absent and currently downloading). */
export function installedCustomModels(view: LocalModelsView): LocalModelView[] {
  return view.models.filter(
    (entry) =>
      entry.model.origin === "custom" &&
      entry.model.state !== "absent" &&
      entry.model.state !== "downloading",
  );
}

/** Active custom model download in the current snapshot, if any. */
export function activeCustomDownload(
  view: LocalModelsView,
): LocalModelView | undefined {
  return view.models.find(
    (entry) =>
      entry.model.origin === "custom" && entry.model.state === "downloading",
  );
}

/** Compact count label for hub pulls/likes (for example `1.4M`, `184.2K`). */
export function formatCompactCount(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(count >= 100_000 ? 0 : 1)}K`;
  }
  return String(count);
}

/** Whether an error indicates the Computer daemon predates custom model support. */
export function isCustomUnsupportedError(error: unknown): boolean {
  return (
    error instanceof TeamHubError &&
    error.code === "LOCAL_MODELS_CUSTOM_UNSUPPORTED"
  );
}
