import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A module cache shared across files makes a later file's vi.mock ineffective
// once an earlier file imported the real module, so files that mock modules
// keep a fresh module graph. Detecting them from the source at config load
// means a new mocking file can never land in a shared project by omission.
const MODULE_MOCK_PATTERN = /\bvi\.(mock|doMock|resetModules)\(/;

export function usesModuleMocks(source: string): boolean {
  return MODULE_MOCK_PATTERN.test(source);
}

export interface TestFilePartition {
  isolated: string[];
  shared: string[];
}

export function partitionTestFiles(
  root: string,
  pattern: string,
): TestFilePartition {
  const isolated: string[] = [];
  const shared: string[] = [];
  for (const rawFile of globSync(pattern, { cwd: root }).sort()) {
    const file = rawFile.replaceAll("\\", "/");
    const source = readFileSync(join(root, file), "utf8");
    (usesModuleMocks(source) ? isolated : shared).push(file);
  }
  return { isolated, shared };
}
