import { describe, expect, it } from "vitest";

import { translate } from "@/i18n/language";

import {
  actionErrorCopy,
  concurrencyCopy,
  debugBannerCopy,
  engineBadgeCopy,
  engineHintCopy,
  hostBlockerCopy,
  modelErrorCopy,
  modelErrorShortCopy,
  unavailableCopy,
  unavailableShortCopy,
} from "./local-models-copy";
import {
  buildModelGroups,
  collapsedRowBadges,
  compactContextLabel,
  contextLabel,
  downloadPercent,
  downloadStatusDetail,
  downloadStopped,
  featuredInklingEntry,
  formatGigabytes,
  hostBlocker,
  isModelOnComputer,
  loadCheck,
  localSwitchTargets,
  makeRoomSelection,
  makesRoom,
  memoryGuidance,
  memoryReclaimable,
  memorySegments,
  memorySummary,
  modelBaseName,
  modelCapabilities,
  modelEntries,
  modelGroupKey,
  parametersLabel,
  placeName,
  poolLabel,
  poolOtherBytes,
  poolUnaccountedBytes,
  safeModelSourceUrl,
  speedLabel,
  usedByBadge,
} from "./local-models-rules";
import {
  gb,
  gpuPool,
  labView,
  localModel,
  macView,
  memoryPool,
  modelView,
} from "./local-models-test-support";

function loaded(id: string, memoryGb: number, usedBy: string[] = []) {
  return modelView(
    localModel({
      id,
      memory_bytes: gb(memoryGb),
      name: id,
      pool: "gpu:0",
      state: "loaded",
    }),
    usedBy,
  );
}

describe("local models rules", () => {
  it("orders models by status, then the recommended one, then by fit", () => {
    expect(
      modelEntries(labView()).map(
        (entry) => `${entry.model.name}: ${entry.status}`,
      ),
    ).toEqual([
      "Qwen3 Coder 30B: loaded",
      "Gemma 3 27B: idle",
      "GPT-OSS 20B: available",
      "Gemma 3 4B: available",
      "Llama 3.3 70B: available",
      "Llama 3.1 405B: unavailable",
    ]);
  });

  it("formats every size in GB with at most one decimal", () => {
    expect(formatGigabytes(gb(0.6), translate)).toBe("0.6 GB");
    expect(formatGigabytes(0, translate)).toBe("0 GB");
    expect(formatGigabytes(gb(46), translate)).toBe("46 GB");
    expect(formatGigabytes(gb(21.44), translate)).toBe("21.4 GB");
  });

  it("names pools from what the Computer reported", () => {
    const view = labView();
    expect(view.pools.map((pool) => poolLabel(view, pool, translate))).toEqual([
      "GPU 0 · RTX 4090",
      "GPU 1 · RTX 4090",
      "System memory",
    ]);
    expect(placeName(view, "gpu:1", translate)).toBe("GPU 1");
    expect(placeName(view, "system", translate)).toBe("system memory");
    expect(placeName(macView(), "unified", translate)).toBe("memory");
    // A model that fits nowhere has no placement to show.
    expect(placeName(view, undefined, translate)).toBeUndefined();
  });

  it("adds up GPU memory, or the memory of a Computer without GPUs", () => {
    expect(memorySummary(labView())).toEqual({
      freeBytes: gb(2.6) + gb(22.9),
      gpu: true,
      totalBytes: gb(24) * 2,
      usedBytes: gb(21.4) + gb(1.1),
    });
    expect(memorySummary(macView())).toEqual({
      freeBytes: gb(51.2) - gb(14.3),
      gpu: false,
      totalBytes: gb(51.2),
      usedBytes: gb(14.3),
    });
  });

  it("derives memory bar segments from the same pools as memorySummary", () => {
    const view = labView({
      pools: [
        {
          ...gpuPool(0, 24, [
            { gb: 10, id: "shared:Q4", name: "Shared Model" },
            { component: true, gb: 1.5, id: "embed", name: "Embeddings" },
          ]),
          used_bytes: gb(15.5),
        },
        gpuPool(1, 24, [{ gb: 6, id: "shared:Q4", name: "Shared Model" }]),
        // System RAM should be excluded when GPUs are present, matching memorySummary.
        {
          ...memoryPool("system", 64, [
            { gb: 8, id: "ram-only:Q4", name: "RAM Model" },
          ]),
          used_bytes: gb(20),
        },
      ],
    });
    expect(memorySegments(view)).toEqual({
      componentBytes: gb(1.5),
      models: [{ bytes: gb(16), id: "shared:Q4", name: "Shared Model" }],
      otherBytes: gb(4),
      unaccountedBytes: 0,
    });

    expect(memorySegments(macView())).toEqual({
      componentBytes: 0,
      models: [
        { bytes: gb(14.3), id: "gpt-oss-20b:Q4_K_M", name: "GPT-OSS 20B" },
      ],
      otherBytes: 0,
      unaccountedBytes: 0,
    });
  });

  it("attributes other apps memory only to external holders and separates unaccounted overhead", () => {
    // 16 GB card with 7.5 GB model, 15 GB total used.
    // external_holders has desktop apps using 0.2 GB.
    const poolWithHolders = {
      ...gpuPool(0, 16, [
        { gb: 7.5, id: "inkling-2-mini", name: "Inkling 2 Mini" },
      ]),
      external_holders: [{ bytes: gb(0.2), name: "browser" }],
      used_bytes: gb(15),
    };

    // Residual is 15 - 7.5 = 7.5 GB.
    // Other apps should only be the 0.2 GB from external_holders.
    expect(poolOtherBytes(poolWithHolders)).toBe(gb(0.2));
    // Remaining 7.3 GB is unaccounted (system/engine overhead).
    expect(poolUnaccountedBytes(poolWithHolders)).toBe(gb(7.3));

    // When external_holders is empty list (no closeable apps found)
    const poolNoExternalApps = {
      ...gpuPool(0, 16, [
        { gb: 7.5, id: "inkling-2-mini", name: "Inkling 2 Mini" },
      ]),
      external_holders: [],
      used_bytes: gb(15),
    };
    expect(poolOtherBytes(poolNoExternalApps)).toBe(0);
    expect(poolUnaccountedBytes(poolNoExternalApps)).toBe(gb(7.5));

    // When external_holders is undefined (legacy daemon/localmodels)
    const legacyPool = {
      ...gpuPool(0, 16, [
        { gb: 7.5, id: "inkling-2-mini", name: "Inkling 2 Mini" },
      ]),
      used_bytes: gb(15),
    };
    expect(poolOtherBytes(legacyPool)).toBe(gb(7.5));
    expect(poolUnaccountedBytes(legacyPool)).toBe(0);

    // If external_holders report more bytes than the residual, cap to residual
    const cappedPool = {
      ...gpuPool(0, 16, [
        { gb: 7.5, id: "inkling-2-mini", name: "Inkling 2 Mini" },
      ]),
      external_holders: [{ bytes: gb(10), name: "game" }],
      used_bytes: gb(15),
    };
    expect(poolOtherBytes(cappedPool)).toBe(gb(7.5));
    expect(poolUnaccountedBytes(cappedPool)).toBe(0);
  });

  it("does not trigger close-apps memory guidance when residual is system/engine overhead", () => {
    // 16 GB card with 7.5 GB loaded model, 15 GB used (only 1 GB free).
    // external_holders is empty. A 4 GB model cannot fit, but closing apps won't help.
    const poolNoOtherApps = {
      ...gpuPool(0, 16, [
        { gb: 7.5, id: "inkling-2-mini", name: "Inkling 2 Mini" },
      ]),
      external_holders: [],
      used_bytes: gb(15),
    };
    const view = labView({
      models: [
        modelView(
          localModel({
            id: "medium:Q4",
            memory_bytes: gb(4),
            name: "Medium",
            pool: "gpu:0",
          }),
        ),
      ],
      pools: [poolNoOtherApps],
    });
    // memoryGuidance should be null because otherBytes is 0.
    expect(memoryGuidance(view)).toBeNull();
  });

  it("detects external app memory and surfaces cleanup guidance when it blocks models", () => {
    expect(memoryGuidance(labView())).toBeNull();
    expect(memoryGuidance(macView())).toBeNull();

    const busyGpu = {
      ...gpuPool(0, 24, [{ gb: 4, id: "small", name: "Small" }]),
      used_bytes: gb(18),
    };
    expect(poolOtherBytes(busyGpu)).toBe(gb(14));
    const eightGbAvailableView = labView({
      models: [
        modelView(
          localModel({
            id: "small:Q4",
            memory_bytes: gb(5),
            name: "Small",
            pool: "gpu:0",
          }),
        ),
      ],
      pools: [busyGpu],
    });
    expect(memoryGuidance(eightGbAvailableView)).toBeNull();

    const constrainedGpuView = labView({
      models: [
        modelView(
          localModel({
            id: "medium:Q4",
            memory_bytes: gb(12),
            name: "Medium",
            pool: "gpu:0",
          }),
        ),
      ],
      pools: [busyGpu],
    });
    expect(memoryGuidance(constrainedGpuView)).toMatchObject({
      gpu: true,
      kind: "constrained_pool",
      otherBytes: gb(14),
    });

    // A game holds 14 GB on a 24 GB card, so a 14 GB model is marked MEMORY_INSUFFICIENT.
    const blockedDownloadModel = localModel({
      availability: {
        downloadable: false,
        reason: {
          code: "MEMORY_INSUFFICIENT",
          have_bytes: gb(6),
          need_bytes: gb(14),
        },
      },
      fit: "none",
      id: "qwen3.8-27b:IQ3_S",
      name: "Qwen3.8 27B",
      pool: undefined,
    });
    const blockedDownload = labView({
      models: [modelView(blockedDownloadModel)],
      pools: [busyGpu],
    });
    expect(memoryReclaimable(blockedDownload, blockedDownloadModel)).toBe(true);
    expect(memoryGuidance(blockedDownload)).toMatchObject({
      gpu: true,
      kind: "blocked_download",
      otherBytes: gb(14),
    });

    // On an 8 GB GPU + 64 GB RAM host, a 40 GB GPU-pool miss cannot fit by closing browser GPU tabs.
    const smallGpuBusy = labView({
      computer: {
        ...labView().computer,
        host: {
          ...labView().computer.host!,
          gpus: [
            {
              free_bytes: gb(4),
              index: 0,
              name: "RTX 4060",
              total_bytes: gb(8),
            },
          ],
          ram_total_bytes: gb(64),
        },
      },
      pools: [{ ...gpuPool(0, 8), used_bytes: gb(4) }],
    });
    const fortyGbModel = localModel({
      availability: {
        downloadable: false,
        reason: {
          code: "MEMORY_INSUFFICIENT",
          have_bytes: gb(4),
          need_bytes: gb(40),
        },
      },
      fit: "none",
      id: "huge:Q4",
      name: "Huge 40B",
      pool: undefined,
    });
    expect(memoryReclaimable(smallGpuBusy, fortyGbModel)).toBe(false);

    const blockedLoadModel = localModel({
      id: "gemma3-12b:Q4_K_M",
      memory_bytes: gb(10),
      name: "Gemma 3 12B",
      note: { code: "NO_ROOM_TO_LOAD" },
      pool: "gpu:0",
      state: "idle",
    });
    const blockedLoad = labView({
      models: [modelView(blockedLoadModel)],
      pools: [busyGpu],
    });
    expect(loadCheck(blockedLoad, blockedLoadModel)?.freeBytes).toBe(gb(6));
    expect(memoryGuidance(blockedLoad)).toMatchObject({
      gpu: true,
      kind: "blocked_load",
      otherBytes: gb(14),
    });

    const multiSpaceGpu = {
      ...gpuPool(0, 96, [{ gb: 21, id: "loaded:Q4", name: "Loaded" }]),
      used_bytes: gb(83),
    };
    const multiSpaceSystem = {
      ...memoryPool("system", 400),
      used_bytes: gb(340),
    };
    const gpuConstrainedWithBusyRam = labView({
      models: [
        modelView(
          localModel({
            id: "big-gpu:Q4",
            memory_bytes: gb(40),
            name: "Big GPU Model",
            pool: "gpu:0",
          }),
        ),
      ],
      pools: [multiSpaceGpu, multiSpaceSystem],
    });
    expect(memoryGuidance(gpuConstrainedWithBusyRam)).toEqual({
      freeBytes: gb(13),
      gpu: true,
      kind: "constrained_pool",
      otherBytes: gb(62),
      totalBytes: gb(96),
    });

    const cleanGpuBusyRam = labView({
      models: [
        modelView(
          localModel({
            fit: "system",
            id: "ram-only:Q4",
            memory_bytes: gb(80),
            name: "System RAM Model",
            pool: "system",
          }),
        ),
      ],
      pools: [
        gpuPool(0, 96, [{ gb: 21, id: "loaded:Q4", name: "Loaded" }]),
        multiSpaceSystem,
      ],
    });
    expect(memoryGuidance(cleanGpuBusyRam)).toEqual({
      freeBytes: gb(60),
      gpu: false,
      kind: "constrained_pool",
      otherBytes: gb(340),
      totalBytes: gb(400),
    });
  });

  it("orders local switch targets with loaded models first, then recommended, then largest", () => {
    const idleLarge = localModel({
      id: "large:Q4",
      memory_bytes: gb(20),
      name: "Large",
      state: "idle",
    });
    const idleSmallRec = localModel({
      id: "small:Q4",
      memory_bytes: gb(4),
      name: "Small",
      recommended: true,
      state: "idle",
    });
    const loadedOther = localModel({
      id: "loaded:Q4",
      memory_bytes: gb(8),
      name: "Loaded",
      state: "loaded",
    });
    const view = macView({
      models: [
        modelView(idleLarge),
        modelView(idleSmallRec),
        modelView(loadedOther),
      ],
    });
    expect(localSwitchTargets(view).map((model) => model.id)).toEqual([
      "loaded:Q4",
      "small:Q4",
      "large:Q4",
    ]);
  });

  it("loads at once when the reported pool has room", () => {
    const view = labView();
    const gemma = view.models.find(
      (item) => item.model.name === "Gemma 3 27B",
    )!;
    expect(loadCheck(view, gemma.model)).toBeNull();
  });

  it("lists the other loaded models of a full pool", () => {
    const view = macView();
    const llama = view.models.find(
      (item) => item.model.name === "Llama 3.3 70B",
    )!;
    const check = loadCheck(view, llama.model)!;
    expect(check.needBytes).toBe(gb(46));
    expect(check.freeBytes).toBe(gb(51.2) - gb(14.3));
    expect(check.loaded.map((entry) => entry.model.name)).toEqual([
      "GPT-OSS 20B",
    ]);
    // The loaded model is offered, so nothing else holds the pool.
    expect(check.kept).toEqual([]);
    expect(poolOtherBytes(check.pool)).toBe(0);
  });

  it("preselects the fewest models, preferring ones no Agent uses", () => {
    const pool = gpuPool(0, 24, [{ gb: 22, id: "taken", name: "taken" }]);
    const big = loaded("big-used", 12, ["Research agent"]);
    const small = loaded("small-unused", 6);
    const medium = loaded("medium-unused", 9);
    const check = {
      freeBytes: gb(2),
      loaded: [big, small, medium].map((item) => ({
        ...item,
        status: "loaded" as const,
      })),
      kept: [],
      needBytes: gb(12),
      pool,
    };

    // Fewest first: the one used model frees enough where no single unused
    // one does; with a larger need, two unused models beat a used one.
    expect(makeRoomSelection(check)).toEqual(["big-used"]);
    expect(makeRoomSelection({ ...check, needBytes: gb(17) })).toEqual([
      "medium-unused",
      "small-unused",
    ]);
    expect(makeRoomSelection({ ...check, needBytes: gb(40) })).toEqual([]);
    expect(makesRoom(check, new Set(["small-unused"]))).toBe(false);
    expect(makesRoom(check, new Set(["small-unused", "medium-unused"]))).toBe(
      true,
    );
  });

  it("reports download progress in whole percent", () => {
    expect(
      downloadPercent(
        localModel({
          download: { done_bytes: 333, step: "download", total_bytes: 1000 },
          id: "m",
          name: "m",
          state: "downloading",
        }),
      ),
    ).toBe(33);
    expect(downloadPercent(localModel({ id: "m", name: "m" }))).toBe(0);
  });

  it("unites legacy vision with structured capabilities in display order", () => {
    expect(
      modelCapabilities(
        localModel({
          capabilities: ["coding", "vision", "tool_use"],
          id: "m",
          name: "m",
          vision: true,
        }),
      ),
    ).toEqual(["vision", "tool_use", "coding"]);
    expect(
      modelCapabilities(localModel({ id: "m", name: "m", vision: true })),
    ).toEqual(["vision"]);
  });

  it("formats parameter scale, architecture, and collapsed row badges", () => {
    const moe = localModel({
      active_parameters: "3B",
      architecture: "moe",
      capabilities: ["coding", "reasoning", "tool_use", "vision"],
      id: "qwen3-coder-30b:Q4_K_M",
      name: "Qwen3 Coder 30B",
      parameters: "30B",
      vision: true,
    });
    expect(parametersLabel(moe, translate)).toBe("30B · 3B active (MoE)");
    expect(collapsedRowBadges(moe, translate)).toEqual({
      badges: ["3B active", "Vision", "Tool use", "+3"],
      overflowTitle: "Reasoning, Coding, 128K",
    });

    const dense = localModel({
      architecture: "dense",
      capabilities: ["tool_use"],
      id: "qwen3-4b:Q4_K_M",
      name: "Qwen3 4B",
      parameters: "4B",
    });
    expect(parametersLabel(dense, translate)).toBe("4B (Dense)");
    expect(collapsedRowBadges(dense, translate)).toEqual({
      badges: ["4B", "Tool use", "128K"],
    });

    // Collapsed badges depend strictly on structured fields, never name or description.
    expect(
      collapsedRowBadges(
        {
          ...dense,
          description: "Vision reasoning model with 70B scale.",
          name: "Renamed Without Size",
        },
        translate,
      ),
    ).toEqual(collapsedRowBadges(dense, translate));

    expect(
      collapsedRowBadges(
        localModel({
          context_tokens: 0,
          id: "llama3.3:Q4_K_M",
          name: "Llama 3.3",
          parameters: "70B",
        }),
        translate,
      ),
    ).toEqual({ badges: ["70B"] });
    expect(compactContextLabel(512, translate)).toBeUndefined();
    expect(compactContextLabel(204_800, translate)).toBe("200K");
  });

  it("identifies models on the computer and formats Agent usage chips", () => {
    expect(
      isModelOnComputer(localModel({ id: "m", name: "M" }), "available"),
    ).toBe(false);
    expect(
      isModelOnComputer(localModel({ id: "m", name: "M" }), "unavailable"),
    ).toBe(false);
    expect(
      isModelOnComputer(
        localModel({
          error: { code: "DOWNLOAD_FAILED" },
          id: "m",
          name: "M",
          state: "failed",
        }),
        "failed",
      ),
    ).toBe(false);
    expect(
      isModelOnComputer(
        localModel({ id: "m", name: "M", state: "loaded" }),
        "loaded",
      ),
    ).toBe(true);

    expect(
      usedByBadge(
        {
          model: localModel({ id: "m", name: "M", state: "loaded" }),
          status: "loaded",
          used_by: [{ agent_id: "a1", name: "Research" }],
        },
        translate,
      ),
    ).toBe("1 Agent");
    expect(
      usedByBadge(
        {
          model: localModel({ id: "m", name: "M", state: "idle" }),
          status: "idle",
          used_by: [
            { agent_id: "a1", name: "Research" },
            { agent_id: "a2", name: "Writer" },
          ],
        },
        translate,
      ),
    ).toBe("2 Agents");
    expect(
      usedByBadge(
        {
          model: localModel({ id: "m", name: "M", state: "loaded" }),
          status: "loaded",
          used_by: [],
        },
        translate,
      ),
    ).toBeUndefined();
    expect(
      usedByBadge(
        {
          model: localModel({ id: "m", name: "M", state: "loaded" }),
          status: "loaded",
          used_by: [],
        },
        translate,
        ["Research", "Delegate"],
      ),
    ).toBe("2 Agents");
    expect(
      usedByBadge(
        {
          model: localModel({ id: "m", name: "M", state: "absent" }),
          status: "available",
          used_by: [{ agent_id: "a1", name: "Research" }],
        },
        translate,
      ),
    ).toBeUndefined();
    expect(
      usedByBadge(
        {
          model: localModel({
            error: { code: "NETWORK_UNAVAILABLE" },
            id: "m",
            name: "M",
            state: "failed",
          }),
          status: "failed",
          used_by: [{ agent_id: "a1", name: "Research" }],
        },
        translate,
      ),
    ).toBeUndefined();
  });

  it("formats live download speed, ETA, prompt speed, and safe source URLs", () => {
    const mb = 1024 * 1024;
    expect(
      downloadStatusDetail(
        localModel({
          download: {
            bytes_per_second: 50 * mb,
            done_bytes: 5_000 * mb,
            step: "download",
            total_bytes: 20_000 * mb,
          },
          id: "m",
          name: "m",
          state: "downloading",
        }),
        translate,
      ),
    ).toBe("25% · 50 MB/s · 5m left");
    expect(
      downloadStatusDetail(
        localModel({
          download: { done_bytes: 100, step: "verify", total_bytes: 100 },
          id: "m",
          name: "m",
          state: "downloading",
        }),
        translate,
      ),
    ).toBe("checking file");
    expect(
      speedLabel(
        localModel({
          id: "m",
          name: "m",
          prompt_tokens_per_second: 612.4,
          tokens_per_second: 46.2,
        }),
        translate,
      ),
    ).toBe("46 tokens/s · 612 prompt tokens/s");
    expect(safeModelSourceUrl("http://example.com/model")).toBeUndefined();
    const safe = safeModelSourceUrl("https://huggingface.co/Qwen/Qwen3-4B/");
    expect(safe).toBe("https://huggingface.co/Qwen/Qwen3-4B/");
    expect(
      downloadStatusDetail(
        localModel({
          download: {
            bytes_per_second: mb,
            done_bytes: 0,
            step: "download",
            total_bytes: 3590 * mb,
          },
          id: "m",
          name: "m",
          state: "downloading",
        }),
        translate,
      ),
    ).toBe("0% · 1 MB/s · 1h left");
    expect(contextLabel(512, translate)).toBe("512 tokens");
    expect(contextLabel(131_072, translate)).toBe("128K tokens");

    // A stopped download does not trigger blocked_load memory guidance.
    const stoppedDownloadView = labView({
      models: [
        modelView(
          localModel({
            error: { code: "NETWORK_UNAVAILABLE" },
            id: "stopped:Q4",
            memory_bytes: gb(20),
            name: "Stopped",
            pool: "gpu:0",
            state: "failed",
          }),
        ),
      ],
      pools: [{ ...gpuPool(0, 24), used_bytes: gb(12) }],
    });
    expect(memoryGuidance(stoppedDownloadView)).toBeNull();
  });
});

describe("downloadStopped", () => {
  const model = (fields: Parameters<typeof localModel>[0]) =>
    localModel(fields);

  it("is true only for a failed model with a download error code", () => {
    const base = { id: "m", name: "M", state: "failed" as const };
    expect(
      downloadStopped(model({ ...base, error: { code: "DOWNLOAD_FAILED" } })),
    ).toBe(true);
    expect(
      downloadStopped(
        model({ ...base, error: { code: "NETWORK_UNAVAILABLE" } }),
      ),
    ).toBe(true);
    expect(
      downloadStopped(model({ ...base, error: { code: "DISK_INSUFFICIENT" } })),
    ).toBe(true);
    expect(
      downloadStopped(
        model({ ...base, error: { code: "ENGINE_START_FAILED" } }),
      ),
    ).toBe(false);
    expect(downloadStopped(model(base))).toBe(false);
    expect(
      downloadStopped(
        model({
          ...base,
          error: { code: "DOWNLOAD_FAILED" },
          state: "downloading",
        }),
      ),
    ).toBe(false);
  });
});

describe("featured Inkling 2 Mini rules", () => {
  it("matches case-insensitive and org-prefixed Inkling 2 Mini IDs via the shared helper", () => {
    const view = labView({
      models: [
        modelView(
          localModel({
            fit: "gpu",
            id: "gemma3-4b:Q4_K_M",
            name: "Gemma 3 4B",
          }),
        ),
        modelView(
          localModel({
            fit: "system",
            id: "thinkingmachines/Inkling-2-Mini",
            name: "Inkling 2 Mini",
            pool: "system",
          }),
        ),
      ],
    });
    const ordered = modelEntries(view);
    expect(ordered.map((entry) => entry.model.id)).toEqual([
      "thinkingmachines/Inkling-2-Mini",
      "gemma3-4b:Q4_K_M",
    ]);
    expect(featuredInklingEntry(ordered)?.model.id).toBe(
      "thinkingmachines/Inkling-2-Mini",
    );
  });

  it("orders featured models after recommended within each status and before fit order", () => {
    const view = labView({
      models: [
        modelView(
          localModel({
            fit: "gpu",
            id: "gemma3-4b:Q4_K_M",
            name: "Gemma 3 4B",
          }),
        ),
        modelView(
          localModel({
            fit: "system",
            id: "inkling-2-mini:UD-Q4_K_M",
            name: "Inkling 2 Mini",
            pool: "system",
          }),
        ),
        modelView(
          localModel({
            fit: "gpu",
            id: "gpt-oss-20b:Q4_K_M",
            name: "GPT-OSS 20B",
            recommended: true,
          }),
        ),
        // Display name alone never promotes a non-matching ID.
        modelView(
          localModel({
            fit: "system",
            id: "custom-model:Q4_K_M",
            name: "Inkling 2 Mini Clone",
            pool: "system",
          }),
        ),
        modelView(
          localModel({
            id: "qwen3-coder-30b:Q4_K_M",
            name: "Qwen3 Coder 30B",
            state: "loaded",
          }),
        ),
      ],
    });
    expect(modelEntries(view).map((entry) => entry.model.id)).toEqual([
      "qwen3-coder-30b:Q4_K_M",
      "gpt-oss-20b:Q4_K_M",
      "inkling-2-mini:UD-Q4_K_M",
      "gemma3-4b:Q4_K_M",
      "custom-model:Q4_K_M",
    ]);

    // When nothing else is recommended, featured rises to the top of available.
    const noRecommended = labView({
      models: [
        modelView(localModel({ id: "gemma3-4b:Q4_K_M", name: "Gemma 3 4B" })),
        modelView(
          localModel({
            id: "inkling-2-mini:UD-Q4_K_M",
            name: "Inkling 2 Mini",
          }),
        ),
      ],
    });
    expect(modelEntries(noRecommended).map((entry) => entry.model.id)).toEqual([
      "inkling-2-mini:UD-Q4_K_M",
      "gemma3-4b:Q4_K_M",
    ]);
  });

  it("selects the best Inkling 2 Mini entry, preferring UD-Q4_K_M when variants tie", () => {
    expect(featuredInklingEntry(modelEntries(labView()))).toBeUndefined();

    const multiAvailable = labView({
      models: [
        modelView(
          localModel({
            id: "inkling-2-mini-iq3xxs:UD-IQ3_XXS",
            name: "Inkling 2 Mini (IQ3_XXS)",
            quant: "UD-IQ3_XXS",
          }),
        ),
        modelView(
          localModel({
            id: "inkling-2-mini:UD-Q4_K_M",
            name: "Inkling 2 Mini",
            quant: "UD-Q4_K_M",
          }),
        ),
      ],
    });
    expect(featuredInklingEntry(modelEntries(multiAvailable))?.model.id).toBe(
      "inkling-2-mini:UD-Q4_K_M",
    );

    // On a 16 GB host where Q4 is unavailable, sibling IQ3_XXS wins.
    const q4Unavailable = labView({
      models: [
        modelView(
          localModel({
            availability: {
              downloadable: false,
              reason: {
                code: "MEMORY_INSUFFICIENT",
                have_bytes: gb(16),
                need_bytes: gb(19.2),
              },
            },
            fit: "none",
            id: "inkling-2-mini:UD-Q4_K_M",
            name: "Inkling 2 Mini",
            pool: undefined,
            quant: "UD-Q4_K_M",
          }),
        ),
        modelView(
          localModel({
            fit: "gpu",
            id: "inkling-2-mini-iq3xxs:UD-IQ3_XXS",
            memory_bytes: gb(13.5),
            name: "Inkling 2 Mini (IQ3_XXS)",
            quant: "UD-IQ3_XXS",
          }),
        ),
      ],
    });
    expect(featuredInklingEntry(modelEntries(q4Unavailable))?.model.id).toBe(
      "inkling-2-mini-iq3xxs:UD-IQ3_XXS",
    );

    // A loaded variant beats an available UD-Q4_K_M.
    const iq3Loaded = labView({
      models: [
        modelView(
          localModel({
            id: "inkling-2-mini:UD-Q4_K_M",
            name: "Inkling 2 Mini",
            quant: "UD-Q4_K_M",
          }),
        ),
        modelView(
          localModel({
            id: "inkling-2-mini:UD-IQ3_S",
            name: "Inkling 2 Mini (IQ3)",
            quant: "UD-IQ3_S",
            state: "loaded",
          }),
        ),
      ],
    });
    expect(featuredInklingEntry(modelEntries(iq3Loaded))?.model.id).toBe(
      "inkling-2-mini:UD-IQ3_S",
    );

    // When all Inkling variants are unavailable (e.g. 16 GB Mac), prefer the smallest memory build.
    const bothUnavailable = labView({
      models: [
        modelView(
          localModel({
            availability: {
              downloadable: false,
              reason: {
                code: "MEMORY_INSUFFICIENT",
                have_bytes: gb(10.5),
                need_bytes: gb(17.9),
              },
            },
            fit: "none",
            id: "inkling-2-mini:UD-Q4_K_M",
            memory_bytes: gb(21.4),
            name: "Inkling 2 Mini (UD-Q4_K_M)",
            pool: undefined,
            quant: "UD-Q4_K_M",
          }),
        ),
        modelView(
          localModel({
            availability: {
              downloadable: false,
              reason: {
                code: "MEMORY_INSUFFICIENT",
                have_bytes: gb(10.5),
                need_bytes: gb(13.5),
              },
            },
            fit: "none",
            id: "inkling-2-mini-iq3xxs:UD-IQ3_XXS",
            memory_bytes: gb(16.8),
            name: "Inkling 2 Mini (UD-IQ3_XXS)",
            pool: undefined,
            quant: "UD-IQ3_XXS",
          }),
        ),
      ],
    });
    expect(featuredInklingEntry(modelEntries(bothUnavailable))?.model.id).toBe(
      "inkling-2-mini-iq3xxs:UD-IQ3_XXS",
    );
  });
});

describe("hostBlocker, RAM reclaimability, and diagnostics copy", () => {
  it("picks the highest-priority host blocker only when no model is downloadable or active", () => {
    const blocked = (
      id: string,
      reason: NonNullable<
        ReturnType<typeof localModel>["availability"]["reason"]
      >,
    ) =>
      modelView(
        localModel({
          availability: { downloadable: false, reason },
          fit: "none",
          id,
          name: id,
          pool: undefined,
        }),
      );

    const mixedView = labView({
      models: [
        blocked("m1", { code: "GPU_UNSUPPORTED", gpu_vendor: "amd" }),
        blocked("m2", {
          code: "DRIVER_UPDATE_REQUIRED",
          detected_cuda: "11.8",
          required_cuda: "12.4",
        }),
      ],
    });
    expect(hostBlocker(mixedView)).toEqual({
      code: "DRIVER_UPDATE_REQUIRED",
      detected_cuda: "11.8",
      required_cuda: "12.4",
    });

    // Once any model can be downloaded, no global host blocker banner is shown.
    const partialView = labView({
      models: [
        modelView(localModel({ id: "ok", name: "OK" })),
        blocked("m1", { code: "GPU_UNSUPPORTED", gpu_vendor: "amd" }),
      ],
    });
    expect(hostBlocker(partialView)).toBeNull();

    // Pure MEMORY_INSUFFICIENT does not trigger a host blocker.
    const memoryOnlyView = labView({
      models: [
        blocked("huge", {
          code: "MEMORY_INSUFFICIENT",
          have_bytes: gb(8),
          need_bytes: gb(40),
        }),
      ],
    });
    expect(hostBlocker(memoryOnlyView)).toBeNull();
  });

  it("evaluates memory_kind=ram against system pools instead of GPU pools", () => {
    const busyRamModel = localModel({
      availability: {
        downloadable: false,
        reason: {
          code: "MEMORY_INSUFFICIENT",
          have_bytes: gb(4),
          memory_kind: "ram",
          need_bytes: gb(20),
        },
      },
      fit: "none",
      id: "ram-tight:Q4",
      name: "RAM Tight",
      pool: undefined,
    });
    const busySystemPool = {
      ...memoryPool("system", 32),
      used_bytes: gb(28),
    };
    const view = labView({
      models: [modelView(busyRamModel)],
      pools: [gpuPool(0, 24), busySystemPool],
    });
    expect(memoryReclaimable(view, busyRamModel)).toBe(true);
    expect(memoryGuidance(view)).toMatchObject({
      gpu: false,
      kind: "blocked_download",
      otherBytes: gb(28),
    });

    // Clean system pool with busy GPU does not mark a RAM shortfall reclaimable.
    const cleanRamBusyGpu = labView({
      models: [modelView(busyRamModel)],
      pools: [
        { ...gpuPool(0, 24), used_bytes: gb(20) },
        memoryPool("system", 32),
      ],
    });
    expect(memoryReclaimable(cleanRamBusyGpu, busyRamModel)).toBe(false);
  });

  it("formats actionable copy for GPU, driver, runtime, RAM, debug, and unknown fallback codes", () => {
    expect(
      unavailableShortCopy(
        { code: "GPU_UNSUPPORTED", gpu_vendor: "amd" },
        translate,
      ),
    ).toBe("GPU not supported");
    expect(
      unavailableCopy(
        { code: "GPU_UNSUPPORTED", gpu_vendor: "amd" },
        false,
        translate,
      ),
    ).toContain("AMD GPUs");
    expect(
      unavailableCopy(
        {
          code: "DRIVER_UPDATE_REQUIRED",
          detected_cuda: "11.8",
          required_cuda: "12.4",
        },
        false,
        translate,
      ),
    ).toContain("CUDA 11.8");
    expect(
      unavailableCopy(
        {
          code: "RUNTIME_DEPENDENCY_MISSING",
          missing_libraries: ["libgomp.so.1"],
        },
        false,
        translate,
      ),
    ).toContain("libgomp.so.1");
    expect(
      unavailableCopy(
        {
          code: "RUNTIME_DEPENDENCY_MISSING",
          detected_glibc: "2.28",
          required_glibc: "2.35",
        },
        false,
        translate,
      ),
    ).toContain("2.28");
    expect(
      unavailableShortCopy(
        {
          code: "MEMORY_INSUFFICIENT",
          memory_kind: "ram",
          need_bytes: gb(16),
        },
        translate,
      ),
    ).toBe("needs 16 GB RAM");
    expect(
      unavailableShortCopy(
        {
          code: "MEMORY_INSUFFICIENT",
          memory_kind: "vram",
          need_bytes: gb(13.7),
        },
        translate,
      ),
    ).toBe("needs 13.7 GB VRAM");
    expect(
      unavailableCopy(
        {
          code: "MEMORY_INSUFFICIENT",
          have_bytes: gb(8),
          memory_kind: "vram",
          need_bytes: gb(13.7),
        },
        false,
        translate,
      ),
    ).toContain("GPU memory (VRAM)");
    expect(
      unavailableCopy(
        {
          code: "MEMORY_INSUFFICIENT",
          have_bytes: gb(8),
          memory_kind: "ram",
          need_bytes: gb(16),
        },
        false,
        translate,
      ),
    ).toContain("system memory (RAM)");
    expect(unavailableShortCopy({ code: "UNAVAILABLE" }, translate)).toBe(
      "unavailable",
    );
    expect(
      hostBlockerCopy(
        {
          code: "DRIVER_UPDATE_REQUIRED",
          detected_cuda: "11.8",
          required_cuda: "12.4",
        },
        translate,
      ).body,
    ).toContain("CUDA 12.4");
    expect(
      debugBannerCopy({ mode: "tiny", source: "env" }, translate),
    ).toMatchObject({
      title: "Debug mode active (tiny)",
    });
    expect(
      debugBannerCopy(
        {
          config_path: "/home/u/.config/localmodels/debug.json",
          mode: "simulate",
          source: "user_config",
        },
        translate,
      ).body,
    ).toContain("/home/u/.config/localmodels/debug.json");
    expect(
      debugBannerCopy({ mode: "simulate", source: "user_config" }, translate)
        .body,
    ).not.toContain("debug.json");
    expect(actionErrorCopy("LOCAL_MODEL_GPU_UNSUPPORTED", translate)).toContain(
      "supported GPU",
    );
    expect(modelErrorShortCopy({ code: "UNKNOWN_ERROR" }, translate)).toBe(
      "unexpected error",
    );
    expect(modelErrorCopy({ code: "UNKNOWN_ERROR" }, translate)).toContain(
      "Something went wrong",
    );
  });

  it("formats structured engine badges, hints, concurrency, and PolyStrata spotlight preference", () => {
    expect(engineBadgeCopy("polystrata")).toBe("PolyStrata");
    expect(engineBadgeCopy("llama.cpp")).toBe("llama.cpp");
    expect(engineBadgeCopy("strata")).toBe("Strata");
    expect(engineBadgeCopy(undefined)).toBeUndefined();

    expect(engineHintCopy("polystrata", "gpu", translate)).toBe(
      "Hybrid GPU + RAM expert offload",
    );
    expect(engineHintCopy("strata", "gpu", translate)).toBe(
      "Hybrid GPU + RAM expert scheduling",
    );
    expect(engineHintCopy("llama.cpp", "gpu", translate)).toBe(
      "All-in-VRAM native engine",
    );
    expect(engineHintCopy("llama.cpp", "unified", translate)).toBe(
      "Unified memory native engine",
    );
    expect(engineHintCopy("llama.cpp", "system", translate)).toBe(
      "System memory native engine",
    );
    expect(engineHintCopy("llama.cpp", "none", translate)).toBeUndefined();
    expect(engineHintCopy(undefined, "gpu", translate)).toBeUndefined();

    expect(concurrencyCopy(1, translate)).toBe("1 request at a time");
    expect(concurrencyCopy(2, translate)).toBe("2 concurrent requests");
    expect(concurrencyCopy(0, translate)).toBeUndefined();
    expect(concurrencyCopy(undefined, translate)).toBeUndefined();

    const polyEntry = {
      ...modelView(
        localModel({
          engine: "polystrata",
          id: "inkling-2-mini-q4-poly:UD-Q4_K_XL",
          name: "Inkling 2 Mini (UD-Q4_K_XL)",
          quant: "UD-Q4_K_XL",
        }),
      ),
      status: "available" as const,
    };
    const llamaEntry = {
      ...modelView(
        localModel({
          engine: "llama.cpp",
          id: "inkling-2-mini:UD-Q4_K_M",
          name: "Inkling 2 Mini (UD-Q4_K_M)",
          quant: "UD-Q4_K_M",
        }),
      ),
      status: "available" as const,
    };
    expect(featuredInklingEntry([llamaEntry, polyEntry])?.model.id).toBe(
      "inkling-2-mini-q4-poly:UD-Q4_K_XL",
    );

    // Among unavailable Inkling variants on a 12 GB CUDA 12.8 card, actionable
    // driver upgrades beat hard memory misses and keep backend order (q3 before q4).
    const driverQ3 = {
      ...modelView(
        localModel({
          availability: {
            downloadable: false,
            reason: {
              code: "DRIVER_UPDATE_REQUIRED",
              detected_cuda: "12.8",
              required_cuda: "13.0",
            },
          },
          engine: "polystrata",
          fit: "none",
          id: "inkling-2-mini-q3-poly:UD-Q3_K_XL",
          memory_bytes: gb(5),
          name: "Inkling 2 Mini (UD-Q3_K_XL)",
          pool: undefined,
          quant: "UD-Q3_K_XL",
        }),
      ),
      status: "unavailable" as const,
    };
    const driverQ4 = {
      ...modelView(
        localModel({
          availability: {
            downloadable: false,
            reason: {
              code: "DRIVER_UPDATE_REQUIRED",
              detected_cuda: "12.8",
              required_cuda: "13.0",
            },
          },
          engine: "polystrata",
          fit: "none",
          id: "inkling-2-mini-q4-poly:UD-Q4_K_XL",
          memory_bytes: gb(19),
          name: "Inkling 2 Mini (UD-Q4_K_XL)",
          pool: undefined,
          quant: "UD-Q4_K_XL",
        }),
      ),
      status: "unavailable" as const,
    };
    const memMissIq3 = {
      ...modelView(
        localModel({
          availability: {
            downloadable: false,
            reason: {
              code: "MEMORY_INSUFFICIENT",
              have_bytes: gb(11),
              memory_kind: "vram",
              need_bytes: gb(13.7),
            },
          },
          engine: "llama.cpp",
          fit: "none",
          id: "inkling-2-mini-iq3xxs:UD-IQ3_XXS",
          memory_bytes: gb(13.7),
          name: "Inkling 2 Mini (UD-IQ3_XXS)",
          pool: undefined,
          quant: "UD-IQ3_XXS",
        }),
      ),
      status: "unavailable" as const,
    };
    expect(
      featuredInklingEntry([memMissIq3, driverQ3, driverQ4])?.model.id,
    ).toBe("inkling-2-mini-q3-poly:UD-Q3_K_XL");

    // On an 8 GB VRAM / 16 GB RAM host, compare actual shortfall (4 GB RAM < 6.7 GB VRAM).
    const ramShortQ2 = {
      ...modelView(
        localModel({
          availability: {
            downloadable: false,
            reason: {
              code: "MEMORY_INSUFFICIENT",
              have_bytes: gb(16),
              memory_kind: "ram",
              need_bytes: gb(20),
            },
          },
          engine: "polystrata",
          fit: "none",
          id: "inkling-2-mini-q2-poly:UD-Q2_K_XL",
          memory_bytes: gb(5),
          name: "Inkling 2 Mini (UD-Q2_K_XL)",
          pool: undefined,
          quant: "UD-Q2_K_XL",
        }),
      ),
      status: "unavailable" as const,
    };
    const vramShortIq3 = {
      ...memMissIq3,
      model: {
        ...memMissIq3.model,
        availability: {
          downloadable: false,
          reason: {
            code: "MEMORY_INSUFFICIENT" as const,
            have_bytes: gb(7),
            memory_kind: "vram" as const,
            need_bytes: gb(13.7),
          },
        },
      },
    };
    expect(featuredInklingEntry([vramShortIq3, ramShortQ2])?.model.id).toBe(
      "inkling-2-mini-q2-poly:UD-Q2_K_XL",
    );
  });

  it("prefers a hardware-fitting driver-update Inkling variant over a VRAM-insufficient Q4 variant", () => {
    const q4TooBig = {
      ...modelView(
        localModel({
          availability: {
            downloadable: false,
            reason: {
              code: "MEMORY_INSUFFICIENT",
              have_bytes: gb(8),
              memory_kind: "vram",
              need_bytes: gb(20),
            },
          },
          engine: "polystrata",
          fit: "none",
          id: "inkling-2-mini-q4-poly:UD-Q4_K_XL",
          name: "Inkling 2 Mini (UD-Q4_K_XL)",
          pool: undefined,
          quant: "UD-Q4_K_XL",
          recommended: false,
        }),
      ),
      status: "unavailable" as const,
    };
    const q3DriverBlocked = {
      ...modelView(
        localModel({
          availability: {
            downloadable: false,
            reason: {
              code: "DRIVER_UPDATE_REQUIRED",
              detected_cuda: "12.8",
              driver_version: "572.83",
              required_cuda: "13.0",
            },
          },
          engine: "polystrata",
          fit: "none",
          id: "inkling-2-mini-q3-poly:UD-Q3_K_XL",
          name: "Inkling 2 Mini (UD-Q3_K_XL)",
          pool: undefined,
          quant: "UD-Q3_K_XL",
          recommended: false,
        }),
      ),
      status: "unavailable" as const,
    };
    expect(featuredInklingEntry([q4TooBig, q3DriverBlocked])?.model.id).toBe(
      "inkling-2-mini-q3-poly:UD-Q3_K_XL",
    );
    expect(
      unavailableCopy(
        q3DriverBlocked.model.availability.reason,
        false,
        translate,
        "PolyStrata",
      ),
    ).toContain("PolyStrata requires NVIDIA driver 580+");
  });

  it("groups sibling quantizations by structured source_url, moves unavailable spotlight below available, and keeps extra active variants visible", () => {
    const qwenRepo = "https://huggingface.co/unsloth/Qwen3.8-27B-GGUF";
    const flashRepo = "https://huggingface.co/unsloth/Qwen3.8-Flash-Next-GGUF";
    const inklingRepo = "https://huggingface.co/unsloth/Inkling-2-Mini-GGUF";

    expect(
      modelBaseName(
        localModel({
          id: "qwen3.8-27b:UD-Q4_K_M",
          name: "Qwen3.8 27B (UD-Q4_K_M)",
          quant: "UD-Q4_K_M",
        }),
      ),
    ).toBe("Qwen3.8 27B");
    expect(
      modelBaseName(
        localModel({
          id: "inkling-2-mini-iq3xxs:UD-IQ3_XXS",
          name: "Inkling 2 Mini (IQ3_XXS)",
          quant: "UD-IQ3_XXS",
        }),
      ),
    ).toBe("Inkling 2 Mini");
    expect(
      modelGroupKey(
        localModel({
          id: "qwen3.8-27b:UD-Q4_K_M",
          name: "Qwen3.8 27B (UD-Q4_K_M)",
          source_url: qwenRepo,
        }),
      ),
    ).toBe(`source:${qwenRepo.toLowerCase()}`);

    // 16 GB Mac: Ornith fits (recommended), Inkling & Flash Next are unavailable.
    const mac16Entries = modelEntries(
      macView({
        models: [
          modelView(
            localModel({
              engine: "llama.cpp",
              fit: "unified",
              id: "ornith-1.5-9b:Q4_K_M",
              memory_bytes: gb(10.4),
              name: "Ornith 1.5 9B (Q4_K_M)",
              pool: "unified",
              quant: "Q4_K_M",
              recommended: true,
              source_url: "https://huggingface.co/unsloth/Ornith-1.5-9B-GGUF",
            }),
          ),
          modelView(
            localModel({
              availability: {
                downloadable: false,
                reason: {
                  code: "MEMORY_INSUFFICIENT",
                  have_bytes: gb(13),
                  need_bytes: gb(16.2),
                },
              },
              engine: "llama.cpp",
              fit: "none",
              id: "inkling-2-mini-iq3xxs:UD-IQ3_XXS",
              memory_bytes: gb(16.2),
              name: "Inkling 2 Mini (UD-IQ3_XXS)",
              pool: undefined,
              quant: "UD-IQ3_XXS",
              source_url: inklingRepo,
            }),
          ),
          modelView(
            localModel({
              availability: {
                downloadable: false,
                reason: {
                  code: "MEMORY_INSUFFICIENT",
                  have_bytes: gb(13),
                  need_bytes: gb(72),
                },
              },
              engine: "llama.cpp",
              fit: "none",
              id: "qwen3.8-flash-next-iq2xs:GSQ-RCO-IQ2_XS",
              memory_bytes: gb(72),
              name: "Qwen3.8 Flash Next (GSQ-RCO-IQ2_XS)",
              pool: undefined,
              quant: "GSQ-RCO-IQ2_XS",
              source_url: flashRepo,
            }),
          ),
          modelView(
            localModel({
              availability: {
                downloadable: false,
                reason: {
                  code: "MEMORY_INSUFFICIENT",
                  have_bytes: gb(13),
                  need_bytes: gb(88),
                },
              },
              engine: "llama.cpp",
              fit: "none",
              id: "qwen3.8-flash-next-iq3s:GSQ-RCO-IQ3_S",
              memory_bytes: gb(88),
              name: "Qwen3.8 Flash Next (GSQ-RCO-IQ3_S)",
              pool: undefined,
              quant: "GSQ-RCO-IQ3_S",
              source_url: flashRepo,
            }),
          ),
        ],
      }),
    );
    const mac16Sections = buildModelGroups(mac16Entries);
    expect(mac16Sections.showEngineBadge).toBe(false);
    expect(mac16Sections.spotlightPosition).toBe("afterAvailable");
    expect(mac16Sections.available.map((g) => g.defaultEntry.model.id)).toEqual(
      ["ornith-1.5-9b:Q4_K_M"],
    );
    expect(mac16Sections.unavailable).toHaveLength(1);
    expect(
      mac16Sections.unavailable[0]!.variants.map((v) => v.model.id),
    ).toEqual([
      "qwen3.8-flash-next-iq2xs:GSQ-RCO-IQ2_XS",
      "qwen3.8-flash-next-iq3s:GSQ-RCO-IQ3_S",
    ]);
    expect(mac16Sections.unavailableAllMemory).toBe(true);

    // When two variants of the same model are both active on computer, both surface in onComputer.
    const dualActiveEntries = modelEntries(
      macView({
        models: [
          modelView(
            localModel({
              engine: "llama.cpp",
              fit: "unified",
              id: "qwen3.8-27b:UD-Q4_K_M",
              name: "Qwen3.8 27B (UD-Q4_K_M)",
              pool: "unified",
              quant: "UD-Q4_K_M",
              source_url: qwenRepo,
              state: "loaded",
            }),
          ),
          modelView(
            localModel({
              engine: "llama.cpp",
              fit: "unified",
              id: "qwen3.8-27b-iq3s:UD-IQ3_S",
              name: "Qwen3.8 27B (UD-IQ3_S)",
              pool: "unified",
              quant: "UD-IQ3_S",
              source_url: qwenRepo,
              state: "downloading",
            }),
          ),
        ],
      }),
    );
    const dualActiveSections = buildModelGroups(dualActiveEntries);
    expect(
      dualActiveSections.onComputer.map((g) => g.defaultEntry.model.id),
    ).toEqual(["qwen3.8-27b:UD-Q4_K_M", "qwen3.8-27b-iq3s:UD-IQ3_S"]);
  });
});
