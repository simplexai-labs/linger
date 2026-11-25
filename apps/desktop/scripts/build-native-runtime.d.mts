export const RUNTIME_ARCHIVE: string;
export const RUNTIME_FILES: string;
export const RUNTIME_SCHEMA: number;

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
): Promise<Record<string, unknown>>;
