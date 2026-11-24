import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { inflateRaw } from "node:zlib";

const inflate = promisify(inflateRaw);

export interface ZipEntry {
  name: string;
  directory: boolean;
  size: number;
}
export interface ExtractZipOptions {
  strip?: number;
}
function strippedZipPath(name: string, strip: number): string[] | undefined {
  const normalized = name.replace(/\/+$/, "");
  if (!normalized) return undefined;
  const parts = normalized.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".."))
    throw new Error("Unsafe zip entry.");
  if (parts[0]?.includes(":")) throw new Error("Unsafe zip entry.");
  const kept = strip > 0 ? parts.slice(strip) : parts;
  return kept.length ? kept : undefined;
}
/**
 * Minimal reader for verified release zips (Go and Node for Windows): stored
 * and deflated entries only, no ZIP64 and no encryption. The caller has already
 * checked the archive digest, so entry CRCs add nothing here.
 */
export async function extractZip(
  file: string,
  directory: string,
  accept: (entry: ZipEntry) => boolean,
  options: ExtractZipOptions = {},
): Promise<void> {
  const strip = options.strip ?? 0;
  const data = await readFile(file);
  let end = -1;
  for (let at = data.length - 22; at >= Math.max(0, data.length - 65_557); at--)
    if (data.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  if (end < 0) throw new Error("Invalid zip archive.");
  const count = data.readUInt16LE(end + 10);
  let offset = data.readUInt32LE(end + 16);
  if (count === 0xffff || offset === 0xffffffff)
    throw new Error("Unsupported zip archive.");
  for (let index = 0; index < count; index++) {
    if (data.readUInt32LE(offset) !== 0x02014b50)
      throw new Error("Invalid zip archive.");
    const flags = data.readUInt16LE(offset + 8);
    const method = data.readUInt16LE(offset + 10);
    const compressed = data.readUInt32LE(offset + 20);
    const size = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const local = data.readUInt32LE(offset + 42);
    const name = data.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    const directoryEntry = name.endsWith("/");
    if (
      !accept({
        name: name.replace(/\/$/, ""),
        directory: directoryEntry,
        size,
      })
    )
      return;
    const parts =
      strip > 0
        ? strippedZipPath(name, strip)
        : name.split("/").filter(Boolean);
    if (!parts) continue;
    const target = path.join(directory, ...parts);
    if (directoryEntry) {
      await mkdir(target, { recursive: true, mode: 0o700 });
      continue;
    }
    if (flags & 1 || (method !== 0 && method !== 8))
      throw new Error("Unsupported zip archive.");
    if (data.readUInt32LE(local) !== 0x04034b50)
      throw new Error("Invalid zip archive.");
    const start =
      local +
      30 +
      data.readUInt16LE(local + 26) +
      data.readUInt16LE(local + 28);
    const raw = data.subarray(start, start + compressed);
    const contents =
      method === 0 ? raw : await inflate(raw, { maxOutputLength: size || 1 });
    if (contents.length !== size) throw new Error("Invalid zip archive.");
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, contents, { mode: 0o700, flag: "wx" });
  }
}
