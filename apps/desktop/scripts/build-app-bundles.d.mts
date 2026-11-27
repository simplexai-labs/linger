import type { BundleBuildPlan } from "./compute-bundle-inputs.mjs";

export interface PackedTarZst {
  readonly fileName: string;
  readonly filePath: string;
  readonly artifactId: string;
  readonly sha256: string;
  readonly size: number;
}

export declare function sha256File(filePath: string): Promise<string>;

export declare function packDeterministicTarZst(
  sourceDir: string,
  outDir: string,
  bundleId: string,
  suffix?: string,
): Promise<PackedTarZst>;

export declare function packageBackendBundle(options: {
  target: string;
  outDir: string;
  teamhubDir?: string | null;
  nodeServicesDir?: string | null;
  skillsDir?: string | null;
  computerDaemonDir?: string | null;
  installerDir?: string | null;
}): Promise<PackedTarZst>;

export interface AssembledBundleManifest {
  readonly schema: 3;
  readonly channel: "stable" | "beta" | "canary";
  readonly releaseId: string;
  readonly appVersion: string;
  readonly publishedAt: string;
  readonly rollout: { readonly percent: number; readonly urgent?: boolean };
  readonly compat: Record<string, unknown>;
  readonly bundles: {
    readonly web: {
      readonly originAppVersion: string;
      readonly artifact: {
        readonly artifactId: string;
        readonly url: string;
        readonly mirrors?: readonly string[];
        readonly sha256: string;
        readonly size: number;
      };
      readonly [key: string]: unknown;
    };
    readonly backend: {
      readonly originAppVersion: string;
      readonly targets: Record<
        string,
        {
          readonly artifactId: string;
          readonly url: string;
          readonly mirrors?: readonly string[];
          readonly sha256: string;
          readonly size: number;
        }
      >;
      readonly [key: string]: unknown;
    };
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

export declare function assembleManifestV3(options: {
  appVersion: string;
  channel?: "stable" | "beta" | "canary";
  releaseId?: string;
  publishedAt?: string;
  rollout?: { percent: number; urgent?: boolean };
  compat?: {
    minShellVersion?: string;
    maxShellVersion?: string;
    minNativeDepsHash?: string;
    runnerGatewayProtocol?: number;
    dbSchemaEpoch?: number;
    rollbackSafe?: boolean;
  };
  compatIndex?: unknown[];
  shell?: unknown;
  plan: BundleBuildPlan;
  builtArtifacts?: Record<string, unknown>;
  prevManifest?: unknown;
  baseUrl: string;
  mirrorBaseUrls?: readonly string[];
}): AssembledBundleManifest;

export declare function signManifestV3(
  manifest: unknown,
  privateKeyPem: string,
  expectedPublicKeyPem?: string | null,
): {
  readonly bytes: Buffer;
  readonly signatureBase64: string;
};

export declare function writeSignedManifestV3(
  outDir: string,
  manifest: unknown,
  options?: {
    privateKeyPem?: string | null;
    expectedPublicKeyPem?: string | null;
  },
): Promise<{
  readonly manifestPath: string;
  readonly signaturePath: string | null;
}>;
