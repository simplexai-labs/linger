import { createReadStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import { x as extractTar } from "tar";
import { extractZip } from "./zip.js";

export interface ExtractArchiveFallbackOptions {
  strip?: number;
  signal?: AbortSignal;
}

// Windows' built-in bsdtar accepts drive-letter paths (C:\...), whereas MSYS
// GNU tar earlier on PATH (Git Bash) treats "C:" as a remote host name.
export function tarCommand(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform !== "win32") return "tar";
  const systemRoot =
    env.SystemRoot?.trim() || env.windir?.trim() || "C:\\Windows";
  return path.win32.join(systemRoot, "System32", "tar.exe");
}

/**
 * Pure-Node fallback extractor used when system tar.exe is absent on stripped
 * Windows images. Supports verified .zip, .tar, .tar.gz/.tgz, and .tar.zst.
 */
export async function extractArchiveFallback(
  file: string,
  directory: string,
  options: ExtractArchiveFallbackOptions = {},
): Promise<void> {
  const { strip = 0, signal } = options;
  signal?.throwIfAborted();
  const lower = path.basename(file).toLowerCase();
  if (lower.endsWith(".zip")) {
    await extractZip(
      file,
      directory,
      () => {
        signal?.throwIfAborted();
        return true;
      },
      { strip },
    );
    return;
  }
  if (lower.endsWith(".tar.zst") || lower.endsWith(".tzst")) {
    await pipeline(
      createReadStream(file, { signal }),
      createZstdDecompress(),
      extractTar({ cwd: directory, strip, strict: true }),
      { signal },
    );
    return;
  }
  if (
    lower.endsWith(".tar.gz") ||
    lower.endsWith(".tgz") ||
    lower.endsWith(".tar")
  ) {
    await pipeline(
      createReadStream(file, { signal }),
      extractTar({ cwd: directory, strip, strict: true }),
      { signal },
    );
    return;
  }
  throw new Error(`Unsupported archive format: ${path.basename(file)}`);
}
