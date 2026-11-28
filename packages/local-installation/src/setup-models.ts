import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isInkling2MiniModelId } from "@linger/service-kit/featured-models";
import {
  localmodelsBaseDirectory,
  runLocalmodels,
} from "./localmodels-tool.js";
import { DEFAULT_GPU_SHARING } from "./setup-selection.js";

/** The id `localmodels library` uses for a model: `<catalog id>:<quant>`. */
export const LIBRARY_MODEL_ID = /^[a-z0-9][a-z0-9._-]*:[A-Za-z0-9._-]+$/;
export const LIBRARY_MODEL_ID_MAX = 200;

export function isLibraryModel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= LIBRARY_MODEL_ID_MAX &&
    LIBRARY_MODEL_ID.test(value)
  );
}

/** `inkling-2-mini:UD-Q4_K_M` -> the catalog id and quant `stack plan` takes. */
export function splitLibraryModel(value: string): {
  id: string;
  quant: string;
} {
  if (!isLibraryModel(value)) throw new Error("Invalid local model id.");
  const at = value.indexOf(":");
  return { id: value.slice(0, at), quant: value.slice(at + 1) };
}

/**
 * One model the setup page can offer, from the kit's own data: the library
 * (`library status`: name, publisher, sizes, whether it fits) joined with the
 * hardware report's estimates (`stack hardware`: quality score and decode
 * speed, both estimates the kit derives for this computer).
 */
export interface SetupModelOption {
  /** Library id, `<catalog id>:<quant>`; what Install passes back. */
  library: string;
  name: string;
  publisher?: string;
  quant: string;
  /** The kit's model family (`qwen`, `llama`, …, `other`), for its icon. */
  family?: string;
  /** Whether it is the featured release (Inkling 2 Mini), drawn apart. */
  featured?: boolean;
  /**
   * The Hugging Face organization of its `source_url`, lowercased: the
   * publisher's logo when the family has none, as on the Local models page.
   */
  sourceOrg?: string;
  /** The kit's quality score for this model, when it has one (0 = unscored). */
  quality?: number;
  /** Estimated single-stream decode speed on this computer, tokens/s. */
  decodeTokS?: number;
  downloadBytes: number;
  memoryBytes: number;
  /** Whether it fits this computer now. */
  fits: boolean;
  /** For a model that does not fit: the memory it needs. */
  needsMemoryBytes?: number;
  /** Whether it can never fit this computer, rather than not fitting now. */
  tooLarge?: boolean;
  recommended?: boolean;
  role?: "smartest" | "fastest";
}

export interface SetupModels {
  totalMemoryBytes?: number;
  /** Memory free now: the rest is held by the system and other apps. */
  availableMemoryBytes?: number;
  models: SetupModelOption[];
}

interface ModelsOptions {
  shareGpu?: boolean;
  /** The model library of the installation; default the tool home's. */
  baseDir?: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  localmodels?: typeof runLocalmodels;
}

const byteCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const text = (value: unknown, max = 120): string | undefined =>
  typeof value === "string" && value.trim() && value.trim().length <= max
    ? value.trim()
    : undefined;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
// `https://huggingface.co/<org>/<repo>` -> `<org>`, lowercased.
const HUGGING_FACE_HOSTS = new Set([
  "huggingface.co",
  "www.huggingface.co",
  "hf.co",
]);
const huggingFaceOrg = (value: unknown): string | undefined => {
  const url = text(value, 500);
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (!HUGGING_FACE_HOSTS.has(parsed.hostname.toLowerCase()))
      return undefined;
    const org = parsed.pathname.split("/").find(Boolean)?.toLowerCase();
    return org && /^[a-z0-9][a-z0-9._-]{0,95}$/.test(org) ? org : undefined;
  } catch {
    return undefined;
  }
};

async function json(
  tool: typeof runLocalmodels,
  home: string,
  args: string[],
  options: ModelsOptions,
): Promise<Record<string, unknown> | undefined> {
  const result = await tool(home, args, {
    signal: options.signal,
    ...(options.env ? { env: options.env } : {}),
    timeoutMs: 60000,
    bundledPi: null,
  });
  if (result.code !== 0) return undefined;
  try {
    return record(JSON.parse(result.stdout));
  } catch {
    return undefined;
  }
}

/**
 * Every model in the kit's catalog for this computer, fitting or not. Reads
 * only; a missing or failing report leaves the list empty, and the page then
 * keeps the planned model alone.
 */
export async function listSetupModels(
  home: string,
  options: Omit<ModelsOptions, "shareGpu"> = {},
): Promise<SetupModels> {
  const tool = options.localmodels ?? runLocalmodels;
  const [library, hardware] = await Promise.all([
    json(
      tool,
      home,
      [
        "library",
        "status",
        "--base-dir",
        options.baseDir ?? localmodelsBaseDirectory(home),
        "--json",
      ],
      options,
    ).catch(() => undefined),
    json(
      tool,
      home,
      // The hardware report takes no GPU-sharing flag: its estimates are
      // for the model alone.
      ["stack", "hardware", "--json"],
      options,
    ).catch(() => undefined),
  ]);
  options.signal?.throwIfAborted();
  if (library?.schema !== "localmodels.library-status/v1" || !library)
    return { models: [] };
  // Estimates per `<catalog id>:<quant>`: the best card's, which on a Mac is
  // the one unified pool.
  const estimates = new Map<string, { quality?: number; tokS?: number }>();
  const roles = new Map<string, "smartest" | "fastest">();
  const cards = Array.isArray(hardware?.cards) ? hardware.cards : [];
  for (const card of cards) {
    const rows = record(card)?.llm;
    if (!Array.isArray(rows)) continue;
    for (const raw of rows) {
      const row = record(raw);
      const id = text(row?.id, 160);
      const quant = text(row?.quant, 60);
      if (!row || !id || !quant) continue;
      const key = `${id}:${quant}`;
      // The kit scores an unbenchmarked model 0.
      const quality =
        byteCount(row.quality) && row.quality > 0 ? row.quality : undefined;
      const tokS = byteCount(row.decode_tok_s) ? row.decode_tok_s : undefined;
      const known = estimates.get(key);
      if (!known || (tokS ?? 0) > (known.tokS ?? 0))
        estimates.set(key, { quality, tokS });
    }
  }
  for (const raw of Array.isArray(hardware?.picks) ? hardware.picks : []) {
    const pick = record(raw);
    const id = text(pick?.id, 160);
    const quant = text(pick?.quant, 60);
    if (
      id &&
      quant &&
      (pick?.role === "smartest" || pick?.role === "fastest") &&
      !roles.has(`${id}:${quant}`)
    )
      roles.set(`${id}:${quant}`, pick.role);
  }
  const host = record(library.host);
  const models: SetupModelOption[] = [];
  for (const raw of Array.isArray(library.models) ? library.models : []) {
    const model = record(raw);
    if (!model || !isLibraryModel(model.id)) continue;
    const library = model.id;
    const quant = text(model.quant, 60) ?? splitLibraryModel(library).quant;
    if (!byteCount(model.download_bytes)) continue;
    const availability = record(model.availability);
    const reason = record(availability?.reason);
    const tooLarge =
      model.fit === "none" || availability?.downloadable === false;
    const fits = !tooLarge && model.fits_now !== false;
    const needs = byteCount(reason?.need_bytes)
      ? reason.need_bytes
      : byteCount(model.minimum_memory_bytes)
        ? model.minimum_memory_bytes
        : undefined;
    const memoryBytes = byteCount(model.memory_bytes)
      ? model.memory_bytes
      : (needs ?? 0);
    // The kit names a model "Name (QUANT)"; the page shows the quant apart.
    const fullName = text(model.name) ?? library;
    const suffix = ` (${quant})`;
    const name = fullName.endsWith(suffix)
      ? fullName.slice(0, -suffix.length)
      : fullName;
    const estimate = estimates.get(library);
    const role = roles.get(library);
    const publisher = text(model.publisher, 80);
    const family = text(model.family, 20);
    const sourceOrg = huggingFaceOrg(model.source_url);
    models.push({
      library,
      name,
      ...(publisher ? { publisher } : {}),
      quant,
      ...(family ? { family } : {}),
      ...(isInkling2MiniModelId(splitLibraryModel(library).id)
        ? { featured: true }
        : {}),
      ...(sourceOrg ? { sourceOrg } : {}),
      ...(estimate?.quality !== undefined ? { quality: estimate.quality } : {}),
      ...(estimate?.tokS !== undefined ? { decodeTokS: estimate.tokS } : {}),
      downloadBytes: model.download_bytes,
      memoryBytes,
      fits,
      ...(!fits && needs !== undefined ? { needsMemoryBytes: needs } : {}),
      ...(tooLarge ? { tooLarge: true } : {}),
      ...(model.recommended === true ? { recommended: true } : {}),
      ...(role ? { role } : {}),
    });
  }
  return {
    ...(byteCount(host?.ram_total_bytes)
      ? { totalMemoryBytes: host.ram_total_bytes }
      : {}),
    ...(byteCount(host?.ram_available_bytes)
      ? { availableMemoryBytes: host.ram_available_bytes }
      : {}),
    models,
  };
}

/** Whether one model fits now, priced by an offline install plan. */
export interface SetupModelCheck {
  library: string;
  fits: boolean;
  /** The kit's refusal code when it does not fit, e.g. MEMORY_INSUFFICIENT. */
  code?: string;
  memoryBytes?: number;
  ramAvailableBytes?: number;
  downloadBytes?: number;
  diskBytes?: number;
  diskFreeBytes?: number;
}

/**
 * Plans the install for one picked model, offline and without writing the
 * installation's plan: the same `stack plan` the install runs, into a private
 * temporary file that is removed afterwards. A model the kit would swap for
 * another, or a plan short of disk, does not fit.
 */
export async function checkSetupModel(
  home: string,
  library: string,
  options: ModelsOptions = {},
): Promise<SetupModelCheck> {
  const { id, quant } = splitLibraryModel(library);
  const tool = options.localmodels ?? runLocalmodels;
  const directory = await mkdtemp(path.join(tmpdir(), "linger-model-check-"));
  const out = path.join(directory, "plan.json");
  try {
    const result = await tool(
      home,
      [
        "stack",
        "plan",
        "--llm",
        id,
        "--quant",
        quant,
        "--decision",
        "none",
        "--defer-services",
        ...((options.shareGpu ?? DEFAULT_GPU_SHARING) ? ["--share-gpu"] : []),
        "--offline",
        "--base-dir",
        options.baseDir ?? localmodelsBaseDirectory(home),
        "--out",
        out,
        "--json",
      ],
      {
        signal: options.signal,
        ...(options.env ? { env: options.env } : {}),
        timeoutMs: 60000,
        bundledPi: null,
      },
    );
    options.signal?.throwIfAborted();
    if (result.code !== 0) {
      let code = "PLAN_FAILED";
      try {
        const refusal = record(JSON.parse(result.stdout));
        const named = text(refusal?.code, 60);
        if (named && /^[A-Z0-9_]+$/.test(named)) code = named;
      } catch {
        // Not JSON: keep the generic code.
      }
      return { library, fits: false, code };
    }
    const plan = record(JSON.parse(await readFile(out, "utf8")));
    const model = record(record(plan?.llm)?.model);
    const budget = record(plan?.budget);
    if (model?.id !== id || model?.quant !== quant)
      return { library, fits: false, code: "MODEL_SUBSTITUTED" };
    const numbers = {
      ...(byteCount(budget?.ram_needed_bytes)
        ? { memoryBytes: budget.ram_needed_bytes }
        : {}),
      ...(byteCount(budget?.ram_available_bytes)
        ? { ramAvailableBytes: budget.ram_available_bytes }
        : {}),
      ...(byteCount(budget?.download_bytes)
        ? { downloadBytes: budget.download_bytes }
        : {}),
      ...(byteCount(budget?.disk_needed_bytes)
        ? { diskBytes: budget.disk_needed_bytes }
        : {}),
      ...(byteCount(budget?.disk_free_bytes)
        ? { diskFreeBytes: budget.disk_free_bytes }
        : {}),
    };
    const diskShort =
      numbers.diskBytes !== undefined &&
      numbers.diskFreeBytes !== undefined &&
      numbers.diskBytes > numbers.diskFreeBytes;
    return {
      library,
      fits: !diskShort,
      ...(diskShort ? { code: "DISK_INSUFFICIENT" } : {}),
      ...numbers,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
