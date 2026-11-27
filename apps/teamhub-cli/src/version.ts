import { readFile } from "node:fs/promises";

import cliPackage from "../package.json" with { type: "json" };

export async function versionText(assetManifest?: URL): Promise<string> {
  let fingerprint = "unavailable";
  if (assetManifest) {
    try {
      const manifest = JSON.parse(await readFile(assetManifest, "utf8")) as {
        artifact_sha256?: unknown;
      } | null;
      const digest = manifest?.artifact_sha256;
      if (typeof digest === "string" && /^[0-9a-f]{64}$/u.test(digest))
        fingerprint = digest;
    } catch {
      // Source runs and incomplete installs can still report the CLI version.
    }
  }
  return `teamhub ${cliPackage.version}\nBuild fingerprint: ${fingerprint}\n`;
}
