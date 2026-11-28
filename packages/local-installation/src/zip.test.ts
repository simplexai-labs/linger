import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { extractZip } from "./zip.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "linger-zip-"));
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

describe("extractZip", () => {
  it("extracts nested entries with the default strip=0", async () => {
    const root = await scratch();
    const out = path.join(root, "out");
    const zipPath = path.join(root, "plain.zip");
    await writeFile(
      zipPath,
      buildStoredZip([
        { name: "top/", content: "" },
        { name: "top/node.exe", content: "fake-node" },
        { name: "top/lib/index.js", content: "export {};\n" },
      ]),
    );
    await extractZip(zipPath, out, () => true);
    expect(await readFile(path.join(out, "top/node.exe"), "utf8")).toBe(
      "fake-node",
    );
    expect(await readFile(path.join(out, "top/lib/index.js"), "utf8")).toBe(
      "export {};\n",
    );
  });

  it("rejects parent traversal entries with the default strip=0", async () => {
    const root = await scratch();
    const out = path.join(root, "out");
    const zipPath = path.join(root, "traversal.zip");
    await writeFile(
      zipPath,
      buildStoredZip([
        { name: "top/ok.txt", content: "fine" },
        { name: "../escape.txt", content: "escaped" },
        { name: "top/../../escape2.txt", content: "escaped" },
      ]),
    );
    await expect(extractZip(zipPath, out, () => true)).rejects.toThrow(
      "Unsafe zip entry.",
    );
    expect(await readFile(path.join(out, "top/ok.txt"), "utf8")).toBe("fine");
    await expect(stat(path.join(root, "escape.txt"))).rejects.toThrow();
    await expect(stat(path.join(root, "escape2.txt"))).rejects.toThrow();
  });

  it("rejects backslash entries instead of joining them as separators", async () => {
    const root = await scratch();
    const out = path.join(root, "out");
    const zipPath = path.join(root, "backslash.zip");
    await writeFile(
      zipPath,
      buildStoredZip([
        { name: "..\\escape.txt", content: "escaped" },
        { name: "top\\lib\\index.js", content: "escaped" },
      ]),
    );
    await expect(extractZip(zipPath, out, () => true)).rejects.toThrow(
      "Unsafe zip entry.",
    );
    await expect(stat(path.join(root, "escape.txt"))).rejects.toThrow();
  });

  it("rejects drive-prefixed entries", async () => {
    const root = await scratch();
    const out = path.join(root, "out");
    const zipPath = path.join(root, "drive.zip");
    await writeFile(
      zipPath,
      buildStoredZip([{ name: "C:/evil.txt", content: "escaped" }]),
    );
    await expect(extractZip(zipPath, out, () => true)).rejects.toThrow(
      "Unsafe zip entry.",
    );
    await expect(stat(path.join(root, "evil.txt"))).rejects.toThrow();
  });
});
