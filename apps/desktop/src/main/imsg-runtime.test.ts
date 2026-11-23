import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { IMSG_SHA256, IMsgRuntime, IMsgRuntimeError } from "./imsg-runtime.js";
import { tempDirectory } from "./test-support.js";

const ZIP = Buffer.from("fake imsg zip");
const release = {
  version: "1.0.0",
  url: "https://example.com/imsg-macos.zip",
  sha256: createHash("sha256").update(ZIP).digest("hex"),
};

const setup = (
  options: {
    body?: Buffer;
    extract?: (zip: string, into: string) => Promise<void>;
  } = {},
) => {
  const root = path.join(tempDirectory(), "imsg");
  const fetch = vi.fn(
    async () => new Response(new Uint8Array(options.body ?? ZIP)),
  );
  const extract = vi.fn(
    options.extract ??
      (async (_zip: string, into: string) => {
        writeFileSync(path.join(into, "imsg"), "#!/bin/sh\n", { mode: 0o755 });
        mkdirSync(path.join(into, "SQLite.swift_SQLite.bundle"));
      }),
  );
  const runtime = new IMsgRuntime({
    root,
    release,
    fetch: fetch as unknown as typeof globalThis.fetch,
    extract,
  });
  return { root, fetch, extract, runtime };
};

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as IMsgRuntimeError;
  }
  throw new Error("expected a failure");
};

describe("IMsgRuntime", () => {
  it("pins a sha256 digest", () => {
    expect(IMSG_SHA256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("downloads, verifies and unpacks into the version folder", async () => {
    const { root, runtime, extract } = setup();
    const executable = await runtime.ensure();
    expect(executable).toBe(path.join(root, "1.0.0", "imsg"));
    expect(existsSync(executable)).toBe(true);
    expect(extract).toHaveBeenCalledOnce();
    // Only the version folder stays: no zip, no staging folder.
    expect(readdirSync(root)).toEqual(["1.0.0"]);
  });

  it("reuses an installed version without the network", async () => {
    const { runtime, fetch } = setup();
    await runtime.ensure();
    fetch.mockClear();
    await runtime.ensure();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shares one download between concurrent calls", async () => {
    const { runtime, fetch } = setup();
    const [a, b] = await Promise.all([runtime.ensure(), runtime.ensure()]);
    expect(a).toBe(b);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("never unpacks a download that fails its checksum", async () => {
    const { root, runtime, extract } = setup({
      body: Buffer.from("tampered"),
    });
    const error = await failure(runtime.ensure());
    expect(error).toBeInstanceOf(IMsgRuntimeError);
    expect(error.code).toBe("checksum_mismatch");
    expect(extract).not.toHaveBeenCalled();
    expect(readdirSync(root)).toEqual([]);
  });

  it("cleans up when unpacking fails", async () => {
    const { root, runtime } = setup({
      extract: async (_zip, into) => {
        writeFileSync(path.join(into, "partial"), "x");
        throw new Error("ditto: bad zip");
      },
    });
    expect((await failure(runtime.ensure())).code).toBe("extract_failed");
    expect(readdirSync(root)).toEqual([]);
  });

  it("fails when the zip has no executable", async () => {
    const { root, runtime } = setup({ extract: async () => {} });
    expect((await failure(runtime.ensure())).code).toBe("executable_missing");
    expect(readdirSync(root)).toEqual([]);
  });

  it("removes other versions after an install", async () => {
    const { root, runtime } = setup();
    mkdirSync(path.join(root, "0.9.0"), { recursive: true });
    writeFileSync(path.join(root, "0.9.0", "imsg"), "old");
    await runtime.ensure();
    expect(readdirSync(root)).toEqual(["1.0.0"]);
  });
});
