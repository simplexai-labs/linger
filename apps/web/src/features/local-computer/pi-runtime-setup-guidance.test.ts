import { describe, expect, it } from "vitest";

import type { LocalModelsView } from "@/features/local-models/local-models-queries";

import { computersMessages } from "./computers.messages";
import {
  classifyPiLocalModelsState,
  piAuthRequiredStatusMessage,
} from "./pi-runtime-setup-guidance";

function localModelsView(
  overrides: Partial<LocalModelsView> = {},
): LocalModelsView {
  return {
    available: true,
    computer: {
      computer_id: "computer-1",
      display_name: "Studio Mac",
      status: "online",
    },
    models: [],
    pools: [],
    viewer_is_owner: true,
    ...overrides,
  };
}

function modelRow(
  overrides: Partial<LocalModelsView["models"][number]["model"]>,
): LocalModelsView["models"][number] {
  return {
    model: {
      availability: { downloadable: true },
      context_tokens: 131072,
      description: "",
      download_bytes: 0,
      fit: "unified",
      id: "qwen3-coder-30b:Q4_K_M",
      memory_bytes: 18_000_000_000,
      name: "Qwen3 Coder 30B",
      pi_model: "localmodels-library/qwen3-coder-30b",
      pool: "unified",
      quant: "Q4_K_M",
      recommended: true,
      state: "absent",
      vision: false,
      ...overrides,
    },
    used_by: [],
  };
}

describe("classifyPiLocalModelsState", () => {
  it("returns unknown when no snapshot has loaded", () => {
    const state = classifyPiLocalModelsState(undefined);
    expect(state).toEqual({ kind: "unknown" });
    expect(piAuthRequiredStatusMessage(state)).toBe(
      computersMessages.statusSignInRequired,
    );
  });

  it("returns unavailable when local models tool is absent", () => {
    const state = classifyPiLocalModelsState(
      localModelsView({
        available: false,
        reason: { code: "TOOL_NOT_INSTALLED" },
      }),
    );
    expect(state).toEqual({ kind: "unavailable" });
    expect(piAuthRequiredStatusMessage(state)).toBe(
      computersMessages.statusSignInRequired,
    );
  });

  it("returns no_local_model when library is available and all models are absent", () => {
    const state = classifyPiLocalModelsState(
      localModelsView({ models: [modelRow({ state: "absent" })] }),
    );
    expect(state).toEqual({ kind: "no_local_model" });
    expect(piAuthRequiredStatusMessage(state)).toBe(
      computersMessages.statusModelNeeded,
    );
  });

  it("returns downloading with percentage when a model is downloading", () => {
    const state = classifyPiLocalModelsState(
      localModelsView({
        models: [
          modelRow({
            download: {
              bytes_per_second: 10_000_000,
              done_bytes: 750,
              step: "download",
              total_bytes: 1_000,
            },
            state: "downloading",
          }),
        ],
      }),
    );
    expect(state).toEqual({
      kind: "downloading",
      modelName: "Qwen3 Coder 30B",
      percent: 75,
    });
    expect(piAuthRequiredStatusMessage(state)).toBe(
      computersMessages.statusDownloadingModel,
    );
  });

  it("returns loading when a model is loading", () => {
    const state = classifyPiLocalModelsState(
      localModelsView({ models: [modelRow({ state: "loading" })] }),
    );
    expect(state).toEqual({
      kind: "loading",
      modelName: "Qwen3 Coder 30B",
    });
    expect(piAuthRequiredStatusMessage(state)).toBe(
      computersMessages.statusLoadingModel,
    );
  });

  it("returns download_stopped when only a partial failed download exists", () => {
    const state = classifyPiLocalModelsState(
      localModelsView({
        models: [
          modelRow({
            error: { code: "DOWNLOAD_FAILED" },
            state: "failed",
          }),
        ],
      }),
    );
    expect(state).toEqual({
      kind: "download_stopped",
      modelName: "Qwen3 Coder 30B",
    });
    expect(piAuthRequiredStatusMessage(state)).toBe(
      computersMessages.statusModelNeeded,
    );
  });

  it("returns models_installed when a downloaded model is idle or loaded", () => {
    const state = classifyPiLocalModelsState(
      localModelsView({ models: [modelRow({ state: "idle" })] }),
    );
    expect(state).toEqual({ kind: "models_installed" });
    expect(piAuthRequiredStatusMessage(state)).toBe(
      computersMessages.statusSignInRequired,
    );
  });
});
