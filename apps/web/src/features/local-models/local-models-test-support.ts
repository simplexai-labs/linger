import type {
  LocalModel,
  LocalModelPool,
  LocalModelsView,
  LocalModelView,
} from "./local-models-queries";

/** Bytes of `value` gigabytes, as the page formats them back. */
export function gb(value: number) {
  return Math.round(value * 1024 ** 3);
}

export function localModel(
  fields: Partial<LocalModel> & Pick<LocalModel, "id" | "name">,
): LocalModel {
  return {
    availability: { downloadable: true },
    context_tokens: 131_072,
    description: `${fields.name} for tests.`,
    download_bytes: gb(10),
    fit: "gpu",
    memory_bytes: gb(12),
    pool: "gpu:0",
    quant: "Q4_K_M",
    recommended: false,
    state: "absent",
    vision: false,
    ...fields,
  };
}

export function modelView(
  model: LocalModel,
  usedBy: string[] = [],
): LocalModelView {
  return {
    model,
    used_by: usedBy.map((name, index) => ({
      agent_id: `agent-${model.id}-${index}`,
      name,
    })),
  };
}

export function gpuPool(
  index: number,
  totalGb: number,
  holders: { id: string; name: string; gb: number; component?: boolean }[] = [],
): LocalModelPool {
  return {
    gpu_index: index,
    holders: holders.map((holder) => ({
      bytes: gb(holder.gb),
      id: holder.id,
      kind: holder.component ? "component" : "model",
      name: holder.name,
    })),
    id: `gpu:${index}`,
    kind: "gpu",
    total_bytes: gb(totalGb),
    used_bytes: gb(holders.reduce((sum, holder) => sum + holder.gb, 0)),
  };
}

export function memoryPool(
  kind: "system" | "unified",
  totalGb: number,
  holders: { id: string; name: string; gb: number }[] = [],
): LocalModelPool {
  return {
    holders: holders.map((holder) => ({
      bytes: gb(holder.gb),
      id: holder.id,
      kind: "model",
      name: holder.name,
    })),
    id: kind,
    kind,
    total_bytes: gb(totalGb),
    used_bytes: gb(holders.reduce((sum, holder) => sum + holder.gb, 0)),
  };
}

const coder = localModel({
  download_bytes: gb(18.6),
  endpoint: {
    base_url: "http://127.0.0.1:18100/v1",
  },
  id: "qwen3-coder-30b:Q4_K_M",
  memory_bytes: gb(21.4),
  name: "Qwen3 Coder 30B",
  pi_model: "localmodels-library/qwen3-coder-30b",
  pool: "gpu:0",
  state: "loaded",
  tokens_per_second: 46.2,
});

/**
 * A Linux Computer with two 24 GB cards: one model loaded on GPU 0, an
 * embedding component on GPU 1, and every other status the list shows.
 */
export function labView(
  fields: Partial<LocalModelsView> = {},
): LocalModelsView {
  return {
    available: true,
    computer: {
      computer_id: "computer-lab",
      display_name: "lab-118",
      host: {
        arch: "x86_64",
        disk_free_bytes: gb(412),
        engine_label: "llama.cpp b11370 · CUDA",
        gpus: [
          {
            free_bytes: gb(2.6),
            index: 0,
            name: "RTX 4090",
            total_bytes: gb(24),
          },
          {
            free_bytes: gb(22.9),
            index: 1,
            name: "RTX 4090",
            total_bytes: gb(24),
          },
        ],
        os_label: "Ubuntu 24.04",
        platform: "linux",
        ram_total_bytes: gb(128),
      },
      status: "online",
    },
    models: [
      modelView(coder, ["Research agent", "Code reviewer"]),
      modelView(
        localModel({
          download_bytes: gb(16.5),
          id: "gemma3-27b:Q4_K_M",
          memory_bytes: gb(19.2),
          name: "Gemma 3 27B",
          pi_model: "localmodels-library/gemma3-27b",
          pool: "gpu:1",
          state: "idle",
        }),
      ),
      modelView(
        localModel({
          download_bytes: gb(3.3),
          id: "gemma3-4b:Q4_K_M",
          memory_bytes: gb(4.1),
          name: "Gemma 3 4B",
          pool: "gpu:1",
        }),
      ),
      modelView(
        localModel({
          download_bytes: gb(42.5),
          fit: "system",
          id: "llama3.3-70b:Q4_K_M",
          memory_bytes: gb(46),
          name: "Llama 3.3 70B",
          pool: "system",
        }),
      ),
      modelView(
        localModel({
          download_bytes: gb(12.1),
          id: "gpt-oss-20b:Q4_K_M",
          memory_bytes: gb(14.3),
          name: "GPT-OSS 20B",
          pool: "gpu:1",
          recommended: true,
        }),
      ),
      modelView(
        localModel({
          availability: {
            downloadable: false,
            reason: {
              code: "MEMORY_INSUFFICIENT",
              have_bytes: gb(102.4),
              need_bytes: gb(230),
            },
          },
          download_bytes: gb(220),
          fit: "none",
          id: "llama3.1-405b:Q4_K_M",
          memory_bytes: gb(230),
          name: "Llama 3.1 405B",
          // A model that fits nowhere has no pool.
          pool: undefined,
        }),
      ),
    ],
    observed_at: "2026-11-13T10:00:00.000Z",
    pools: [
      gpuPool(0, 24, [{ gb: 21.4, id: coder.id, name: coder.name }]),
      gpuPool(1, 24, [
        { component: true, gb: 1.1, id: "embedding", name: "Qwen3 Embedding" },
      ]),
      memoryPool("system", 102.4),
    ],
    tool_version: "0.9.0",
    viewer_is_owner: true,
    ...fields,
  };
}

/**
 * A Mac with one unified pool: one model loaded for Another Me and one that
 * failed to load because the pool is full.
 */
export function macView(
  fields: Partial<LocalModelsView> = {},
): LocalModelsView {
  const gptOss = localModel({
    download_bytes: gb(12.1),
    endpoint: {
      base_url: "http://127.0.0.1:18100/v1",
    },
    fit: "unified",
    id: "gpt-oss-20b:Q4_K_M",
    memory_bytes: gb(14.3),
    name: "GPT-OSS 20B",
    pi_model: "localmodels-library/gpt-oss-20b",
    pool: "unified",
    state: "loaded",
  });
  return {
    available: true,
    computer: {
      computer_id: "computer-mac",
      display_name: "Mac Studio",
      host: {
        arch: "arm64",
        disk_free_bytes: gb(188),
        engine_label: "llama.cpp b11370 · Metal",
        gpus: [],
        os_label: "macOS 26",
        platform: "darwin",
        ram_total_bytes: gb(64),
      },
      status: "online",
    },
    models: [
      modelView(gptOss, ["Another Me"]),
      modelView(
        localModel({
          download_bytes: gb(42.5),
          error: { code: "LOAD_NO_ROOM", detail: "need 46 GiB, free 36.9 GiB" },
          fit: "unified",
          id: "llama3.3-70b:Q4_K_M",
          memory_bytes: gb(46),
          name: "Llama 3.3 70B",
          pool: "unified",
          state: "failed",
        }),
      ),
    ],
    observed_at: "2026-11-13T10:00:00.000Z",
    pools: [
      memoryPool("unified", 51.2, [
        { gb: 14.3, id: gptOss.id, name: gptOss.name },
      ]),
    ],
    viewer_is_owner: true,
    ...fields,
  };
}
