import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { buildTeamhubLauncher } from "../../scripts/build-daemon.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

it(
  "cross-compiles the Windows teamhub.exe launcher for win32-x64",
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "build-daemon-launcher-"));
    roots.push(root);
    const outputPath = path.join(root, "teamhub.exe");

    await buildTeamhubLauncher("win32-x64", outputPath);

    expect(existsSync(outputPath)).toBe(true);
    expect(statSync(outputPath).size).toBeGreaterThan(0);
    const header = readFileSync(outputPath).subarray(0, 2).toString("ascii");
    expect(header).toBe("MZ");
  },
  process.platform === "win32" ? 60_000 : 30_000,
);

it("rejects an unknown target in buildTeamhubLauncher", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "build-daemon-launcher-"));
  roots.push(root);
  const outputPath = path.join(root, "teamhub.exe");

  await expect(
    buildTeamhubLauncher("unknown-target", outputPath),
  ).rejects.toThrow("Unknown daemon target unknown-target");
  expect(existsSync(outputPath)).toBe(false);
});
