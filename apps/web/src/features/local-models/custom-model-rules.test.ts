import { describe, expect, it } from "vitest";

import { TeamHubError } from "@/features/teamhub/teamhub-error";

import type { CustomModelQuantVariant } from "./custom-models-queries";
import {
  activeCustomDownload,
  customModelBadge,
  deriveCustomHostHeadroom,
  estimateMemoryBytes,
  evaluatePreflight,
  formatCompactCount,
  installedCustomModels,
  isCustomUnsupportedError,
  parseOmniboxInput,
  requiredDiskBytes,
  selectSweetSpotQuant,
} from "./custom-model-rules";
import {
  gb,
  labView,
  localModel,
  macView,
  modelView,
} from "./local-models-test-support";

function makeVariant(
  overrides: Partial<CustomModelQuantVariant> &
    Pick<CustomModelQuantVariant, "id" | "label">,
): CustomModelQuantVariant {
  const weightsBytes = overrides.weights_bytes ?? gb(4.68);
  const mmprojBytes = overrides.mmproj_bytes ?? 0;
  const totalDownloadBytes =
    overrides.total_download_bytes ?? weightsBytes + mmprojBytes;
  return {
    already_installed: false,
    custom_model_id: `custom.hf.bartowski--qwen2.5-7b-instruct-gguf:${overrides.label}`,
    disk_ok: true,
    disk_required_bytes: requiredDiskBytes(totalDownloadBytes),
    estimated_memory_bytes: estimateMemoryBytes(weightsBytes, mmprojBytes),
    files: [
      { path: `model-${overrides.label}.gguf`, size_bytes: weightsBytes },
    ],
    memory_estimate_basis: "rough_1.2x_plus_0.8gb",
    memory_status: "comfortable",
    mmproj_bytes: mmprojBytes,
    quant: overrides.label,
    shard_count: 1,
    sharded: false,
    total_download_bytes: totalDownloadBytes,
    weights_bytes: weightsBytes,
    ...overrides,
  };
}

describe("custom-model-rules", () => {
  it("parses HF URLs, blob/resolve file URLs, ModelScope URLs, owner/repo shorthand, and keyword queries", () => {
    expect(
      parseOmniboxInput(
        "https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/blob/main/Qwen2.5-7B-Instruct-Q6_K.gguf",
        "huggingface",
      ),
    ).toMatchObject({
      fileName: "Qwen2.5-7B-Instruct-Q6_K.gguf",
      hub: "huggingface",
      mode: "repo",
      repoId: "bartowski/Qwen2.5-7B-Instruct-GGUF",
      revision: "main",
    });

    expect(
      parseOmniboxInput(
        "https://modelscope.cn/models/Qwen/Qwen2.5-32B-Instruct-GGUF",
        "huggingface",
      ),
    ).toMatchObject({
      hub: "modelscope",
      mode: "repo",
      repoId: "Qwen/Qwen2.5-32B-Instruct-GGUF",
    });

    expect(
      parseOmniboxInput(
        "https://modelscope.cn/models/Qwen/Qwen2.5-32B-Instruct-GGUF/file/view/master/qwen2.5-32b-q4_k_m.gguf",
        "huggingface",
      ),
    ).toMatchObject({
      fileName: "qwen2.5-32b-q4_k_m.gguf",
      hub: "modelscope",
      mode: "repo",
      repoId: "Qwen/Qwen2.5-32B-Instruct-GGUF",
      revision: "master",
    });

    expect(
      parseOmniboxInput("bartowski/Qwen2.5-7B-Instruct-GGUF", "modelscope"),
    ).toMatchObject({
      hub: "modelscope",
      mode: "repo",
      repoId: "bartowski/Qwen2.5-7B-Instruct-GGUF",
    });

    expect(parseOmniboxInput("qwen vision 7b", "huggingface")).toMatchObject({
      hub: "huggingface",
      mode: "search",
      query: "qwen vision 7b",
    });

    expect(parseOmniboxInput("   ", "huggingface")).toEqual({
      mode: "empty",
      query: "",
    });
  });

  it("derives real host headroom from LocalModelsView and overrides with probe host when present", () => {
    const view = macView();
    const headroom = deriveCustomHostHeadroom(view);
    expect(headroom.diskFreeBytes).toBe(gb(188));
    expect(headroom.maxUsableMemoryBytes).toBe(gb(51.2));
    expect(headroom.activeCuratedModel?.id).toBe("gpt-oss-20b:Q4_K_M");
    expect(headroom.supportsMlx).toBe(false);

    const probedHeadroom = deriveCustomHostHeadroom(view, {
      arch: "arm64",
      disk_free_bytes: gb(42),
      platform: "darwin",
      pool_hard_ceiling_bytes: gb(12.8),
      pool_soft_budget_bytes: gb(10),
      pool_total_bytes: gb(12.8),
      supported_formats: ["gguf", "mlx"],
      target_pool: "unified",
    });
    expect(probedHeadroom.diskFreeBytes).toBe(gb(42));
    expect(probedHeadroom.maxUsableMemoryBytes).toBe(gb(12.8));
    expect(probedHeadroom.softMemoryBudgetBytes).toBe(gb(10));
    expect(probedHeadroom.supportsMlx).toBe(true);
  });

  it("enforces 1.1x disk hard-stop and recommends a smaller disk-fitting quant", () => {
    const view = labView();
    const host = deriveCustomHostHeadroom(view, {
      arch: "x86_64",
      disk_free_bytes: gb(5.2),
      platform: "linux",
      pool_hard_ceiling_bytes: gb(16),
      pool_soft_budget_bytes: gb(12.5),
      supported_formats: ["gguf"],
    });
    const q2 = makeVariant({
      id: "Q2_K",
      label: "Q2_K",
      weights_bytes: gb(4.4),
    });
    const q4 = makeVariant({
      id: "Q4_K_M",
      label: "Q4_K_M",
      weights_bytes: gb(9.0),
    });

    const assessment = evaluatePreflight({
      host,
      quantVariants: [q2, q4],
      selectedQuant: q4,
    });

    expect(assessment.diskOk).toBe(false);
    expect(assessment.canStartDownload).toBe(false);
    expect(assessment.diskRequiredBytes).toBe(requiredDiskBytes(gb(9.0)));
    expect(assessment.smallerDiskFitQuant?.id).toBe("Q2_K");
  });

  it("classifies comfortable, tight, exceeds, and incomplete metadata tiers with escape hatch", () => {
    const view = macView();
    const host = deriveCustomHostHeadroom(view, {
      arch: "arm64",
      disk_free_bytes: gb(100),
      platform: "darwin",
      pool_hard_ceiling_bytes: gb(12.8),
      pool_soft_budget_bytes: gb(10),
      supported_formats: ["gguf"],
    });
    const small = makeVariant({
      id: "Q4_K_M",
      label: "Q4_K_M",
      memory_status: "comfortable",
      weights_bytes: gb(4.5),
    });
    const medium = makeVariant({
      id: "Q8_0",
      label: "Q8_0",
      memory_status: "tight",
      weights_bytes: gb(8.5),
    });
    const huge = makeVariant({
      id: "Q4_K_M_32B",
      label: "Q4_K_M",
      memory_status: "exceeds",
      weights_bytes: gb(19.8),
    });

    const comfy = evaluatePreflight({
      host,
      quantVariants: [small, medium, huge],
      selectedQuant: small,
    });
    expect(comfy.memoryTier).toBe("comfortable");
    expect(comfy.requiresEscapeHatch).toBe(false);
    expect(comfy.canStartDownload).toBe(true);

    const tight = evaluatePreflight({
      host,
      quantVariants: [small, medium, huge],
      selectedQuant: medium,
    });
    expect(tight.memoryTier).toBe("tight");
    expect(tight.requiresEscapeHatch).toBe(false);
    expect(tight.smallerMemoryQuant?.id).toBe("Q4_K_M");

    const exceeds = evaluatePreflight({
      host,
      quantVariants: [small, medium, huge],
      selectedQuant: huge,
    });
    expect(exceeds.memoryTier).toBe("exceeds");
    expect(exceeds.requiresEscapeHatch).toBe(true);
    expect(exceeds.canStartDownload).toBe(true);

    const unknownMeta = evaluatePreflight({
      host,
      metadataComplete: false,
      metadataNote: "Missing GGUF header metadata",
      quantVariants: [small],
      selectedQuant: small,
    });
    expect(unknownMeta.memoryTier).toBe("unknown");
    expect(unknownMeta.requiresEscapeHatch).toBe(true);
    expect(unknownMeta.canStartDownload).toBe(true);
  });

  it("selects sweet-spot quantization by matched file, recommended ID, or fitting Q4_K_M", () => {
    const view = macView();
    const host = deriveCustomHostHeadroom(view);
    const q3 = makeVariant({
      id: "Q3_K_M",
      label: "Q3_K_M",
      weights_bytes: gb(3.8),
    });
    const q4 = makeVariant({
      id: "Q4_K_M",
      label: "Q4_K_M",
      weights_bytes: gb(4.7),
    });
    const q6 = makeVariant({
      id: "Q6_K",
      label: "Q6_K",
      weights_bytes: gb(6.3),
    });

    expect(
      selectSweetSpotQuant([q3, q4, q6], host, {
        matchedFileName: "model-Q6_K.gguf",
      })?.id,
    ).toBe("Q6_K");
    expect(
      selectSweetSpotQuant([q3, q4, q6], host, {
        recommendedVariantId: "Q3_K_M",
      })?.id,
    ).toBe("Q3_K_M");
    expect(selectSweetSpotQuant([q3, q4, q6], host)?.id).toBe("Q4_K_M");
  });

  it("extracts installed custom models, active custom downloads, badges, counts, and unsupported errors", () => {
    const downloadingCustom = localModel({
      id: "custom.hf.org--repo:Q4_K_M",
      name: "Custom Repo",
      origin: "custom",
      state: "downloading",
    });
    const verifiedCustom = localModel({
      id: "custom.hf.org--verified:Q4_K_M",
      name: "Verified Custom",
      origin: "custom",
      state: "idle",
      verification: { status: "verified" },
    });
    const failedCustom = localModel({
      id: "custom.hf.org--failed:Q4_K_M",
      name: "Failed Custom",
      origin: "custom",
      state: "idle",
      verification: { status: "failed" },
    });

    const view = macView({
      models: [
        ...macView().models,
        modelView(downloadingCustom),
        modelView(verifiedCustom),
        modelView(failedCustom),
      ],
    });

    expect(activeCustomDownload(view)?.model.id).toBe(downloadingCustom.id);
    expect(installedCustomModels(view).map((e) => e.model.id)).toEqual([
      verifiedCustom.id,
      failedCustom.id,
    ]);
    expect(customModelBadge(verifiedCustom)).toBe("verified");
    expect(customModelBadge(failedCustom)).toBe("failed");
    expect(customModelBadge(downloadingCustom)).toBe("untested");
    expect(formatCompactCount(1_450_000)).toBe("1.4M");
    expect(formatCompactCount(184_210)).toBe("184K");
    expect(formatCompactCount(8_400)).toBe("8.4K");
    expect(formatCompactCount(412)).toBe("412");
    expect(
      isCustomUnsupportedError(
        new TeamHubError({
          code: "LOCAL_MODELS_CUSTOM_UNSUPPORTED",
          message: "Upgrade required",
          status: 409,
        }),
      ),
    ).toBe(true);
    expect(isCustomUnsupportedError(new Error("other"))).toBe(false);
  });
});
