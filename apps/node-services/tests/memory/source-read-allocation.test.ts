import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readWorkspaceText } from "../../src/memory/search/source-store.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function source(content: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-source-read-"));
  roots.push(root);
  const file = path.join(root, "source.md");
  await fs.writeFile(file, content);
  return { root, file };
}

function changeAfterInspection(file: string, change: () => Promise<void>) {
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
    const handle = await open(filePath, flags, mode);
    if (String(filePath) === file) {
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementationOnce(async () => {
        const inspected = await stat();
        await change();
        return inspected;
      });
    }
    return handle;
  });
}

describe("bounded workspace source reads", () => {
  it("sizes the first allocation to a small file plus the overflow sentinel", async () => {
    const text = "x".repeat(1024);
    const f = await source(text);
    const allocate = vi.spyOn(Buffer, "allocUnsafe");

    expect(await readWorkspaceText(f.root, "source.md")).toBe(text);
    expect(allocate).toHaveBeenNthCalledWith(1, Buffer.byteLength(text) + 1);
  });

  it.each([
    { label: "empty", text: "", limit: 0 },
    { label: "Unicode", text: "notes: \u03b1\ud83d\ude80\n", limit: 64 },
    { label: "exact limit", text: "x".repeat(128), limit: 128 },
  ])("returns the complete $label file", async ({ text, limit }) => {
    const f = await source(text);
    expect(await readWorkspaceText(f.root, "source.md", limit)).toBe(text);
  });

  it("reads growth after inspection without cutting Unicode or the new tail", async () => {
    const initial = "start\n";
    const added = "\ud83d\ude80".repeat(128) + "\nnext";
    const f = await source(initial);
    changeAfterInspection(f.file, () => fs.appendFile(f.file, added));

    expect(await readWorkspaceText(f.root, "source.md", 4096)).toBe(
      initial + added,
    );
  });

  it("rejects a file that grows beyond the limit after inspection", async () => {
    const f = await source("start");
    changeAfterInspection(f.file, () =>
      fs.appendFile(f.file, "x".repeat(1024)),
    );

    expect(await readWorkspaceText(f.root, "source.md", 1024)).toBeUndefined();
  });

  it("returns only actual bytes when the file shrinks after inspection", async () => {
    const f = await source("old".repeat(4096));
    const current = "short replacement";
    changeAfterInspection(f.file, () => fs.writeFile(f.file, current));

    expect(await readWorkspaceText(f.root, "source.md")).toBe(current);
  });

  it("rejects an already oversized source", async () => {
    const f = await source("larger than the limit");
    expect(await readWorkspaceText(f.root, "source.md", 3)).toBeUndefined();
  });
});
