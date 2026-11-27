import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const locks = vi.hoisted(() => ({
  compromised: (_error: Error) => {
    void _error;
  },
  release: vi.fn(async () => {}),
}));
vi.mock("proper-lockfile", () => ({
  default: {
    lock: vi.fn(async (_path, options) => {
      locks.compromised = options.onCompromised;
      return locks.release;
    }),
  },
}));
import { publishMemoryWiki } from "../../src/memory/published-memory-files.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  locks.release.mockClear();
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function fixture(name = "Guide.md") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-publish-lock-"));
  roots.push(root);
  const file = path.join(root, "alice/memory/knowledge/projects", name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "# Guide\n\nOriginal\n");
  return { root, file };
}
const replacement = {
  page: { documentId: "guide", path: "projects/guide.md" },
  content: "# Guide\n\nReplacement\n",
};

it("does not publish a staged page after losing the directory lock", async () => {
  const { root, file } = await fixture();
  const writeFile = fs.writeFile.bind(fs);
  vi.spyOn(fs, "writeFile").mockImplementation(
    async (target, data, options) => {
      await writeFile(target, data, options);
      if (data === replacement.content)
        locks.compromised(new Error("lock ownership lost"));
    },
  );
  await expect(
    publishMemoryWiki(root, "alice", [replacement], new Map()),
  ).rejects.toThrow("lock ownership lost");
  expect(await fs.readFile(file, "utf8")).toBe("# Guide\n\nOriginal\n");
  expect(await fs.readdir(path.join(root, "alice/memory-state"))).toEqual([]);
  expect(locks.release).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  await publishMemoryWiki(root, "alice", [replacement], new Map());
  expect(await fs.readFile(file, "utf8")).toBe(replacement.content);
  expect(locks.release).toHaveBeenCalledOnce();
});

it.each(["retire", "rename case"])(
  "does not %s a page after losing the directory lock",
  async (operation) => {
    const { root, file } = await fixture("guide.md");
    const access = fs.access.bind(fs);
    let compromised = false;
    vi.spyOn(fs, "access").mockImplementation(async (target, mode) => {
      await access(target, mode);
      if (
        !compromised &&
        String(target) === path.join(root, "alice/memory/knowledge")
      ) {
        compromised = true;
        locks.compromised(new Error("lock ownership lost"));
      }
    });
    const pages = operation === "retire" ? [] : [replacement];
    await expect(
      publishMemoryWiki(root, "alice", pages, new Map()),
    ).rejects.toThrow("lock ownership lost");
    expect(await fs.readFile(file, "utf8")).toBe("# Guide\n\nOriginal\n");
    expect(locks.release).not.toHaveBeenCalled();
  },
);
