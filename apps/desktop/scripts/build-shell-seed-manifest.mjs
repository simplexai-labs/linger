// Generates the lightweight (~1 KB) `dist/seed/seed-manifest.json` describing
// the Shell's built-in baseline bundles (mode: "shell-baseline") with zero
// duplicate `.tar.zst` archives.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  planBundleBuilds,
  resolveDbSchemaEpoch,
} from "./compute-bundle-inputs.mjs";

export { resolveDbSchemaEpoch };

const desktopDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const defaultRepoRoot = path.resolve(desktopDir, "../..");

export function buildShellSeedManifest({
  repoRoot = defaultRepoRoot,
  appVersion,
  channel = "stable",
  ref = "HEAD",
  useFs = false,
  lockfileText = null,
  dbSchemaEpoch = resolveDbSchemaEpoch(repoRoot),
} = {}) {
  if (!appVersion || typeof appVersion !== "string") {
    throw new Error("buildShellSeedManifest requires appVersion");
  }
  const plan = planBundleBuilds(repoRoot, {
    ref,
    useFs,
    lockfileText,
  });

  return {
    schema: 1,
    mode: "shell-baseline",
    appVersion,
    channel,
    compat: {
      minShellVersion: appVersion,
      minNativeDepsHash: plan.nativeDepsHash,
      runnerGatewayProtocol: 1,
      dbSchemaEpoch,
      rollbackSafe: true,
    },
    infra: {
      node: "bundled",
      postgres: "bundled",
      voiceTools: "bundled",
      nodeDeps: `infra/node-deps/${plan.nativeDepsShortId}`,
    },
    bundles: {
      web: {
        artifactId: "shell-baseline",
        inputHash: plan.bundles.web.inputHash,
      },
      backend: {
        artifactId: "shell-baseline",
        inputHash: plan.bundles.backend.inputHash,
      },
      "node-native-deps": {
        artifactId: "shell-baseline",
        inputHash: plan.nativeDepsHash,
      },
    },
  };
}

export async function writeShellSeedManifest({
  outFile = path.join(desktopDir, "dist", "seed", "seed-manifest.json"),
  ...options
} = {}) {
  const manifest = buildShellSeedManifest(options);
  await mkdir(path.dirname(outFile), { recursive: true });
  const payload = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(outFile, payload, "utf8");
  return { outFile, manifest, bytes: Buffer.byteLength(payload, "utf8") };
}
