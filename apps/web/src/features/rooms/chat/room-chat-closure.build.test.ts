// @vitest-environment node

import { fileURLToPath } from "node:url";
import { build } from "vite";
import { describe, expect, it, vi } from "vitest";

import viteConfig from "../../../../vite.config";

vi.mock("vite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vite")>()),
  loadEnv: vi.fn(() => ({})),
}));

describe("room-chat static import closure", () => {
  it("excludes @mantine/core from the room-chat static closure", async () => {
    const root = fileURLToPath(new URL("../../../..", import.meta.url));
    const roomChatEntry = fileURLToPath(
      new URL("./room-chat.tsx", import.meta.url),
    );
    const config = viteConfig({ command: "build", mode: "production" });
    const result = await build({
      ...config,
      configFile: false,
      root,
      logLevel: "silent",
      build: {
        ...config.build,
        write: false,
        minify: false,
        rolldownOptions: {
          input: roomChatEntry,
        },
      },
    });
    if (!("output" in result)) {
      throw new Error("Expected a single Rollup/Rolldown build output");
    }

    const chunksByFile = new Map(
      result.output
        .filter((item) => item.type === "chunk")
        .map((chunk) => [chunk.fileName, chunk]),
    );
    const entryChunk = [...chunksByFile.values()].find(
      (chunk) => chunk.isEntry,
    );
    expect(entryChunk).toBeDefined();

    // Walk only static imports (chunk.imports), never chunk.dynamicImports.
    const visited = new Set<string>();
    const queue = [entryChunk!.fileName];
    const staticModuleIds: string[] = [];

    while (queue.length > 0) {
      const fileName = queue.shift()!;
      if (visited.has(fileName)) continue;
      visited.add(fileName);
      const chunk = chunksByFile.get(fileName);
      if (!chunk) continue;
      staticModuleIds.push(...Object.keys(chunk.modules));
      for (const imported of chunk.imports) {
        if (!visited.has(imported)) {
          queue.push(imported);
        }
      }
    }

    const forbidden = staticModuleIds.filter((id) =>
      id.includes("/node_modules/@mantine/core/"),
    );
    expect(forbidden).toEqual([]);
  });
});
