import { execFile } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { readWorkspaceText } from "../../src/memory/search/source-store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "raw-source-types-"));
  roots.push(root);
  return root;
}

it.skipIf(process.platform === "win32")(
  "refuses a FIFO without waiting for a writer",
  async () => {
    const root = await workspace();
    const fifo = path.join(root, "source.md");
    await promisify(execFile)("mkfifo", [fifo]);
    let settled = false;
    const result = readWorkspaceText(root, "source.md").then((value) => {
      settled = true;
      return value;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        result,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 250);
        }),
      ]);
      expect(settled).toBe(true);
      await expect(result).resolves.toBeUndefined();
    } finally {
      clearTimeout(timer);
      if (!settled) {
        const writer = await fs.open(
          fifo,
          constants.O_WRONLY | constants.O_NONBLOCK,
        );
        await writer.close();
        await result;
      }
    }
  },
);

it("still reads bounded regular files and refuses directories", async () => {
  const root = await workspace();
  await fs.writeFile(path.join(root, "source.md"), "evidence");
  await fs.mkdir(path.join(root, "directory.md"));
  await expect(readWorkspaceText(root, "source.md", 8)).resolves.toBe(
    "evidence",
  );
  await expect(
    readWorkspaceText(root, "source.md", 7),
  ).resolves.toBeUndefined();
  await expect(
    readWorkspaceText(root, "directory.md"),
  ).resolves.toBeUndefined();
});
