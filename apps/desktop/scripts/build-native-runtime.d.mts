export const RUNTIME_ARCHIVE: string;
export const RUNTIME_FILES: string;
export const RUNTIME_SCHEMA: number;

export interface RuntimeArtifact {
  file: string;
  sha256: string;
  bytes: number;
}
export interface RuntimeNodeArtifact {
  version: string;
  shared?: boolean;
  binary?: string;
  file?: string;
  sha256: string;
  bytes: number;
}
export interface RuntimeManifest {
  schema: number;
  target: string;
  sourceCommit: string;
  sourceArchiveSha256: string;
  layout: "archive" | "directory";
  archive?: RuntimeArtifact;
  directory?: RuntimeArtifact;
  node: RuntimeNodeArtifact;
}
export interface BuildRuntimeOptions {
  shippedArchive?: string;
}
export function copyExternals(
  deployed: string,
  output: string,
  roots: string[],
  exclude?: (name: string) => unknown,
): Promise<{
  packages: { package: string; version: string }[];
  excluded: Record<string, string>;
}>;
export function verifyRuntime(
  directory: string,
  target: string,
  sourceArchiveSha256: string,
): Promise<RuntimeManifest>;
export function buildRuntime(
  target: string,
  archive: string,
  output?: string,
  options?: BuildRuntimeOptions,
): Promise<RuntimeManifest>;
