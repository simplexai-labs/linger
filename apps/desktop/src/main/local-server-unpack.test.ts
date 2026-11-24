import { execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { zstdCompressSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";
import { ZipFile } from "yazl";

import { tarCommand, unpackArchive } from "./local-server.js";
import { tempDirectory } from "./test-support.js";

const createZip = async (
  target: string,
  entries: Array<{ name: string; content: string }>,
): Promise<void> => {
  const zip = new ZipFile();
  for (const entry of entries) {
    zip.addBuffer(Buffer.from(entry.content, "utf8"), entry.name);
  }
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(target));
};

const enoent = (command: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`spawn ${command} ENOENT`), {
    code: "ENOENT",
    errno: -4058,
  });

describe("tarCommand", () => {
  it("resolves System32\\tar.exe on Windows from SystemRoot, windir, or default", () => {
    expect(tarCommand("win32", { SystemRoot: "D:\\Windows" })).toBe(
      "D:\\Windows\\System32\\tar.exe",
    );
    expect(tarCommand("win32", { SystemRoot: "  ", windir: "E:\\Win" })).toBe(
      "E:\\Win\\System32\\tar.exe",
    );
    expect(tarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
    expect(tarCommand("linux", { SystemRoot: "D:\\Windows" })).toBe("tar");
  });
});

describe("unpackArchive", () => {
  it("falls back to pure-Node extraction when Windows tar.exe is missing (ENOENT)", async () => {
    const root = tempDirectory();
    const src = path.join(root, "src", "top");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(src, "hello.txt"), "world\n");

    const tarFile = path.join(root, "pkg.tar");
    const tgzFile = path.join(root, "pkg.tar.gz");
    execFileSync("tar", ["-cf", tarFile, "-C", path.join(root, "src"), "top"]);
    execFileSync("tar", ["-czf", tgzFile, "-C", path.join(root, "src"), "top"]);
    const zstFile = path.join(root, "pkg.tar.zst");
    await writeFile(zstFile, zstdCompressSync(await readFile(tarFile)));
    const zipFile = path.join(root, "node.zip");
    await createZip(zipFile, [{ name: "node-v26/node.exe", content: "bin" }]);

    const onFallback = vi.fn();
    const missingTar = "C:\\Windows\\System32\\tar.exe";
    const failEnoent = async () => {
      throw enoent(missingTar);
    };

    const tgzOut = path.join(root, "out-tgz");
    await unpackArchive(tgzFile, tgzOut, new AbortController().signal, {
      command: missingTar,
      runCommand: failEnoent,
      onFallback,
    });
    expect(await readFile(path.join(tgzOut, "hello.txt"), "utf8")).toBe(
      "world\n",
    );

    const zstOut = path.join(root, "out-zst");
    await unpackArchive(zstFile, zstOut, new AbortController().signal, {
      command: missingTar,
      runCommand: failEnoent,
      onFallback,
    });
    expect(await readFile(path.join(zstOut, "hello.txt"), "utf8")).toBe(
      "world\n",
    );

    const zipOut = path.join(root, "out-zip");
    await unpackArchive(zipFile, zipOut, new AbortController().signal, {
      command: missingTar,
      runCommand: failEnoent,
      onFallback,
    });
    expect(await readFile(path.join(zipOut, "node.exe"), "utf8")).toBe("bin");
    expect(onFallback).toHaveBeenCalledTimes(3);
    expect(onFallback).toHaveBeenCalledWith(missingTar);
  });

  it("reports a platform-appropriate actionable error when tar is missing and fallback fails", async () => {
    const root = tempDirectory();
    const archive = path.join(root, "bundle.bin");
    await writeFile(archive, "not-an-archive");
    const out = path.join(root, "out");
    const missingTar = "C:\\Windows\\System32\\tar.exe";

    await expect(
      unpackArchive(archive, out, new AbortController().signal, {
        platform: "win32",
        command: missingTar,
        runCommand: async () => {
          throw enoent(missingTar);
        },
      }),
    ).rejects.toThrow(
      /Failed to unpack bundle\.bin: C:\\Windows\\System32\\tar\.exe was not found \(ENOENT\).*Restore Windows tar\.exe/,
    );

    await expect(
      unpackArchive(archive, out, new AbortController().signal, {
        platform: "linux",
        command: "tar",
        runCommand: async () => {
          throw enoent("tar");
        },
      }),
    ).rejects.toThrow(
      /Failed to unpack bundle\.bin: tar was not found \(ENOENT\).*Install tar or reinstall Linger\./,
    );
  });

  it("rethrows non-ENOENT tar failures without running fallback", async () => {
    const root = tempDirectory();
    const archive = path.join(root, "pkg.tar.gz");
    await writeFile(archive, "corrupt");
    const out = path.join(root, "out");
    const fallback = vi.fn();

    await expect(
      unpackArchive(archive, out, new AbortController().signal, {
        command: "tar",
        runCommand: async () => {
          throw new Error("tar exited with code 2");
        },
        fallback,
      }),
    ).rejects.toThrow("tar exited with code 2");
    expect(fallback).not.toHaveBeenCalled();
  });
});
