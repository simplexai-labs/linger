export interface StepDefinition {
  readonly id: string;
  readonly changedModules: readonly string[];
  readonly updateBehavior: string;
  readonly rollbackSafe: boolean;
  readonly dbSchemaEpoch: number;
}

export declare const STEP_DEFINITIONS: readonly StepDefinition[];

export declare function deriveStepVersions(
  baseVersion?: string,
): Record<string, string>;

export interface BuildV2TestUpgradePacksOptions {
  repoRoot?: string;
  outDir: string;
  baseVersion?: string;
  channel?: "stable" | "beta" | "canary";
  baseUrl?: string;
  targets?: readonly string[];
  privateKeyPem?: string | null;
  expectedPublicKeyPem?: string | null;
  ephemeralTestKey?: boolean;
  webDistDir?: string | null;
  installerDistDir?: string | null;
  nodeServicesDir?: string | null;
  nodeNativeDepsDir?: string | null;
  teamhubDir?: string | null;
  teamhubV2Dir?: string | null;
  teamhubFaultyDir?: string | null;
  daemonDir?: string | null;
  daemonV2Dir?: string | null;
  teamhubCliDir?: string | null;
  macosSigned?: boolean;
  windowsSigned?: boolean;
  minShellVersion?: string | null;
}

export declare function buildV2TestUpgradePacks(
  options: BuildV2TestUpgradePacksOptions,
): Promise<{
  outDir: string;
  index: {
    schema: number;
    baseVersion: string;
    channel: string;
    baseUrl: string;
    targets: string[];
    signedWith: string;
    macosSigned: boolean;
    windowsSigned: boolean;
    steps: Array<{
      id: string;
      appVersion: string;
      changedModules: string[];
      inheritedModules: string[];
      rollbackSafe: boolean;
      dbSchemaEpoch: number;
      updateBehavior: string;
      signed: boolean;
    }>;
  };
  verification: {
    ok: boolean;
    stepCount: number;
    steps: Array<{
      id: string;
      appVersion: string;
      changedModules: string[];
      rollbackSafe: boolean;
      signatureVerified: boolean;
    }>;
  };
}>;

export declare function verifyV2TestUpgradeKit(
  kitDir: string,
  options?: { publicKeyPem?: string | null; requireSignatures?: boolean },
): Promise<{
  ok: boolean;
  stepCount: number;
  steps: Array<{
    id: string;
    appVersion: string;
    changedModules: string[];
    rollbackSafe: boolean;
    signatureVerified: boolean;
  }>;
}>;
