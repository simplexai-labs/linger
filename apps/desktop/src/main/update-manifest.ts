import { createHash, createPublicKey, verify } from "node:crypto";

import { z } from "zod";

// The update feed has the layout of GitHub Releases: the newest stable
// release's manifest.json plus manifest.json.sig (an Ed25519 signature over
// the exact manifest bytes) at <feed>/latest/download/, and each package in
// the release of the version the signed manifest names, at
// <feed>/download/desktop-v<version>/. A prerelease never becomes the latest
// release, so it is never offered.
export const DEFAULT_FEED_URL =
  "https://github.com/simplexai-labs/linger/releases";
export const MANIFEST_FILE = "manifest.json";
export const SIGNATURE_FILE = "manifest.json.sig";
export const APP_MANIFEST_FILE = "app-manifest.json";
export const APP_SIGNATURE_FILE = "app-manifest.json.sig";

// Preview release key. The private half never leaves the release machine.
export const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA985QJ8UAvzK0ZLPW6YPaIkiCS2A+qPbEaZvi0aAccR4=
-----END PUBLIC KEY-----`;

const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HTTPS_URL = z
  .string()
  .url()
  .refine(
    (value) => {
      try {
        return new URL(value).protocol === "https:";
      } catch {
        return false;
      }
    },
    {
      message: "URL must use https",
    },
  );
// Safe feed-relative bundle path (e.g. `bundles/web/web-abc123.tar.zst`) so a
// single Ed25519-signed manifest stays verifiable across any HTTPS CDN, mirror,
// or local/LAN test feed host without re-signing.
const RELATIVE_BUNDLE_PATH = z
  .string()
  .regex(
    /^bundles\/[A-Za-z0-9._/-]+$/,
    "Relative bundle path must stay under bundles/",
  )
  .refine(
    (value) =>
      !value.includes("..") && !value.includes("//") && !value.endsWith("/"),
    { message: "Relative bundle path must be normalized and traversal-free" },
  );
const ARTIFACT_URL = z.union([HTTPS_URL, RELATIVE_BUNDLE_PATH]);

const updatePackage = z.object({
  // A bare file name: the package always comes from the manifest's release.
  file: z.string().regex(/^[A-Za-z0-9._-]+$/),
  sha256: z.string().regex(SHA256),
  size: z.number().int().positive(),
});
export type UpdatePackage = z.infer<typeof updatePackage>;

const updateManifest = z.object({
  schema: z.literal(2),
  version: z.string().regex(VERSION),
  // Keyed by `${platform}-${arch}`, e.g. darwin-arm64.
  packages: z.record(z.string(), updatePackage),
});
export type UpdateManifest = z.infer<typeof updateManifest>;

// ---------------------------------------------------------------------------
// Schema 3: V2 Dual-Track App Bundle + Shell Update Manifest
// ---------------------------------------------------------------------------

export const UPDATE_CHANNELS = ["stable", "beta", "canary"] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

export const PLATFORM_TARGETS = [
  "darwin-arm64",
  "win32-x64",
  "linux-x64",
] as const;
export type PlatformTarget = (typeof PLATFORM_TARGETS)[number];

export const BUNDLE_IDS = ["web", "backend", "node-native-deps"] as const;
export type BundleId = (typeof BUNDLE_IDS)[number];

const deltaPatchRef = z.object({
  fromSha256: z.string().regex(SHA256),
  fromArtifactId: z.string().regex(SAFE_ARTIFACT_ID),
  algorithm: z.literal("zstd-patch"),
  url: ARTIFACT_URL,
  mirrors: z.array(ARTIFACT_URL).optional(),
  sha256: z.string().regex(SHA256),
  size: z.number().int().positive(),
});
export type DeltaPatchRef = z.infer<typeof deltaPatchRef>;

const artifactRef = z.object({
  artifactId: z.string().regex(SAFE_ARTIFACT_ID),
  format: z.enum(["tar.zst", "tar.gz", "exe"]),
  url: ARTIFACT_URL,
  mirrors: z.array(ARTIFACT_URL).optional(),
  sha256: z.string().regex(SHA256),
  size: z.number().int().positive(),
  signed: z.enum(["developer-id", "authenticode", "none"]).optional(),
  deltas: z.array(deltaPatchRef).optional(),
});
export type ArtifactRef = z.infer<typeof artifactRef>;

const noarchBundleEntry = z.object({
  arch: z.literal("noarch"),
  originAppVersion: z.string().regex(VERSION),
  inputHash: z.string().regex(SHA256),
  nativeDepsHash: z.string().min(1).optional(),
  artifact: artifactRef,
});
export type NoarchBundleEntry = z.infer<typeof noarchBundleEntry>;

const platformBundleEntry = z.object({
  arch: z.literal("per-target"),
  originAppVersion: z.string().regex(VERSION),
  inputHash: z.string().regex(SHA256),
  nativeDepsHash: z.string().min(1).optional(),
  targets: z.record(z.string(), artifactRef),
});
export type PlatformBundleEntry = z.infer<typeof platformBundleEntry>;

const compatIndexEntry = z.object({
  maxShellVersion: z.string().regex(VERSION),
  appVersion: z.string().regex(VERSION),
  manifestUrl: HTTPS_URL,
  signatureUrl: HTTPS_URL,
});
export type CompatIndexEntry = z.infer<typeof compatIndexEntry>;

const shellPackageV3 = z.object({
  file: z.string().regex(/^[A-Za-z0-9._-]+$/),
  url: HTTPS_URL,
  mirrors: z.array(HTTPS_URL).optional(),
  sha256: z.string().regex(SHA256),
  size: z.number().int().positive(),
});

const appManifestV3 = z.object({
  schema: z.literal(3),
  channel: z.enum(UPDATE_CHANNELS),
  releaseId: z.string().min(1).max(128),
  appVersion: z.string().regex(VERSION),
  publishedAt: z.string().min(1),
  releaseNotesUrl: HTTPS_URL.optional(),
  rollout: z.object({
    percent: z.number().int().min(0).max(100),
    urgent: z.boolean().optional(),
  }),
  compat: z.object({
    minShellVersion: z.string().regex(VERSION),
    maxShellVersion: z.string().regex(VERSION).optional(),
    minNativeDepsHash: z.string().min(1),
    runnerGatewayProtocol: z.number().int().positive(),
    dbSchemaEpoch: z.number().int().nonnegative(),
    rollbackSafe: z.boolean(),
  }),
  compatIndex: z.array(compatIndexEntry).optional(),
  shell: z
    .object({
      version: z.string().regex(VERSION),
      packages: z.record(z.string(), shellPackageV3),
    })
    .optional(),
  bundles: z.object({
    web: noarchBundleEntry,
    backend: platformBundleEntry,
    "node-native-deps": platformBundleEntry,
  }),
});
export type AppManifestV3 = z.infer<typeof appManifestV3>;

export type VerifiedManifest =
  | { readonly kind: "v2"; readonly manifest: UpdateManifest }
  | { readonly kind: "v3"; readonly manifest: AppManifestV3 };

export type ShellCompatibility =
  | { readonly status: "compatible" }
  | {
      readonly status: "compat-fallback";
      readonly minShellVersion: string;
      readonly fallback: CompatIndexEntry;
    }
  | {
      readonly status: "shell-upgrade-required";
      readonly minShellVersion: string;
    };

export class ManifestError extends Error {}

export interface FeedUrls {
  readonly manifest: URL;
  readonly signature: URL;
}

const releases = (feed: string): string =>
  feed.endsWith("/") ? feed : `${feed}/`;

export function feedUrls(feed: string): FeedUrls {
  const latest = new URL("latest/download/", releases(feed));
  return {
    manifest: new URL(MANIFEST_FILE, latest),
    signature: new URL(SIGNATURE_FILE, latest),
  };
}

/**
 * Resolves channel-scoped V2 App Bundle feed URLs.
 * Supports both CDN layouts (`https://cdn.example.com/linger` -> `channels/<ch>/app-manifest.json`)
 * and GitHub Releases (`https://github.com/org/repo/releases` -> `download/channel-<ch>/app-manifest.json`).
 */
export function channelFeedUrls(
  feed: string,
  channel: UpdateChannel,
): FeedUrls {
  const base = releases(feed);
  const url = new URL(base);
  const isGithubReleases =
    url.hostname === "github.com" && /\/releases\/?$/.test(url.pathname);
  const dir = isGithubReleases
    ? new URL(`download/channel-${channel}/`, base)
    : new URL(`channels/${channel}/`, base);
  return {
    manifest: new URL(APP_MANIFEST_FILE, dir),
    signature: new URL(APP_SIGNATURE_FILE, dir),
  };
}

export function packageUrl(feed: string, version: string, file: string): URL {
  return new URL(`download/desktop-v${version}/${file}`, releases(feed));
}

/**
 * Resolves a Schema 3 artifact URL against `feed`. Absolute `https://` URLs are
 * kept verbatim; relative `bundles/...` paths resolve under the feed root.
 */
export function resolveArtifactUrl(feed: string, candidate: string): URL {
  if (/^https:\/\//i.test(candidate)) {
    return new URL(candidate);
  }
  return new URL(candidate, releases(feed));
}

// The release's page, where a person downloads the package themselves.
export function releasePageUrl(feed: string, version: string): string {
  return new URL(`tag/desktop-v${version}`, releases(feed)).toString();
}

function verifySignatureAndParseJson(
  bytes: Buffer,
  signature: string,
  publicKey: string,
): unknown {
  const valid = verify(
    null,
    bytes,
    createPublicKey(publicKey),
    Buffer.from(signature.trim(), "base64"),
  );
  if (!valid) throw new ManifestError("Update signature does not match");
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new ManifestError("Update manifest is not JSON");
  }
}

// Returns the manifest only when the signature matches the built-in key.
export function verifyManifest(
  bytes: Buffer,
  signature: string,
  publicKey: string = UPDATE_PUBLIC_KEY,
): UpdateManifest {
  const json = verifySignatureAndParseJson(bytes, signature, publicKey);
  const parsed = updateManifest.safeParse(json);
  if (!parsed.success) throw new ManifestError("Update manifest is invalid");
  return parsed.data;
}

export function verifyAppManifestV3(
  bytes: Buffer,
  signature: string,
  publicKey: string = UPDATE_PUBLIC_KEY,
): AppManifestV3 {
  const json = verifySignatureAndParseJson(bytes, signature, publicKey);
  const parsed = appManifestV3.safeParse(json);
  if (!parsed.success) {
    throw new ManifestError("App bundle manifest is invalid");
  }
  return parsed.data;
}

export function verifyAnyManifest(
  bytes: Buffer,
  signature: string,
  publicKey: string = UPDATE_PUBLIC_KEY,
): VerifiedManifest {
  const json = verifySignatureAndParseJson(bytes, signature, publicKey);
  const schema =
    json && typeof json === "object"
      ? (json as { schema?: unknown }).schema
      : undefined;
  if (schema === 3) {
    const parsed = appManifestV3.safeParse(json);
    if (!parsed.success) {
      throw new ManifestError("App bundle manifest is invalid");
    }
    return { kind: "v3", manifest: parsed.data };
  }
  const parsed = updateManifest.safeParse(json);
  if (!parsed.success) throw new ManifestError("Update manifest is invalid");
  return { kind: "v2", manifest: parsed.data };
}

/**
 * Deterministic 0..99 rollout bucketing based on a stable local installId.
 */
export function rolloutBucketFor(installId: string): number {
  const digest = createHash("sha256").update(installId).digest();
  // Use first 4 bytes unsigned integer mod 100 for uniform distribution.
  return digest.readUInt32BE(0) % 100;
}

export function isInRolloutBucket(
  installId: string,
  percent: number,
  urgent = false,
): boolean {
  if (urgent) return true;
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  return rolloutBucketFor(installId) < percent;
}

/**
 * Checks whether `shellVersion` satisfies `manifest.compat.minShellVersion`.
 * When the installed shell is too old, searches `compatIndex` for the highest
 * compatible fallback app version so older shells still receive security fixes.
 */
export function evaluateShellCompatibility(
  manifest: AppManifestV3,
  shellVersion: string,
): ShellCompatibility {
  const { minShellVersion, maxShellVersion } = manifest.compat;
  const meetsMin = compareVersions(shellVersion, minShellVersion) >= 0;
  const meetsMax =
    maxShellVersion === undefined ||
    compareVersions(shellVersion, maxShellVersion) <= 0;
  if (meetsMin && meetsMax) {
    return { status: "compatible" };
  }

  const candidates = (manifest.compatIndex ?? [])
    .filter(
      (entry) => compareVersions(shellVersion, entry.maxShellVersion) <= 0,
    )
    .sort((a, b) => compareVersions(b.appVersion, a.appVersion));

  if (candidates[0]) {
    return {
      status: "compat-fallback",
      minShellVersion,
      fallback: candidates[0],
    };
  }
  return { status: "shell-upgrade-required", minShellVersion };
}

// Positive when a is newer than b, by semantic version precedence: x.y.z
// numerically, then a prerelease (0.17.0-rc.1) before its release.
export function compareVersions(a: string, b: string): number {
  const [coreA, preA] = splitVersion(a);
  const [coreB, preB] = splitVersion(b);
  const pa = coreA.split(".").map(Number);
  const pb = coreB.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (preA === undefined || preB === undefined)
    return preA === preB ? 0 : preA === undefined ? 1 : -1;
  const ia = preA.split(".");
  const ib = preB.split(".");
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    const x = ia[i];
    const y = ib[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

const splitVersion = (version: string): [string, string | undefined] => {
  const dash = version.indexOf("-");
  return dash < 0
    ? [version, undefined]
    : [version.slice(0, dash), version.slice(dash + 1)];
};

export function packageFor(
  manifest: UpdateManifest,
  platform: string,
  arch: string,
): UpdatePackage | undefined {
  return manifest.packages[`${platform}-${arch}`];
}
