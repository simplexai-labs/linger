export const COMPUTER_TOOL_VERSIONS: Readonly<Record<string, string>>;
export const QUICKJS_TOOL_ASSETS: readonly string[];
export const CUA_ARCHIVES: Readonly<
  Record<string, { readonly entry: string; readonly required: string[] }>
>;
export const NODE_RUNTIME_RELEASES: Readonly<
  Record<string, { readonly archive: string; readonly sha256: string }>
>;
export function nodeRuntimeEntry(target: string): string;
export function piRuntimeEntry(target: string): string;
export function validatedComputerToolBundle(
  bundle: string,
  target: string,
): Promise<string[]>;
export function stageComputerToolBundle(
  bundle: string,
  target: string,
): Promise<string[]>;
export function recordSignedComputerTools(
  bundle: string,
  kept?: readonly string[],
): Promise<void>;
