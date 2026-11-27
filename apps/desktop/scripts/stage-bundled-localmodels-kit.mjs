// Stages an optional pre-built localmodels kit archive beside distribution.json
// when LINGER_BUNDLED_LOCALMODELS_KIT_DIR is set, failing closed on missing,
// linked, non-regular, or mismatched archives and removing any stale copy when
// unset so official builds never embed a kit archive.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";

export const BUNDLED_LOCALMODELS_KIT_FILENAME = "bundled-localmodels-kit.tgz";

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function stageBundledLocalmodelsKit({
  kitDir,
  distribution,
  installerDir,
}) {
  const destination = path.join(installerDir, BUNDLED_LOCALMODELS_KIT_FILENAME);
  await rm(destination, { force: true });

  const resolvedKitDir = kitDir?.trim();
  if (!resolvedKitDir) return null;

  const tool = distribution?.localmodelsTool;
  if (
    !distribution ||
    typeof distribution.platform !== "string" ||
    typeof distribution.arch !== "string" ||
    !tool ||
    typeof tool.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(tool.sha256) ||
    !Number.isSafeInteger(tool.bytes) ||
    tool.bytes <= 0
  ) {
    throw new Error(
      "LINGER_BUNDLED_LOCALMODELS_KIT_DIR requires a resolved distribution.json with localmodelsTool sha256 and bytes",
    );
  }

  const target = `${distribution.platform}-${distribution.arch}`;
  const source = path.join(resolvedKitDir, `${target}.tgz`);
  let info;
  try {
    info = await lstat(source);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      throw new Error(
        `LINGER_BUNDLED_LOCALMODELS_KIT_DIR is set, but ${source} does not exist`,
        { cause: error },
      );
    }
    throw error;
  }

  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(
      `Bundled localmodels kit must be a regular non-symlink file: ${source}`,
    );
  }

  if (info.size !== tool.bytes) {
    throw new Error(
      `${source} size mismatch for ${target}: expected ${tool.bytes} bytes, got ${info.size}`,
    );
  }

  const actualSha256 = await sha256File(source);
  if (actualSha256 !== tool.sha256) {
    throw new Error(
      `${source} sha256 mismatch for ${target}: expected ${tool.sha256}, got ${actualSha256}`,
    );
  }

  await mkdir(installerDir, { recursive: true });
  await copyFile(source, destination);
  return {
    source,
    destination,
    target,
    bytes: info.size,
    sha256: actualSha256,
  };
}
