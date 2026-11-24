import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import { extractArchiveFallback } from "./archive.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "linger-archive-"));
  roots.push(dir);
  return dir;
}

/** Builds a minimal stored (method 0) zip archive without external tools. */
function buildStoredZip(
  entries: Array<{ name: string; content: string }>,
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.content, "utf8");
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

describe("extractArchiveFallback", () => {
  it("extracts stored and deflated zip archives with strip=1 and rejects traversal", async () => {
    const root = await scratch();
    const zipPath = path.join(root, "node-win.zip");
    await writeFile(
      zipPath,
      buildStoredZip([
        { name: "node-v26-win-x64/", content: "" },
        { name: "node-v26-win-x64/node.exe", content: "fake-node" },
        { name: "node-v26-win-x64/lib/index.js", content: "export {};\n" },
      ]),
    );
    const out = path.join(root, "out");
    await mkdir(out, { recursive: true });
    await extractArchiveFallback(zipPath, out, { strip: 1 });
    expect(await readFile(path.join(out, "node.exe"), "utf8")).toBe(
      "fake-node",
    );
    expect(await readFile(path.join(out, "lib", "index.js"), "utf8")).toBe(
      "export {};\n",
    );

    const deflatedOut = path.join(root, "deflated-out");
    await mkdir(deflatedOut, { recursive: true });
    const fixture = fileURLToPath(
      new URL("../test/fixtures/deflated.zip", import.meta.url),
    );
    await extractArchiveFallback(fixture, deflatedOut, { strip: 1 });
    expect(
      await readFile(path.join(deflatedOut, "bin", "go.exe"), "utf8"),
    ).toBe("binary".repeat(100));

    const badZip = path.join(root, "bad.zip");
    await writeFile(
      badZip,
      buildStoredZip([{ name: "top/../escape.txt", content: "nope" }]),
    );
    const badOut = path.join(root, "bad-out");
    await mkdir(badOut, { recursive: true });
    await expect(
      extractArchiveFallback(badZip, badOut, { strip: 1 }),
    ).rejects.toThrow("Unsafe zip entry.");
  });

  it("extracts .tar.gz and .tar.zst archives with strip=1", async () => {
    const root = await scratch();
    const src = path.join(root, "src", "linger-source");
    await mkdir(path.join(src, "nested"), { recursive: true });
    await writeFile(path.join(src, "package.json"), '{"name":"linger"}\n');
    await writeFile(path.join(src, "nested", "marker.txt"), "ok\n");

    const tarPath = path.join(root, "source.tar");
    const tgzPath = path.join(root, "source.tar.gz");
    execFileSync("tar", [
      "-cf",
      tarPath,
      "-C",
      path.join(root, "src"),
      "linger-source",
    ]);
    execFileSync("tar", [
      "-czf",
      tgzPath,
      "-C",
      path.join(root, "src"),
      "linger-source",
    ]);
    const zstPath = path.join(root, "source.tar.zst");
    await writeFile(zstPath, zstdCompressSync(await readFile(tarPath)));

    const tgzOut = path.join(root, "tgz-out");
    await mkdir(tgzOut, { recursive: true });
    await extractArchiveFallback(tgzPath, tgzOut, { strip: 1 });
    expect(await readFile(path.join(tgzOut, "package.json"), "utf8")).toBe(
      '{"name":"linger"}\n',
    );
    expect(
      await readFile(path.join(tgzOut, "nested", "marker.txt"), "utf8"),
    ).toBe("ok\n");

    const zstOut = path.join(root, "zst-out");
    await mkdir(zstOut, { recursive: true });
    await extractArchiveFallback(zstPath, zstOut, { strip: 1 });
    expect(await readFile(path.join(zstOut, "package.json"), "utf8")).toBe(
      '{"name":"linger"}\n',
    );
    expect(
      await readFile(path.join(zstOut, "nested", "marker.txt"), "utf8"),
    ).toBe("ok\n");
  });

  it("rejects unsupported archive extensions", async () => {
    const root = await scratch();
    const file = path.join(root, "bundle.7z");
    await writeFile(file, "bytes");
    await expect(
      extractArchiveFallback(file, root, { strip: 1 }),
    ).rejects.toThrow(/Unsupported archive format: bundle\.7z/);
  });
});
