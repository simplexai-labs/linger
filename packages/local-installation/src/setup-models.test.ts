import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  checkSetupModel,
  isLibraryModel,
  listSetupModels,
  splitLibraryModel,
} from "./setup-models.js";

// Trimmed from `localmodels library status --json` and `stack hardware
// --json` on a simulated 64 GB Mac with a 24 GB GPU share.
const library = {
  schema: "localmodels.library-status/v1",
  host: {
    platform: "darwin",
    arch: "arm64",
    ram_total_bytes: 68719476736,
    ram_available_bytes: 41231686041,
  },
  models: [
    {
      id: "inkling-2-mini:UD-Q4_K_M",
      name: "Inkling 2 Mini (UD-Q4_K_M)",
      quant: "UD-Q4_K_M",
      download_bytes: 17252349088,
      memory_bytes: 26164568756,
      fit: "unified",
      recommended: true,
      availability: { downloadable: true },
      fits_now: true,
      minimum_memory_bytes: 19847946932,
      publisher: "Thinking Machines",
      architecture: "moe",
      parameters: "26.4B",
      active_parameters: "3.4B",
    },
    {
      id: "inkling-2-mini-iq3xxs:UD-IQ3_XXS",
      name: "Inkling 2 Mini (UD-IQ3_XXS)",
      quant: "UD-IQ3_XXS",
      download_bytes: 12305115264,
      memory_bytes: 24005334676,
      fit: "unified",
      availability: { downloadable: true },
      fits_now: true,
      publisher: "Thinking Machines",
    },
    {
      id: "qwen3.6-35b-a3b:UD-Q4_K_M",
      name: "Qwen3.6 35B-A3B (UD-Q4_K_M)",
      quant: "UD-Q4_K_M",
      download_bytes: 23566209952,
      memory_bytes: 27105678321,
      fit: "unified",
      availability: { downloadable: true },
      fits_now: false,
      minimum_memory_bytes: 25216865265,
      publisher: "Qwen",
    },
    {
      id: "qwen3.8-flash-next-iq2xs:GSQ-RCO-IQ2_XS",
      name: "Qwen3.8 Flash Next (GSQ-RCO-IQ2_XS)",
      quant: "GSQ-RCO-IQ2_XS",
      download_bytes: 68933635968,
      memory_bytes: 73749164887,
      fit: "none",
      availability: {
        downloadable: false,
        reason: {
          code: "MEMORY_INSUFFICIENT",
          need_bytes: 69513662903,
          have_bytes: 23788519008,
        },
      },
      fits_now: false,
      publisher: "Qwen",
    },
    { id: "../escape", name: "Bad", download_bytes: 1 },
  ],
};
const hardware = {
  cards: [
    {
      index: 0,
      llm: [
        {
          id: "inkling-2-mini",
          quant: "UD-Q4_K_M",
          quality: 54,
          decode_tok_s: 63.2,
        },
        {
          id: "inkling-2-mini-iq3xxs",
          quant: "UD-IQ3_XXS",
          quality: 53,
          decode_tok_s: 90,
        },
        // Not benchmarked: the kit scores it 0.
        {
          id: "qwen3.6-35b-a3b",
          quant: "UD-Q4_K_M",
          quality: 0,
          decode_tok_s: 76.9,
        },
      ],
    },
  ],
  picks: [
    { id: "inkling-2-mini", quant: "UD-Q4_K_M", role: "smartest" },
    { id: "inkling-2-mini-iq3xxs", quant: "UD-IQ3_XXS", role: "fastest" },
  ],
};
const answer = (args: string[]) => {
  if (args[0] === "library" && args[1] === "status")
    return { code: 0, stdout: JSON.stringify(library), stderr: "" };
  if (args[0] === "stack" && args[1] === "hardware")
    return { code: 0, stdout: JSON.stringify(hardware), stderr: "" };
  return { code: 2, stdout: "", stderr: "unexpected" };
};

it("validates and splits library ids", () => {
  expect(isLibraryModel("inkling-2-mini:UD-Q4_K_M")).toBe(true);
  expect(isLibraryModel("../x:y")).toBe(false);
  expect(isLibraryModel(`a:${"b".repeat(200)}`)).toBe(false);
  expect(splitLibraryModel("qwen3.6-35b-a3b:UD-IQ4_XS")).toEqual({
    id: "qwen3.6-35b-a3b",
    quant: "UD-IQ4_XS",
  });
  expect(() => splitLibraryModel("--llm")).toThrow();
});

it("lists every catalog model with the kit's estimates and whether it fits", async () => {
  const localmodels = vi.fn(async (_home: string, args: string[]) =>
    answer(args),
  );
  const home = path.resolve("/owned");
  const listing = await listSetupModels(home, {
    localmodels,
    baseDir: "/target/models",
  });
  expect(localmodels).toHaveBeenCalledWith(
    home,
    ["library", "status", "--base-dir", "/target/models", "--json"],
    expect.objectContaining({ bundledPi: null }),
  );
  expect(localmodels).toHaveBeenCalledWith(
    home,
    ["stack", "hardware", "--json"],
    expect.objectContaining({ bundledPi: null }),
  );
  expect(listing.totalMemoryBytes).toBe(68719476736);
  expect(listing.availableMemoryBytes).toBe(41231686041);
  expect(listing.models.map((model) => model.library)).toEqual([
    "inkling-2-mini:UD-Q4_K_M",
    "inkling-2-mini-iq3xxs:UD-IQ3_XXS",
    "qwen3.6-35b-a3b:UD-Q4_K_M",
    "qwen3.8-flash-next-iq2xs:GSQ-RCO-IQ2_XS",
  ]);
  expect(listing.models[0]).toEqual({
    library: "inkling-2-mini:UD-Q4_K_M",
    name: "Inkling 2 Mini",
    publisher: "Thinking Machines",
    quant: "UD-Q4_K_M",
    parameters: "26.4B",
    activeParameters: "3.4B",
    architecture: "moe",
    quality: 54,
    decodeTokS: 63.2,
    downloadBytes: 17252349088,
    memoryBytes: 26164568756,
    fits: true,
    recommended: true,
    role: "smartest",
  });
  expect(listing.models[1]).toMatchObject({ role: "fastest", fits: true });
  // Fits this computer, but not the memory free now.
  expect(listing.models[2]).toMatchObject({
    fits: false,
    needsMemoryBytes: 25216865265,
  });
  expect(listing.models[2]?.tooLarge).toBeUndefined();
  // An unscored model keeps its speed but has no quality.
  expect(listing.models[2]?.quality).toBeUndefined();
  expect(listing.models[2]?.decodeTokS).toBe(76.9);
  // Never fits: the memory the kit says it needs.
  expect(listing.models[3]).toMatchObject({
    fits: false,
    tooLarge: true,
    needsMemoryBytes: 69513662903,
  });
});

it("keeps the list empty when the library report fails, and estimates optional", async () => {
  const failing = vi.fn(async () => ({ code: 1, stdout: "", stderr: "no" }));
  expect(await listSetupModels("/owned", { localmodels: failing })).toEqual({
    models: [],
  });
  const noHardware = vi.fn(async (_home: string, args: string[]) =>
    args[0] === "stack" ? { code: 1, stdout: "", stderr: "" } : answer(args),
  );
  const listing = await listSetupModels("/owned", { localmodels: noHardware });
  expect(listing.models[0]?.quality).toBeUndefined();
  expect(listing.models[0]?.role).toBeUndefined();
  expect(listing.models).toHaveLength(4);
});

const plan = (model: object, budget: object) =>
  JSON.stringify({
    schema: "localmodels.stack-plan/v1",
    llm: { model },
    budget,
  });

it("prices a picked model with an offline plan into a temporary file", async () => {
  let out = "";
  const localmodels = vi.fn(async (_home: string, args: string[]) => {
    out = args[args.indexOf("--out") + 1]!;
    await writeFile(
      out,
      plan(
        { id: "qwen3.6-35b-a3b", quant: "UD-IQ4_XS" },
        {
          ram_available_bytes: 58e9,
          ram_needed_bytes: 34e9,
          disk_free_bytes: 1e12,
          disk_needed_bytes: 19.5e9,
          download_bytes: 19.3e9,
        },
      ),
    );
    return { code: 0, stdout: "{}", stderr: "" };
  });
  const check = await checkSetupModel("/owned", "qwen3.6-35b-a3b:UD-IQ4_XS", {
    localmodels,
    shareGpu: false,
    baseDir: "/target/models",
  });
  expect(localmodels.mock.calls[0]?.[1]).toEqual([
    "stack",
    "plan",
    "--llm",
    "qwen3.6-35b-a3b",
    "--quant",
    "UD-IQ4_XS",
    "--decision",
    "none",
    "--defer-services",
    "--offline",
    "--base-dir",
    "/target/models",
    "--out",
    out,
    "--json",
  ]);
  expect(check).toEqual({
    library: "qwen3.6-35b-a3b:UD-IQ4_XS",
    fits: true,
    memoryBytes: 34e9,
    ramAvailableBytes: 58e9,
    downloadBytes: 19.3e9,
    diskBytes: 19.5e9,
    diskFreeBytes: 1e12,
  });
  // The plan file does not outlive the check.
  await expect(
    import("node:fs/promises").then((fs) => fs.stat(out)),
  ).rejects.toThrow();
});

it("reports the kit's refusal, a substituted model and a short disk", async () => {
  const refused = vi.fn(async () => ({
    code: 2,
    stdout: JSON.stringify({
      schema: "localmodels.stack-plan-error/v1",
      event: "error",
      code: "MEMORY_INSUFFICIENT",
    }),
    stderr: "stack: does not fit",
  }));
  expect(
    await checkSetupModel("/owned", "qwen3.6-35b-a3b:UD-Q4_K_M", {
      localmodels: refused,
    }),
  ).toEqual({
    library: "qwen3.6-35b-a3b:UD-Q4_K_M",
    fits: false,
    code: "MEMORY_INSUFFICIENT",
  });
  const writes = (model: object, budget: object) =>
    vi.fn(async (_home: string, args: string[]) => {
      await writeFile(args[args.indexOf("--out") + 1]!, plan(model, budget));
      return { code: 0, stdout: "{}", stderr: "" };
    });
  expect(
    await checkSetupModel("/owned", "inkling-2-mini:UD-Q4_K_M", {
      localmodels: writes({ id: "inkling-2-mini", quant: "UD-IQ3_XXS" }, {}),
    }),
  ).toMatchObject({ fits: false, code: "MODEL_SUBSTITUTED" });
  expect(
    await checkSetupModel("/owned", "inkling-2-mini:UD-Q4_K_M", {
      localmodels: writes(
        { id: "inkling-2-mini", quant: "UD-Q4_K_M" },
        { disk_needed_bytes: 20e9, disk_free_bytes: 5e9 },
      ),
    }),
  ).toMatchObject({ fits: false, code: "DISK_INSUFFICIENT" });
  await expect(checkSetupModel("/owned", "--help:x")).rejects.toThrow(
    "Invalid local model id.",
  );
});
