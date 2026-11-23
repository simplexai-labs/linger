import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import {
  ChecksumMismatchError,
  downloadVerified,
} from "@linger/local-installation/download";
import {
  removeRetrying,
  renameRetrying,
} from "@linger/local-installation/fs-retry";

import { followHttps } from "./local-server.js";

// imsg (https://github.com/openclaw/imsg, MIT): the Messages CLI the iMessage
// bridge runs. The digest is the release's own SHA256SUMS entry for the zip.
export const IMSG_VERSION = "0.21.1";
export const IMSG_SHA256 =
  "78fcd9b7770ca9ead71228acf186759279115078895d1ee1299a09333824c77f";
export const IMSG_RELEASE: IMsgRelease = {
  version: IMSG_VERSION,
  url: `https://github.com/openclaw/imsg/releases/download/v${IMSG_VERSION}/imsg-macos.zip`,
  sha256: IMSG_SHA256,
};
// The 0.21.1 zip is about 4 MiB.
const IMSG_MAX_BYTES = 64 * 1024 * 1024;
const EXECUTABLE = "imsg";

export type IMsgRuntimeErrorCode =
  | "download_failed"
  | "checksum_mismatch"
  | "extract_failed"
  | "executable_missing";

export class IMsgRuntimeError extends Error {
  constructor(
    readonly code: IMsgRuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "IMsgRuntimeError";
  }
}

export interface IMsgRelease {
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
}

export interface IMsgRuntimeOptions {
  // `<userData>/imessage/imsg`; each version unpacks into a folder in it.
  readonly root: string;
  readonly release?: IMsgRelease;
  readonly fetch?: typeof fetch;
  // Unpacks a zip into an empty folder.
  readonly extract?: (zip: string, into: string) => Promise<void>;
}

// ditto keeps the code signatures and resource bundles of the release as
// they are; nothing is re-signed.
function dittoExtract(zip: string, into: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/ditto", ["-x", "-k", zip, into], (error, _o, stderr) =>
      error ? reject(new Error(`${stderr}${error.message}`)) : resolve(),
    );
  });
}

async function isFile(file: string): Promise<boolean> {
  return (await stat(file).catch(() => undefined))?.isFile() ?? false;
}

// The pinned imsg release in the app's data folder. The version folder
// appears only complete: the zip is verified before it is unpacked, and the
// unpacked folder is renamed into place.
export class IMsgRuntime {
  readonly #root: string;
  readonly #release: IMsgRelease;
  readonly #fetch: typeof fetch;
  readonly #extract: (zip: string, into: string) => Promise<void>;
  #installing: Promise<string> | undefined;

  constructor(options: IMsgRuntimeOptions) {
    this.#root = options.root;
    this.#release = options.release ?? IMSG_RELEASE;
    this.#fetch = options.fetch ?? fetch;
    this.#extract = options.extract ?? dittoExtract;
  }

  executable(): string {
    return path.join(this.#root, this.#release.version, EXECUTABLE);
  }

  async installed(): Promise<boolean> {
    return isFile(this.executable());
  }

  // Resolves with the executable's path; concurrent calls share one install.
  ensure(): Promise<string> {
    this.#installing ??= this.#ensure().finally(() => {
      this.#installing = undefined;
    });
    return this.#installing;
  }

  async #ensure(): Promise<string> {
    if (await this.installed()) return this.executable();
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const tag = randomBytes(4).toString("hex");
    const { version, url, sha256 } = this.#release;
    const zip = path.join(this.#root, `.imsg-${version}-${tag}.zip`);
    const staging = path.join(this.#root, `.${version}-${tag}.partial`);
    const directory = path.join(this.#root, version);
    try {
      try {
        await downloadVerified(
          {
            url,
            output: zip,
            algorithm: "sha256",
            digest: sha256,
            maxBytes: IMSG_MAX_BYTES,
            signal: new AbortController().signal,
          },
          followHttps(this.#fetch),
        );
      } catch (error) {
        throw error instanceof ChecksumMismatchError
          ? new IMsgRuntimeError(
              "checksum_mismatch",
              "The downloaded imsg does not match its checksum.",
            )
          : new IMsgRuntimeError("download_failed", errorMessage(error));
      }
      await mkdir(staging, { mode: 0o700 });
      try {
        await this.#extract(zip, staging);
      } catch (error) {
        throw new IMsgRuntimeError("extract_failed", errorMessage(error));
      }
      if (!(await isFile(path.join(staging, EXECUTABLE))))
        throw new IMsgRuntimeError(
          "executable_missing",
          "The imsg download has no imsg executable.",
        );
      await renameRetrying(staging, directory);
    } finally {
      await rm(zip, { force: true });
      await removeRetrying(staging);
    }
    await this.#removeOthers();
    return this.executable();
  }

  // Older versions, and anything a crash left behind. Only this process
  // installs here, and its install has finished.
  async #removeOthers(): Promise<void> {
    for (const entry of await readdir(this.#root).catch(() => []))
      if (entry !== this.#release.version)
        await removeRetrying(path.join(this.#root, entry));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
