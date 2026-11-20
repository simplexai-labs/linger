import { describe, expect, it } from "vitest";

import {
  collapsedRowBadges,
  contextLabel,
  downloadMemoryCheck,
  downloadPercent,
  downloadStatusDetail,
  downloadStopped,
  formatGigabytes,
  headerMemoryBreakdown,
  isModelOnComputer,
  loadCheck,
  localSwitchTargets,
  makeRoomSelection,
  makesRoom,
  memoryGuidance,
  memoryReclaimable,
  memorySummary,
  modelCapabilities,
  modelEntries,
  parametersLabel,
  placeName,
  poolLabel,
  poolMemoryBreakdown,
  poolOtherBytes,
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
    expect(formatGigabytes(gb(0.6))).toBe("0.6 GB");
    expect(formatGigabytes(0)).toBe("0 GB");
    expect(formatGigabytes(gb(46))).toBe("46 GB");
    expect(formatGigabytes(gb(21.44))).toBe("21.4 GB");
  });

  it("names pools from what the Computer reported", () => {
    const view = labView();
    expect(view.pools.map((pool) => poolLabel(view, pool))).toEqual([
      "GPU 0 · RTX 4090",
      "GPU 1 · RTX 4090",
      "System memory",
    ]);
    expect(placeName(view, "gpu:1")).toBe("GPU 1");
    expect(placeName(view, "system")).toBe("system memory");
    expect(placeName(macView(), "unified")).toBe("memory");
    // A model that fits nowhere has no placement to show.
    expect(placeName(view, undefined)).toBeUndefined();
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
    expect(parametersLabel(moe)).toBe("30B · 3B active (MoE)");
    expect(collapsedRowBadges(moe)).toEqual({
      badges: ["3B active", "Vision", "Tool use", "+2"],
      overflowTitle: "Reasoning, Coding",
    });

    const dense = localModel({
      architecture: "dense",
      capabilities: ["tool_use"],
      id: "qwen3-4b:Q4_K_M",
      name: "Qwen3 4B",
      parameters: "4B",
    });
    expect(parametersLabel(dense)).toBe("4B (Dense)");
    expect(collapsedRowBadges(dense)).toEqual({ badges: ["4B", "Tool use"] });

    // Collapsed badges depend strictly on structured fields, never name or description.
    expect(
      collapsedRowBadges({
        ...dense,
        description: "Vision reasoning model with 70B scale.",
        name: "Renamed Without Size",
      }),
    ).toEqual(collapsedRowBadges(dense));

    expect(
      collapsedRowBadges(
        localModel({
          id: "llama3.3:Q4_K_M",
          name: "Llama 3.3",
          parameters: "70B",
        }),
      ),
    ).toEqual({ badges: ["70B"] });
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
      usedByBadge({
        model: localModel({ id: "m", name: "M", state: "loaded" }),
        status: "loaded",
        used_by: [{ agent_id: "a1", name: "Research" }],
      }),
    ).toBe("1 Agent");
    expect(
      usedByBadge({
        model: localModel({ id: "m", name: "M", state: "idle" }),
        status: "idle",
        used_by: [
          { agent_id: "a1", name: "Research" },
          { agent_id: "a2", name: "Writer" },
        ],
      }),
    ).toBe("2 Agents");
    expect(
      usedByBadge({
        model: localModel({ id: "m", name: "M", state: "loaded" }),
        status: "loaded",
        used_by: [],
      }),
    ).toBeUndefined();
    expect(
      usedByBadge(
        {
          model: localModel({ id: "m", name: "M", state: "loaded" }),
          status: "loaded",
          used_by: [],
        },
        ["Research", "Delegate"],
      ),
    ).toBe("2 Agents");
    expect(
      usedByBadge({
        model: localModel({ id: "m", name: "M", state: "absent" }),
        status: "available",
        used_by: [{ agent_id: "a1", name: "Research" }],
      }),
    ).toBeUndefined();
    expect(
      usedByBadge({
        model: localModel({
          error: { code: "NETWORK_UNAVAILABLE" },
          id: "m",
          name: "M",
          state: "failed",
        }),
        status: "failed",
        used_by: [{ agent_id: "a1", name: "Research" }],
      }),
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
      ),
    ).toBe("0% · 1 MB/s · 1h left");
    expect(contextLabel(512)).toBe("512 tokens");
    expect(contextLabel(131_072)).toBe("128K tokens");

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

describe("live memory checks and memory breakdowns", () => {
  it("respects fits_now and pool-aligned load_need_bytes/load_free_bytes", () => {
    const view = macView();
    const scaledToFit = localModel({
      fit: "unified",
      fits_now: true,
      id: "qwen3.8-27b-iq3s:UD-IQ3_S",
      memory_bytes: gb(20.8),
      name: "Qwen3.8 27B",
      pool: "unified",
    });
    // fits_now: true trusts the planner even when full capacity exceeds live free.
    expect(downloadMemoryCheck(view, scaledToFit)).toBeNull();
    expect(loadCheck(view, scaledToFit)).toBeNull();

    const blocked = localModel({
      fit: "unified",
      fits_now: false,
      id: "qwen3.8-27b:UD-Q4_K_M",
      load_free_bytes: gb(6.6),
      load_need_bytes: gb(18.4),
      memory_bytes: gb(22.4),
      name: "Qwen3.8 27B (Q4_K_M)",
      pool: "unified",
    });
    expect(downloadMemoryCheck(view, blocked)).toMatchObject({
      freeBytes: gb(6.6),
      needBytes: gb(18.4),
    });
    expect(loadCheck(view, blocked)).toMatchObject({
      freeBytes: gb(6.6),
      needBytes: gb(18.4),
    });
  });

  it("builds unified, GPU, and multi-GPU header memory breakdowns", () => {
    const unified = {
      ...memoryPool("unified", 21.5),
      reserve_bytes: gb(2.5),
      used_bytes: gb(14.9),
    };
    const mac = macView({
      computer: {
        ...macView().computer,
        host: {
          ...macView().computer.host!,
          memory_pressure: "warn",
          metal_working_set_bytes: gb(17.8),
          ram_available_bytes: gb(9.1),
          ram_total_bytes: gb(24),
        },
      },
      pools: [unified],
    });

    const unifiedBreakdown = poolMemoryBreakdown(mac, unified);
    expect(unifiedBreakdown.title).toBe("Unified memory breakdown");
    expect(unifiedBreakdown.rows).toEqual([
      { label: "Physical memory", value: "24 GB" },
      { label: "Used by macOS & apps", value: "14.9 GB" },
      { label: "Reclaimable & free", value: "9.1 GB" },
      { label: "Reserved for macOS & Linger", value: "2.5 GB" },
      { label: "Available for models", value: "6.6 GB" },
      { label: "Per-model Metal GPU cap", value: "17.8 GB" },
      { label: "Memory pressure", tone: "warning", value: "Warning" },
    ]);
    expect(headerMemoryBreakdown(mac)).toEqual(unifiedBreakdown);

    const lab = labView();
    expect(headerMemoryBreakdown(lab)).toEqual({
      rows: [
        { label: "GPU 0 · RTX 4090", value: "2.6 GB free of 24 GB" },
        { label: "GPU 1 · RTX 4090", value: "22.9 GB free of 24 GB" },
      ],
      title: "GPU memory breakdown",
    });
  });
});
