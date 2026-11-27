import { createPublicKey, verify } from "node:crypto";

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

// Preview release key. The private half never leaves the release machine.
export const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA985QJ8UAvzK0ZLPW6YPaIkiCS2A+qPbEaZvi0aAccR4=
-----END PUBLIC KEY-----`;

const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

const updatePackage = z.object({
  // A bare file name: the package always comes from the manifest's release.
  file: z.string().regex(/^[A-Za-z0-9._-]+$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().positive(),
});
export type UpdatePackage = z.infer<typeof updatePackage>;

const updateManifest = z.object({
  schema: z.literal(2),
  version: z.string().regex(VERSION),
  // Keyed by `${platform}-${arch}` (e.g. darwin-arm64) or
  // `${platform}-${arch}-archive` (e.g. win32-x64-archive).
  packages: z.record(z.string(), updatePackage),
});
export type UpdateManifest = z.infer<typeof updateManifest>;

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

export function packageUrl(feed: string, version: string, file: string): URL {
  return new URL(`download/desktop-v${version}/${file}`, releases(feed));
}

// The release's page, where a person downloads the package themselves.
export function releasePageUrl(feed: string, version: string): string {
  return new URL(`tag/desktop-v${version}`, releases(feed)).toString();
}

// Returns the manifest only when the signature matches the built-in key.
export function verifyManifest(
  bytes: Buffer,
  signature: string,
  publicKey: string = UPDATE_PUBLIC_KEY,
): UpdateManifest {
  const valid = verify(
    null,
    bytes,
    createPublicKey(publicKey),
    Buffer.from(signature.trim(), "base64"),
  );
  if (!valid) throw new ManifestError("Update signature does not match");
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ManifestError("Update manifest is not JSON");
  }
  const parsed = updateManifest.safeParse(json);
  if (!parsed.success) throw new ManifestError("Update manifest is invalid");
  return parsed.data;
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

export function archivePackageFor(
  manifest: UpdateManifest,
  platform: string,
  arch: string,
): UpdatePackage | undefined {
  return manifest.packages[`${platform}-${arch}-archive`];
}
