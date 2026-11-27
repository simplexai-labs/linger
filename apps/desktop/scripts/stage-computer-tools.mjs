// Stages the browser and computer-control tools the Go daemon loads, per
// target, into dist/computer-tools/<target>/: cli/computer-tools/ with its
// frozen manifest.json and runtime/bin/node, the pinned Node.js they run on.
// scripts/computer-tool-bundle.mjs builds them with the same code and from the
// same pins (Node.js and Cua archive checksums, the frozen pnpm lockfile) as
// the Local Computer dependency package.
//
// The daemon looks for them two folders above its executable
// (localtools.Installed): packaging puts them next to resources/computer/
// (packaging/computer_tools.py). From source, dist/computer/ links to this
// machine's tools, so `pnpm start` runs with them too.
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  NODE_RUNTIME_RELEASES,
  stageComputerToolBundle,
  validatedComputerToolBundle,
} from "../../../scripts/computer-tool-bundle.mjs";

const desktop = fileURLToPath(new URL("../", import.meta.url));

export const computerToolsDirectory = (
  target,
  dist = path.join(desktop, "dist"),
) => path.join(dist, "computer-tools", target);

export const stageDesktopComputerTools = async (
  targets,
  {
    dist = path.join(desktop, "dist"),
    host = `${process.platform}-${process.arch}`,
    stage = stageComputerToolBundle,
    validate = validatedComputerToolBundle,
    nodeReleases = NODE_RUNTIME_RELEASES,
  } = {},
) => {
  const useSharedNode = process.env.LINGER_SHARED_NODE_RUNTIME === "1";
  // One target at a time: the darwin targets share one cached Cua archive.
  for (const target of targets) {
    const bundle = computerToolsDirectory(target, dist);
    // A source build keeps tools that still match the frozen manifest and the
    // pinned Node.js, recorded beside them, so `pnpm start` needs no download;
    // release builds start from an empty dist/.
    const node = JSON.stringify(
      useSharedNode ? { shared: true } : (nodeReleases[target] ?? null),
    );
    const pinned = `${bundle}.node.json`;
    const kept =
      (await readFile(pinned, "utf8").catch(() => null)) === node &&
      (await validate(bundle, target).catch(() => null));
    if (kept) {
      console.log(`Computer tools for ${target}: ${kept.length} files, kept`);
      continue;
    }
    await rm(pinned, { force: true });
    await rm(bundle, { recursive: true, force: true });
    await mkdir(bundle, { recursive: true });
    const entries = await stage(bundle, target);
    if (useSharedNode) {
      // V2 unified Node 26: remove the duplicate runtime copy; the daemon gets
      // LINGER_TOOLS_NODE_PATH pointing to the shared infra/node binary.
      await rm(path.join(bundle, "runtime"), { recursive: true, force: true });
    }
    await writeFile(pinned, node);
    console.log(
      `Computer tools for ${target}: ${entries.length} files${useSharedNode ? " (shared Node 26)" : ""}`,
    );
  }
  if (targets.includes(host)) {
    const computer = path.join(dist, "computer");
    await mkdir(computer, { recursive: true });
    for (const name of ["cli", "runtime"]) {
      await rm(path.join(computer, name), { recursive: true, force: true });
      await symlink(
        path.join(computerToolsDirectory(host, dist), name),
        path.join(computer, name),
        "junction",
      );
    }
  }
};
