import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { x as extract } from "tar";
import { privateDirectory } from "./private-files.js";
import { npmMirrorRegistry, npmRegistry } from "./npm-registry.js";
import { runProcess, type ProcessOptions } from "./process.js";
import { resolveRegion, type Region } from "./region.js";
import {
  clearActiveToolRecord,
  compareSemver,
  evaluateLocalmodelsManifest,
  inferToolVersions,
  isPrereleaseSemver,
  LOCALMODELS_UPDATE_PUBLIC_KEY,
  LocalmodelsManifestError,
  verifyLocalmodelsManifest,
  writeActiveToolRecord,
  type LocalmodelsToolSource,
  type LocalmodelsUpdateManifest,
  type VerifiedLocalmodelsManifest,
} from "./localmodels-manifest.js";
import {
  ensureLocalmodelsTool,
  localmodelsBaseDirectory,
  localmodelsReadOnlyEnvironment,
  localmodelsStateDirectory,
  resolveEffectiveToolSource,
} from "./localmodels-tool.js";
import type { LocalmodelsComputerTool } from "./localmodels-computer.js";

const NPM_PACKAGE = "@simplexai/localmodels";
const CDN_RELEASE_BASE =
  "https://d2ikbbcl3j6jz9.cloudfront.net/cli/localmodels";
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const DIST_TAGS_MAX_BYTES = 64 * 1024;
const TARBALL_MAX_BYTES = 1024 * 1024;
const MANIFEST_MAX_BYTES = 256 * 1024;
const SIGNATURE_MAX_BYTES = 4 * 1024;
const CHECK_TIMEOUT_MS = 15_000;
const SMOKE_TIMEOUT_MS = 30_000;

export class LocalmodelsUpdateError extends Error {}

export type LocalmodelsUpdateCheckResult =
  | { readonly kind: "up_to_date" }
  | {
      readonly kind: "available";
      readonly verified: VerifiedLocalmodelsManifest;
      readonly kit: LocalmodelsToolSource;
    }
  | {
      readonly kind: "requires_app_update";
      readonly manifest: LocalmodelsUpdateManifest;
      readonly minLingerVersion: string;
    };

export interface CheckLocalmodelsUpdateOptions {
  readonly home: string;
  readonly baseline: LocalmodelsToolSource;
  readonly desktopVersion: string;
  readonly target?: string;
  readonly feedUrl?: string;
  readonly publicKey?: string;
  readonly signal?: AbortSignal;
  readonly fetcher?: typeof fetch;
  readonly region?: Region;
}

export interface StagedLocalmodelsUpdate {
  readonly verified: VerifiedLocalmodelsManifest;
  readonly kit: LocalmodelsToolSource;
  readonly tool: LocalmodelsComputerTool;
}

export interface StageLocalmodelsUpdateOptions {
  readonly home: string;
  readonly verified: VerifiedLocalmodelsManifest;
  readonly kit: LocalmodelsToolSource;
  readonly signal?: AbortSignal;
  readonly onPhase?: (phase: "downloading" | "verifying") => void;
  readonly onProgress?: (completed: number, total?: number) => void;
  readonly fetcher?: typeof fetch;
  readonly run?: typeof runProcess;
}

function distTagUrls(region: Region): string[] {
  const cn = `${npmMirrorRegistry}-/package/${NPM_PACKAGE}/dist-tags`;
  const global = `${npmRegistry}-/package/${NPM_PACKAGE}/dist-tags`;
  return region === "cn" ? [cn, global] : [global, cn];
}

function scriptsTarballUrls(npmVersion: string, region: Region): string[] {
  const cn = `https://cdn.npmmirror.com/packages/${NPM_PACKAGE}/${npmVersion}/localmodels-${npmVersion}.tgz`;
  const global = `${npmRegistry}${NPM_PACKAGE}/-/localmodels-${npmVersion}.tgz`;
  return region === "cn" ? [cn, global] : [global, cn];
}

function toCdnVersion(npmVersion: string): string {
  return npmVersion
    .replace(/^(\d+\.\d+\.\d+)-dev\.(\d+)$/, "$1.dev$2")
    .replace(/^(\d+\.\d+\.\d+)-(a|b|rc)\.(\d+)$/, "$1$2$3");
}

function pickCandidateVersion(
  distTags: Record<string, unknown>,
  allowPrerelease: boolean,
): string | undefined {
  const candidates: string[] = [];
  const latest = distTags.latest;
  if (typeof latest === "string" && SEMVER_RE.test(latest)) {
    if (!isPrereleaseSemver(latest)) candidates.push(latest);
  }
  if (allowPrerelease) {
    const next = distTags.next;
    if (typeof next === "string" && SEMVER_RE.test(next)) candidates.push(next);
  }
  if (candidates.length === 0) return undefined;
  return candidates.sort((a, b) => compareSemver(b, a))[0];
}

async function fetchBounded(
  url: string,
  maxBytes: number,
  options: { signal?: AbortSignal; fetcher?: typeof fetch },
): Promise<Buffer | undefined> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:")
    throw new LocalmodelsUpdateError("Update feed URL must use https.");
  const timeout = AbortSignal.timeout(CHECK_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  const response = await (options.fetcher ?? fetch)(url, { signal });
  if (response.status === 404) return undefined;
  if (!response.ok)
    throw new LocalmodelsUpdateError(
      `Update host ${parsed.hostname} returned HTTP ${String(response.status)}.`,
    );
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader) {
    const declared = Number(lengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes)
      throw new LocalmodelsUpdateError("Update metadata exceeds size limit.");
  }
  const chunks: Buffer[] = [];
  let received = 0;
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes)
        throw new LocalmodelsUpdateError("Update metadata exceeds size limit.");
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, received);
}

async function fetchDistTags(
  region: Region,
  options: { signal?: AbortSignal; fetcher?: typeof fetch },
): Promise<Record<string, unknown>> {
  let lastError: unknown;
  for (const url of distTagUrls(region)) {
    try {
      const bytes = await fetchBounded(url, DIST_TAGS_MAX_BYTES, options);
      if (!bytes) continue;
      const parsed: unknown = JSON.parse(bytes.toString("utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        return parsed as Record<string, unknown>;
      throw new LocalmodelsUpdateError(
        "Registry dist-tags response is invalid.",
      );
    } catch (error) {
      if (options.signal?.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new LocalmodelsUpdateError("Couldn't reach npm registries for updates.");
}

async function extractSignedManifestFromTarball(
  tarballBytes: Buffer,
): Promise<{ manifest: Buffer; signature: string } | undefined> {
  const work = path.join(
    os.tmpdir(),
    `linger-localmodels-manifest-${randomUUID()}`,
  );
  await privateDirectory(work);
  const archive = path.join(work, "scripts.tgz");
  const unpacked = path.join(work, "unpacked");
  await privateDirectory(unpacked);
  try {
    await writeFile(archive, tarballBytes, { mode: 0o600 });
    let extractedSize = 0;
    let refused: Error | undefined;
    await extract({
      file: archive,
      cwd: unpacked,
      strict: true,
      preservePaths: false,
      filter: (entryPath, entry) => {
        if (refused) return false;
        const normalized = entryPath.replace(/^\.\//, "");
        if (
          normalized !== "package/manifest.json" &&
          normalized !== "package/manifest.json.sig"
        )
          return false;
        const type =
          "type" in entry
            ? entry.type
            : entry.isFile()
              ? "File"
              : "Unsupported";
        if (type !== "File") {
          refused = new LocalmodelsUpdateError(
            "Update metadata entry must be a regular file.",
          );
          return false;
        }
        extractedSize += entry.size;
        if (extractedSize > MANIFEST_MAX_BYTES + SIGNATURE_MAX_BYTES) {
          refused = new LocalmodelsUpdateError(
            "Extracted update manifest exceeds size limit.",
          );
          return false;
        }
        return true;
      },
    });
    if (refused) throw refused;
    const manifestPath = path.join(unpacked, "package", "manifest.json");
    const sigPath = path.join(unpacked, "package", "manifest.json.sig");
    let manifest: Buffer;
    let signature: string;
    try {
      manifest = await readFile(manifestPath);
      signature = await readFile(sigPath, "utf8");
    } catch {
      return undefined;
    }
    return { manifest, signature };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function fetchManifestFromFeed(
  feedUrl: string,
  options: { signal?: AbortSignal; fetcher?: typeof fetch },
): Promise<{ manifest: Buffer; signature: string } | undefined> {
  const manifestUrl = feedUrl.endsWith("/manifest.json")
    ? feedUrl
    : new URL(
        "manifest.json",
        feedUrl.endsWith("/") ? feedUrl : `${feedUrl}/`,
      ).toString();
  const signatureUrl = `${manifestUrl}.sig`;
  const [manifest, signatureBytes] = await Promise.all([
    fetchBounded(manifestUrl, MANIFEST_MAX_BYTES, options),
    fetchBounded(signatureUrl, SIGNATURE_MAX_BYTES, options),
  ]);
  if (!manifest || !signatureBytes) return undefined;
  return { manifest, signature: signatureBytes.toString("utf8") };
}

async function fetchManifestForNpmVersion(
  npmVersion: string,
  region: Region,
  options: { signal?: AbortSignal; fetcher?: typeof fetch },
): Promise<{ manifest: Buffer; signature: string } | undefined> {
  let lastError: unknown;
  let sawUnsignedRelease = false;
  for (const url of scriptsTarballUrls(npmVersion, region)) {
    try {
      const archive = await fetchBounded(url, TARBALL_MAX_BYTES, options);
      if (!archive) continue;
      const extracted = await extractSignedManifestFromTarball(archive);
      if (extracted) return extracted;
      sawUnsignedRelease = true;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      lastError = error;
    }
  }
  const cdnFeed = `${CDN_RELEASE_BASE}/${toCdnVersion(npmVersion)}/`;
  try {
    const fromCdn = await fetchManifestFromFeed(cdnFeed, options);
    if (fromCdn) return fromCdn;
    sawUnsignedRelease = true;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    lastError = error;
  }
  if (sawUnsignedRelease) return undefined;
  throw lastError instanceof Error
    ? lastError
    : new LocalmodelsUpdateError("Couldn't download update manifest.");
}

/**
 * Check whether a compatible, Ed25519-signed newer localmodels kit is
 * available. Downloads only small metadata (dist-tags and signed manifest);
 * never downloads the platform kit archive.
 */
export async function checkLocalmodelsUpdate(
  options: CheckLocalmodelsUpdateOptions,
): Promise<LocalmodelsUpdateCheckResult> {
  const publicKey = options.publicKey ?? LOCALMODELS_UPDATE_PUBLIC_KEY;
  if (!publicKey.trim()) return { kind: "up_to_date" };
  const target = options.target ?? `${process.platform}-${process.arch}`;
  const baselineVersions = inferToolVersions(options.baseline);
  const baselineNpm = baselineVersions.npmVersion;
  const effective = await resolveEffectiveToolSource(
    options.home,
    options.baseline,
    {
      target,
      desktopVersion: options.desktopVersion,
      publicKey,
    },
  );
  const currentNpm = effective?.npmVersion ?? baselineNpm;
  let fetched: { manifest: Buffer; signature: string } | undefined;
  let expectedNpmVersion: string | undefined;

  if (options.feedUrl) {
    fetched = await fetchManifestFromFeed(options.feedUrl, {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    });
  } else {
    const region =
      options.region ??
      (await resolveRegion(options.home, {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.fetcher ? { fetcher: options.fetcher } : {}),
      }));
    const distTags = await fetchDistTags(region, {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    });
    const allowPrerelease = baselineNpm
      ? isPrereleaseSemver(baselineNpm)
      : false;
    const candidate = pickCandidateVersion(distTags, allowPrerelease);
    if (!candidate) return { kind: "up_to_date" };
    if (currentNpm && compareSemver(candidate, currentNpm) <= 0)
      return { kind: "up_to_date" };
    expectedNpmVersion = candidate;
    fetched = await fetchManifestForNpmVersion(candidate, region, {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    });
  }
  if (!fetched) return { kind: "up_to_date" };

  const manifest = verifyLocalmodelsManifest(
    fetched.manifest,
    fetched.signature,
    publicKey,
  );
  if (expectedNpmVersion && manifest.npmVersion !== expectedNpmVersion)
    throw new LocalmodelsManifestError(
      "Signed manifest version does not match the announced release.",
    );

  const evaluated = evaluateLocalmodelsManifest({
    manifest,
    target,
    ...(currentNpm ? { currentNpmVersion: currentNpm } : {}),
    ...(baselineNpm ? { baselineNpmVersion: baselineNpm } : {}),
    desktopVersion: options.desktopVersion,
  });
  if (evaluated.kind === "requires_app_update")
    return {
      kind: "requires_app_update",
      manifest,
      minLingerVersion: evaluated.minLingerVersion,
    };
  if (evaluated.kind !== "compatible") return { kind: "up_to_date" };
  return {
    kind: "available",
    verified: {
      manifest,
      raw: fetched.manifest.toString("utf8"),
      signature: fetched.signature,
    },
    kit: evaluated.kit,
  };
}

async function runSmokeCheck(
  home: string,
  tool: LocalmodelsComputerTool,
  args: string[],
  expectedSchema: string,
  options: { signal?: AbortSignal; run?: typeof runProcess },
): Promise<void> {
  const run = options.run ?? runProcess;
  const env = await localmodelsReadOnlyEnvironment(
    home,
    tool.moduleDirectory,
    args,
  );
  const runOptions: ProcessOptions = {
    cwd: tool.moduleDirectory,
    env,
    timeoutMs: SMOKE_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const result = await run(
    tool.python,
    ["-P", "-s", "-m", "localmodels", ...args],
    runOptions,
  );
  if (result.code !== 0)
    throw new LocalmodelsUpdateError(
      `New model engine failed smoke check (${args.slice(0, 2).join(" ")} exited ${String(result.code)}).`,
    );
  let parsed: { schema?: unknown };
  try {
    parsed = JSON.parse(result.stdout) as { schema?: unknown };
  } catch {
    throw new LocalmodelsUpdateError(
      `New model engine returned invalid JSON during smoke check (${args.slice(0, 2).join(" ")}).`,
    );
  }
  if (parsed.schema !== expectedSchema)
    throw new LocalmodelsUpdateError(
      `New model engine reported unexpected schema during smoke check (${String(parsed.schema)}).`,
    );
}

/**
 * Download, verify, seal and read-only smoke-test a newer kit into the
 * content-addressed tools directory without changing the active pointer yet.
 */
export async function stageLocalmodelsUpdate(
  options: StageLocalmodelsUpdateOptions,
): Promise<StagedLocalmodelsUpdate> {
  options.onPhase?.("downloading");
  const location = await ensureLocalmodelsTool(
    options.home,
    {
      ...(options.signal ? { signal: options.signal } : {}),
      onEvent: (event) => {
        if (event.kind === "stage" && event.progress)
          options.onProgress?.(event.progress.completed, event.progress.total);
      },
    },
    {
      source: options.kit,
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    },
  );
  const stateDirectory = localmodelsStateDirectory(options.home);
  const baseDirectory = localmodelsBaseDirectory(options.home);
  await privateDirectory(stateDirectory);
  await privateDirectory(baseDirectory);
  const tool: LocalmodelsComputerTool = {
    python: location.python,
    moduleDirectory: location.moduleDir,
    stateDirectory,
    baseDirectory,
  };
  options.onPhase?.("verifying");
  await runSmokeCheck(
    options.home,
    tool,
    ["stack", "capabilities", "--json"],
    "localmodels.stack-capabilities/v1",
    options,
  );
  await runSmokeCheck(
    options.home,
    tool,
    ["library", "status", "--base-dir", baseDirectory, "--json"],
    "localmodels.library-status/v1",
    options,
  );
  return {
    verified: options.verified,
    kit: options.kit,
    tool,
  };
}

/**
 * Atomically activate a staged and smoke-tested kit by recording its signed
 * manifest in `tools/localmodels/active.json`. Earlier kit directories stay on
 * disk so existing deployments' launchers remain runnable for `stack up`.
 */
export async function activateLocalmodelsUpdate(
  home: string,
  staged: StagedLocalmodelsUpdate,
  options: { baseline?: LocalmodelsToolSource; now?: number } = {},
): Promise<LocalmodelsComputerTool> {
  const updatedAt = new Date(options.now ?? Date.now()).toISOString();
  await writeActiveToolRecord(home, staged.verified, updatedAt);
  return staged.tool;
}

/** Roll back to the bundled baseline kit by removing `active.json`. */
export async function rollbackLocalmodelsUpdate(home: string): Promise<void> {
  await clearActiveToolRecord(home);
}
