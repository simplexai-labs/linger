import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { orderByRegion, type Region } from "@linger/service-kit";

import { mirrorHome } from "../paths.js";

// SenseVoiceSmall int8 for sherpa-onnx, pinned to one revision so the bytes
// and the checksums below never drift apart.
const REPOSITORY =
  "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17";
const REVISION = "2365baeacb507f821a0c8120fcee3d484dba7a07";
// The second host serves the same files inside mainland China.
const HOSTS = ["https://huggingface.co", "https://hf-mirror.com"];
const COMPLETE = ".simplex-local-asr-model.json";
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

export interface LocalAsrModelFile {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

export const localAsrModelFiles: readonly LocalAsrModelFile[] = [
  {
    name: "model.int8.onnx",
    bytes: 239_233_841,
    sha256: "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51",
  },
  {
    name: "tokens.txt",
    bytes: 315_894,
    sha256: "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc",
  },
];

/** Where the model lives: beside the other downloaded model data. */
export function localAsrModelDirectory(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(mirrorHome(environment), "models", "sensevoice-small-int8");
}

/** Whether every model file was downloaded and checked. */
export function localAsrModelInstalled(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const directory = localAsrModelDirectory(environment);
  try {
    if (
      readFileSync(path.join(directory, COMPLETE), "utf8") !==
      JSON.stringify(localAsrModelFiles)
    )
      return false;
    return localAsrModelFiles.every(
      (file) => statSync(path.join(directory, file.name)).size === file.bytes,
    );
  } catch {
    return false;
  }
}

/**
 * Downloads and checks the model files that are missing and returns the
 * directory. An interrupted download resumes where it stopped, and a file
 * already in the directory is kept when its checksum matches, so a copy from
 * another install needs no download.
 */
export async function installLocalAsrModel(
  environment: NodeJS.ProcessEnv,
  options: { region: Region; signal?: AbortSignal; fetch?: typeof fetch },
): Promise<string> {
  const directory = localAsrModelDirectory(environment);
  const signal = options.signal ?? new AbortController().signal;
  await mkdir(directory, { recursive: true });
  for (const file of localAsrModelFiles)
    await fetchModelFile(
      file,
      directory,
      options.region,
      options.fetch ?? fetch,
      signal,
    );
  await writeFile(
    path.join(directory, COMPLETE),
    JSON.stringify(localAsrModelFiles),
  );
  return directory;
}

async function fetchModelFile(
  file: LocalAsrModelFile,
  directory: string,
  region: Region,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
) {
  const target = path.join(directory, file.name);
  if (existsSync(target) && (await checksum(target)) === file.sha256) return;
  const partial = `${target}.part`;
  let failure: unknown;
  for (const url of orderByRegion(
    region,
    HOSTS.map(
      (host) => `${host}/${REPOSITORY}/resolve/${REVISION}/${file.name}`,
    ),
  )) {
    try {
      await fetchInto(url, partial, file.bytes, fetchImpl, signal);
      if ((await checksum(partial)) !== file.sha256) {
        await rm(partial, { force: true });
        throw new Error(`${file.name} failed its checksum`);
      }
      await rename(partial, target);
      return;
    } catch (error) {
      signal.throwIfAborted();
      failure = error;
    }
  }
  throw failure;
}

async function fetchInto(
  url: string,
  partial: string,
  bytes: number,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
) {
  let have = (await stat(partial).catch(() => undefined))?.size ?? 0;
  if (have > bytes) {
    await rm(partial, { force: true });
    have = 0;
  }
  // A partial that already has every byte is left to the checksum.
  if (have === bytes) return;
  const response = await fetchImpl(url, {
    headers: have ? { range: `bytes=${have}-` } : {},
    signal: AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]),
  });
  if ((response.status !== 200 && response.status !== 206) || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Model download answered ${response.status}`);
  }
  // A host that ignores the range sends the whole file again.
  await pipeline(
    Readable.fromWeb(response.body as WebReadableStream),
    createWriteStream(partial, { flags: response.status === 206 ? "a" : "w" }),
    { signal },
  );
}

async function checksum(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file))
    hash.update(chunk as Buffer);
  return hash.digest("hex");
}
