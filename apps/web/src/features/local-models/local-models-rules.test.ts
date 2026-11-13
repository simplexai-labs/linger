import { describe, expect, it } from "vitest";

import {
  downloadPercent,
  loadCheck,
  makeRoomSelection,
  makesRoom,
  memorySummary,
  modelEntries,
  placeName,
  poolLabel,
} from "./local-models-rules";
import {
  gb,
  gpuPool,
  labView,
  localModel,
  macView,
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
      gpu: true,
      totalBytes: gb(24) * 2,
      usedBytes: gb(21.4) + gb(1.1),
    });
    expect(memorySummary(macView())).toEqual({
      gpu: false,
      totalBytes: gb(51.2),
      usedBytes: gb(14.3),
    });
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
});
