import { generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ManifestError,
  channelFeedUrls,
  evaluateShellCompatibility,
  isInRolloutBucket,
  rolloutBucketFor,
  verifyAnyManifest,
  verifyAppManifestV3,
  type AppManifestV3,
} from "./update-manifest.js";

function makeKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function makeArtifact(id: string) {
  return {
    artifactId: `${id}-a1b2c3d4e5f6`,
    format: "tar.zst" as const,
    url: `https://cdn.example.com/linger/bundles/${id}/${id}-a1b2c3d4e5f6.tar.zst`,
    sha256: "a".repeat(64),
    size: 4096,
  };
}

function makeManifestV3(overrides: Partial<AppManifestV3> = {}): AppManifestV3 {
  return {
    schema: 3,
    channel: "stable",
    releaseId: "2026.11.24.01",
    appVersion: "0.3.0",
    publishedAt: "2026-11-24T12:00:00Z",
    rollout: { percent: 100 },
    compat: {
      minShellVersion: "0.3.0",
      minNativeDepsHash: `sha256:${"b".repeat(64)}`,
      runnerGatewayProtocol: 1,
      dbSchemaEpoch: 892,
      rollbackSafe: true,
    },
    compatIndex: [
      {
        maxShellVersion: "0.2.99",
        appVersion: "0.2.18",
        manifestUrl:
          "https://cdn.example.com/linger/releases/app-v0.2.18/app-manifest.json",
        signatureUrl:
          "https://cdn.example.com/linger/releases/app-v0.2.18/app-manifest.json.sig",
      },
      {
        maxShellVersion: "0.2.99",
        appVersion: "0.2.15",
        manifestUrl:
          "https://cdn.example.com/linger/releases/app-v0.2.15/app-manifest.json",
        signatureUrl:
          "https://cdn.example.com/linger/releases/app-v0.2.15/app-manifest.json.sig",
      },
    ],
    bundles: {
      web: {
        arch: "noarch",
        originAppVersion: "0.3.0",
        inputHash: "1".repeat(64),
        artifact: makeArtifact("web"),
      },
      backend: {
        arch: "per-target",
        originAppVersion: "0.3.0",
        inputHash: "2".repeat(64),
        nativeDepsHash: `sha256:${"b".repeat(64)}`,
        targets: { "darwin-arm64": makeArtifact("backend") },
      },
      "node-native-deps": {
        arch: "per-target",
        originAppVersion: "0.2.0",
        inputHash: "3".repeat(64),
        targets: { "darwin-arm64": makeArtifact("node-native-deps") },
      },
    },
    ...overrides,
  };
}

describe("Schema 3 update manifest & compatibility gates", () => {
  it("verifies signed Schema 3 manifest and rejects tampered bytes or non-https URLs", () => {
    const { privateKey, publicPem } = makeKeys();
    const manifest = makeManifestV3();
    const bytes = Buffer.from(JSON.stringify(manifest));
    const sig = sign(null, bytes, privateKey).toString("base64");

    const parsed = verifyAppManifestV3(bytes, sig, publicPem);
    expect(parsed.appVersion).toBe("0.3.0");
    expect(verifyAnyManifest(bytes, sig, publicPem).kind).toBe("v3");

    const tampered = Buffer.from(bytes.toString().replace("0.3.0", "9.9.9"));
    expect(() => verifyAppManifestV3(tampered, sig, publicPem)).toThrow(
      ManifestError,
    );

    const insecure = makeManifestV3();
    insecure.bundles.web.artifact.url = "http://cdn.example.com/web.tar.zst";
    const insecureBytes = Buffer.from(JSON.stringify(insecure));
    const insecureSig = sign(null, insecureBytes, privateKey).toString(
      "base64",
    );
    expect(() =>
      verifyAppManifestV3(insecureBytes, insecureSig, publicPem),
    ).toThrow(ManifestError);
  });

  it("resolves channel feed URLs for both CDN and GitHub Releases feeds", () => {
    const cdn = channelFeedUrls("https://cdn.example.com/linger", "canary");
    expect(cdn.manifest.toString()).toBe(
      "https://cdn.example.com/linger/channels/canary/app-manifest.json",
    );
    const gh = channelFeedUrls(
      "https://github.com/simplexai-labs/linger/releases",
      "stable",
    );
    expect(gh.manifest.toString()).toBe(
      "https://github.com/simplexai-labs/linger/releases/download/channel-stable/app-manifest.json",
    );
  });

  it("evaluates minShellVersion and picks highest matching compatIndex fallback for older shells", () => {
    const manifest = makeManifestV3();
    expect(evaluateShellCompatibility(manifest, "0.3.0")).toEqual({
      status: "compatible",
    });

    const fallback = evaluateShellCompatibility(manifest, "0.2.5");
    expect(fallback.status).toBe("compat-fallback");
    if (fallback.status === "compat-fallback") {
      expect(fallback.fallback.appVersion).toBe("0.2.18");
    }

    const noIndex = makeManifestV3({ compatIndex: [] });
    expect(evaluateShellCompatibility(noIndex, "0.2.5")).toEqual({
      status: "shell-upgrade-required",
      minShellVersion: "0.3.0",
    });
  });

  it("buckets rollout deterministically by installId and honors urgent override", () => {
    const bucket = rolloutBucketFor("install-uuid-12345");
    expect(bucket).toBeGreaterThanOrEqual(0);
    expect(bucket).toBeLessThan(100);
    expect(isInRolloutBucket("install-uuid-12345", 0)).toBe(false);
    expect(isInRolloutBucket("install-uuid-12345", 100)).toBe(true);
    expect(isInRolloutBucket("install-uuid-12345", bucket + 1)).toBe(true);
    expect(isInRolloutBucket("install-uuid-12345", bucket)).toBe(false);
    expect(isInRolloutBucket("install-uuid-12345", 0, true)).toBe(true);
  });
});
