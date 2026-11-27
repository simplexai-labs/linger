export interface ShellSeedManifestBundleEntry {
  readonly artifactId: string;
  readonly inputHash: string;
}

export interface ShellSeedManifest {
  readonly schema: 1;
  readonly mode: "shell-baseline";
  readonly appVersion: string;
  readonly channel: "stable" | "beta" | "canary";
  readonly compat: {
    readonly minShellVersion: string;
    readonly minNativeDepsHash: string;
    readonly runnerGatewayProtocol: number;
    readonly dbSchemaEpoch: number;
    readonly rollbackSafe: boolean;
  };
  readonly infra: {
    readonly node: string;
    readonly postgres: string;
    readonly voiceTools: string;
    readonly nodeDeps: string;
  };
  readonly bundles: {
    readonly web: ShellSeedManifestBundleEntry;
    readonly backend: ShellSeedManifestBundleEntry;
    readonly "node-native-deps": ShellSeedManifestBundleEntry;
  };
}

export interface BuildShellSeedManifestOptions {
  readonly repoRoot?: string;
  readonly appVersion: string;
  readonly channel?: "stable" | "beta" | "canary";
  readonly ref?: string;
  readonly useFs?: boolean;
  readonly lockfileText?: string | null;
  readonly dbSchemaEpoch?: number;
}

export function buildShellSeedManifest(
  options: BuildShellSeedManifestOptions,
): ShellSeedManifest;

export function writeShellSeedManifest(
  options: BuildShellSeedManifestOptions & { readonly outFile?: string },
): Promise<{
  readonly outFile: string;
  readonly manifest: ShellSeedManifest;
  readonly bytes: number;
}>;
