export declare function resolveExternalPackageRoots(options?: {
  imports?: readonly string[];
  externals?: readonly string[];
  deployedDependencies?: readonly string[];
  runtimePackages?: readonly string[];
  optionalImports?: ReadonlySet<string>;
}): string[];

export declare function stageNodeNativeDepsForTarget(options: {
  repoRoot?: string;
  target: string;
  targetOutDir: string;
  imports?: readonly string[];
  lockfileText: string;
  runDeploy?: (args: {
    repoRoot: string;
    target: string;
    deployDir: string;
  }) => Promise<void>;
}): Promise<{
  target: string;
  outDir: string;
  packageCount: number;
  packages: { package: string; version: string }[];
  excluded: Record<string, string>;
  modelsManifest: { packages: Record<string, unknown> };
}>;

export declare function stageV2NodeNativeDeps(options?: {
  repoRoot?: string;
  outDir?: string;
  targets?: readonly string[];
  nodeServicesDir?: string | null;
  imports?: readonly string[] | null;
  importsJsonPath?: string | null;
  runDeploy?: (args: {
    repoRoot: string;
    target: string;
    deployDir: string;
  }) => Promise<void>;
}): Promise<{
  outDir: string;
  targets: {
    target: string;
    packageCount: number;
    excludedModels: string[];
  }[];
}>;
