// The browser and computer-control tools of the Local Computer dependency
// package, as the desktop app ships them too: under one bundle folder,
// cli/computer-tools/ with its frozen manifest.json and runtime/bin/node, the
// pinned Node.js they run on. apps/desktop stages them with
// stageComputerToolBundle and its packaging (packaging/computer_tools.py)
// checks them with this script:
//
//   node scripts/computer-tool-bundle.mjs verify <bundle> <target>
//   node scripts/computer-tool-bundle.mjs record-signed <bundle> [<kept asset>...]
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  stageComputerTools,
  validatedComputerToolAssets,
} from "../apps/computer/scripts/bundle-computer-tools.mjs";
import { stagePinnedNodeRuntime } from "./prepare-local-computer-release.mjs";

export {
  COMPUTER_TOOL_VERSIONS,
  CUA_ARCHIVES,
  QUICKJS_TOOL_ASSETS,
  piRuntimeEntry,
} from "../apps/computer/scripts/bundle-computer-tools.mjs";
export { NODE_RUNTIME_RELEASES } from "./local-computer-node-distributions.mjs";

const windows = (target) => target.startsWith("win32-");

export const nodeRuntimeEntry = (target) =>
  `runtime/bin/node${windows(target) ? ".exe" : ""}`;

// The manifest's files and an executable Node.js; returns the files.
export const validatedComputerToolBundle = async (bundle, target) => {
  const entries = await validatedComputerToolAssets(bundle, target);
  const node = await stat(path.join(bundle, nodeRuntimeEntry(target))).catch(
    () => null,
  );
  if (!node?.isFile() || (!windows(target) && !(node.mode & 0o111)))
    throw new Error(
      `The Node.js runtime for ${target} is missing or not executable`,
    );
  return entries;
};

export const stageComputerToolBundle = async (bundle, target) => {
  await stagePinnedNodeRuntime(bundle, target);
  await stageComputerTools(bundle, { target });
  return await validatedComputerToolBundle(bundle, target);
};

const MACHO = new Set(["cffaedfe", "cafebabe"]);
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

// macOS code signing rewrites the tools' Mach-O files. This records their new
// size and sha256; any other change still fails the validation that follows.
// Kept assets were put back as their vendor signed them and must match as
// before.
export const recordSignedComputerTools = async (bundle, kept = []) => {
  const root = path.join(bundle, "cli/computer-tools");
  const file = path.join(root, "manifest.json");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  for (const asset of manifest.assets) {
    if (kept.includes(asset.path)) continue;
    const data = await readFile(path.join(root, asset.path)).catch(() => null);
    if (!data || !MACHO.has(data.subarray(0, 4).toString("hex"))) continue;
    asset.size_bytes = data.length;
    asset.sha256 = sha256(data);
  }
  manifest.artifact_sha256 = sha256(JSON.stringify(manifest.assets));
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
};

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const [command, bundle, ...rest] = process.argv.slice(2);
  try {
    if (command === "verify" && bundle && rest.length === 1)
      await validatedComputerToolBundle(bundle, rest[0]);
    else if (command === "record-signed" && bundle)
      await recordSignedComputerTools(bundle, rest);
    else
      throw new Error(
        "usage: computer-tool-bundle.mjs verify <bundle> <target> | record-signed <bundle> [<kept asset>...]",
      );
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
