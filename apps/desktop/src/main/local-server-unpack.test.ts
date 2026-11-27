import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
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

  it("unpacks archives when the destination crosses a symlinked directory", async () => {
    if (process.platform === "win32") return;
    const root = tempDirectory();
    const src = path.join(root, "src", "top");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(src, "hello.txt"), "symlink-ok\n");
    const tgzFile = path.join(root, "pkg.tar.gz");
    execFileSync("tar", ["-czf", tgzFile, "-C", path.join(root, "src"), "top"]);

    // Deeper real directory reached through a shallower symlink, matching macOS /tmp -> /private/tmp.
    const deepReal = path.join(root, "a", "b", "c", "target");
    await mkdir(deepReal, { recursive: true });
    const link = path.join(root, "link");
    await symlink(deepReal, link);

    const out = path.join(link, "out");
    await unpackArchive(tgzFile, out, new AbortController().signal);
    expect(await readFile(path.join(out, "hello.txt"), "utf8")).toBe(
      "symlink-ok\n",
    );
  });

  it("verifies sha256 and byte count in one streaming pass for .tar.zst archives", async () => {
    const root = tempDirectory();
    const src = path.join(root, "src", "top");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(src, "payload.txt"), "verified-zst\n");

    const tarFile = path.join(root, "runtime.tar");
    execFileSync("tar", ["-cf", tarFile, "-C", path.join(root, "src"), "top"]);
    const zstBytes = zstdCompressSync(await readFile(tarFile));
    const zstFile = path.join(root, "runtime.tar.zst");
    await writeFile(zstFile, zstBytes);
    const sha256 = createHash("sha256").update(zstBytes).digest("hex");

    const okOut = path.join(root, "out-ok");
    await unpackArchive(zstFile, okOut, new AbortController().signal, {
      verifySha256: sha256,
      verifyBytes: zstBytes.length,
    });
    expect(await readFile(path.join(okOut, "payload.txt"), "utf8")).toBe(
      "verified-zst\n",
    );

    const badShaOut = path.join(root, "out-bad-sha");
    await expect(
      unpackArchive(zstFile, badShaOut, new AbortController().signal, {
        verifySha256: "0".repeat(64),
        verifyBytes: zstBytes.length,
      }),
    ).rejects.toThrow("The bundled runtime.tar.zst is damaged");

    const badSizeOut = path.join(root, "out-bad-size");
    await expect(
      unpackArchive(zstFile, badSizeOut, new AbortController().signal, {
        verifySha256: sha256,
        verifyBytes: zstBytes.length + 1,
      }),
    ).rejects.toThrow("The bundled runtime.tar.zst is damaged");

    // Corrupt non-zstd bytes still surface the archive integrity error.
    const corruptFile = path.join(root, "corrupt.tar.zst");
    await writeFile(corruptFile, "not-a-zst-frame");
    await expect(
      unpackArchive(
        corruptFile,
        path.join(root, "out-corrupt"),
        new AbortController().signal,
        { verifySha256: sha256 },
      ),
    ).rejects.toThrow("The bundled corrupt.tar.zst is damaged");

    // ENOENT pure-Node fallback also enforces verifySha256 before extracting.
    const missingTar = "C:\\Windows\\System32\\tar.exe";
    await expect(
      unpackArchive(
        zstFile,
        path.join(root, "out-fallback-bad"),
        new AbortController().signal,
        {
          command: missingTar,
          runCommand: async () => {
            throw enoent(missingTar);
          },
          verifySha256: "f".repeat(64),
        },
      ),
    ).rejects.toThrow("The bundled runtime.tar.zst is damaged");

    // Non-.zst archives also enforce verifySha256 and verifyBytes.
    const tgzFile = path.join(root, "runtime.tar.gz");
    execFileSync("tar", ["-czf", tgzFile, "-C", path.join(root, "src"), "top"]);
    const tgzBytes = await readFile(tgzFile);
    const tgzSha = createHash("sha256").update(tgzBytes).digest("hex");
    await expect(
      unpackArchive(
        tgzFile,
        path.join(root, "out-tgz-bad"),
        new AbortController().signal,
        { verifySha256: "1".repeat(64), verifyBytes: tgzBytes.length },
      ),
    ).rejects.toThrow("The bundled runtime.tar.gz is damaged");
    await unpackArchive(
      tgzFile,
      path.join(root, "out-tgz-ok"),
      new AbortController().signal,
      { verifySha256: tgzSha, verifyBytes: tgzBytes.length },
    );
    expect(
      await readFile(path.join(root, "out-tgz-ok", "payload.txt"), "utf8"),
    ).toBe("verified-zst\n");
  });
});
