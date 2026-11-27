import { generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_FEED_URL,
  ManifestError,
  archivePackageFor,
  compareVersions,
  feedUrls,
  packageFor,
  packageUrl,
  releasePageUrl,
  verifyManifest,
} from "./update-manifest.js";

const keys = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
};

const manifest = {
  schema: 2,
  version: "0.16.1",
  packages: {
    "darwin-arm64": {
      file: "Linger-0.16.1-arm64.tar.gz",
      sha256: "a".repeat(64),
      size: 10,
    },
  },
};

const signed = (value: unknown, privateKey = keys().privateKey) => {
  const bytes = Buffer.from(JSON.stringify(value));
  return { bytes, signature: sign(null, bytes, privateKey).toString("base64") };
};

describe("update manifest", () => {
  it("accepts a manifest signed by the release key", () => {
    const { privateKey, publicPem } = keys();
    const { bytes, signature } = signed(manifest, privateKey);
    const parsed = verifyManifest(bytes, signature, publicPem);
    expect(packageFor(parsed, "darwin", "arm64")?.file).toBe(
      "Linger-0.16.1-arm64.tar.gz",
    );
    expect(packageFor(parsed, "darwin", "x64")).toBeUndefined();
    expect(archivePackageFor(parsed, "win32", "x64")).toBeUndefined();
  });

  it("resolves archivePackageFor independently from packageFor", () => {
    const { privateKey, publicPem } = keys();
    const withArchive = {
      schema: 2,
      version: "0.17.0",
      packages: {
        "win32-x64": {
          file: "Linger-0.17.0-windows-x64-setup.exe",
          sha256: "a".repeat(64),
          size: 100,
        },
        "win32-x64-archive": {
          file: "Linger-0.17.0-windows-x64-portable.zip",
          sha256: "b".repeat(64),
          size: 200,
        },
      },
    };
    const { bytes, signature } = signed(withArchive, privateKey);
    const parsed = verifyManifest(bytes, signature, publicPem);
    expect(packageFor(parsed, "win32", "x64")).toEqual({
      file: "Linger-0.17.0-windows-x64-setup.exe",
      sha256: "a".repeat(64),
      size: 100,
    });
    expect(archivePackageFor(parsed, "win32", "x64")).toEqual({
      file: "Linger-0.17.0-windows-x64-portable.zip",
      sha256: "b".repeat(64),
      size: 200,
    });
    expect(archivePackageFor(parsed, "darwin", "arm64")).toBeUndefined();
  });

  it("rejects tampered bytes and other keys", () => {
    const { privateKey, publicPem } = keys();
    const { bytes, signature } = signed(manifest, privateKey);
    const tampered = Buffer.from(bytes.toString().replace("0.16.1", "9.9.9"));
    expect(() => verifyManifest(tampered, signature, publicPem)).toThrow(
      ManifestError,
    );
    const other = signed(manifest);
    expect(() =>
      verifyManifest(other.bytes, other.signature, publicPem),
    ).toThrow(ManifestError);
  });

  it("rejects the manifest of another schema", () => {
    const { privateKey, publicPem } = keys();
    const { bytes, signature } = signed({ ...manifest, schema: 1 }, privateKey);
    expect(() => verifyManifest(bytes, signature, publicPem)).toThrow(
      "Update manifest is invalid",
    );
  });

  it("rejects package paths outside the release", () => {
    const { privateKey, publicPem } = keys();
    const bad = structuredClone(manifest);
    bad.packages["darwin-arm64"].file = "../Linger.tar.gz";
    const { bytes, signature } = signed(bad, privateKey);
    expect(() => verifyManifest(bytes, signature, publicPem)).toThrow(
      "Update manifest is invalid",
    );
  });

  it("compares versions numerically", () => {
    expect(compareVersions("0.16.10", "0.16.9")).toBeGreaterThan(0);
    expect(compareVersions("0.16.0", "0.16.0")).toBe(0);
    expect(compareVersions("0.15.9", "0.16.0")).toBeLessThan(0);
  });

  it("orders a prerelease before its release", () => {
    expect(compareVersions("0.17.0", "0.17.0-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("0.17.0-rc.1", "0.16.9")).toBeGreaterThan(0);
    expect(compareVersions("0.17.0-rc.10", "0.17.0-rc.9")).toBeGreaterThan(0);
    expect(compareVersions("0.17.0-rc.1", "0.17.0-rc.1.1")).toBeLessThan(0);
    expect(compareVersions("0.17.0-alpha", "0.17.0-beta")).toBeLessThan(0);
    expect(compareVersions("0.17.0-1", "0.17.0-alpha")).toBeLessThan(0);
    expect(compareVersions("0.17.0-rc.1", "0.17.0-rc.1")).toBe(0);
  });

  it("finds the manifest in the latest release and packages in its own", () => {
    expect(feedUrls(DEFAULT_FEED_URL)).toEqual({
      manifest: new URL(
        "https://github.com/simplexai-labs/linger/releases/latest/download/manifest.json",
      ),
      signature: new URL(
        "https://github.com/simplexai-labs/linger/releases/latest/download/manifest.json.sig",
      ),
    });
    expect(
      packageUrl(
        "https://releases.example.com/linger/",
        "0.17.0",
        "Linger-0.17.0-windows-x64-setup.exe",
      ).toString(),
    ).toBe(
      "https://releases.example.com/linger/download/desktop-v0.17.0/Linger-0.17.0-windows-x64-setup.exe",
    );
    expect(releasePageUrl(DEFAULT_FEED_URL, "0.17.0")).toBe(
      "https://github.com/simplexai-labs/linger/releases/tag/desktop-v0.17.0",
    );
  });
});
