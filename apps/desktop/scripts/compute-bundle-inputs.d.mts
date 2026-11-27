export declare const BUNDLE_IDS: readonly [
  "web",
  "backend",
  "node-native-deps",
];

export declare const PLATFORM_TARGETS: readonly [
  "darwin-arm64",
  "win32-x64",
  "linux-x64",
];

export interface NativeDepsHashResult {
  readonly hash: string;
  readonly shortId: string;
  readonly packageCount: number;
  readonly packages: readonly {
    readonly name: string;
    readonly version: string;
    readonly integrity: string;
  }[];
}

export declare function computeNativeDepsHash(
  lockfileText: string,
  options?: {
    target?: string;
    nodeMajor?: string;
    externals?: readonly string[];
    runtimePackages?: readonly string[];
    extraSalts?: readonly string[];
  },
): NativeDepsHashResult;

export interface BundleInputHashResult {
  readonly bundleId: string;
  readonly arch: "noarch" | "per-target";
  readonly inputHash: string;
  readonly fileCount: number;
  readonly nativeDepsHash?: string;
  readonly nativeDepsShortId?: string;
}

export declare function computeBundleInputHash(
  repoRoot: string,
  bundleId: string,
  options?: {
    ref?: string | null;
    target?: string | null;
    toolchain?: Record<string, string>;
    lockfileText?: string | null;
    useFs?: boolean;
  },
): BundleInputHashResult;

export interface BundlePlanEntry {
  readonly bundleId: string;
  readonly arch: "noarch" | "per-target";
  readonly action: "BUILD" | "REUSED";
  readonly inputHash: string;
  readonly fileCount: number;
  readonly nativeDepsHash?: string;
  readonly nativeDepsShortId?: string;
  readonly inherited?: unknown;
}

export interface BundleBuildPlan {
  readonly schema: 1;
  readonly ref: string;
  readonly nativeDepsHash: string;
  readonly nativeDepsShortId: string;
  readonly bundles: Record<string, BundlePlanEntry>;
  readonly toBuild: string[];
  readonly reused: string[];
}

export declare function resolveDbSchemaEpoch(
  repoRoot?: string,
  fallback?: number,
): number;

export declare function planBundleBuilds(
  repoRoot: string,
  options?: {
    ref?: string;
    useFs?: boolean;
    targets?: readonly string[];
    prevManifest?: unknown;
    toolchain?: Record<string, string>;
    lockfileText?: string | null;
  },
): BundleBuildPlan;
