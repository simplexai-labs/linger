import { describe, expect, it } from "vitest";

import type { TextFiles } from "../computer/store";
import { AppLog, LOG_PATH, PREVIOUS_LOG_PATH } from "./app-log";

function memoryFiles(): TextFiles & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async read(path) {
      return files.get(path);
    },
    async write(path, text) {
      files.set(path, text);
    },
    async removeDirectory() {},
    async listDirectories() {
      return [];
    },
  };
}

describe("AppLog", () => {
  it("keeps each file under the cap when one flush holds many lines", async () => {
    const files = memoryFiles();
    const log = new AppLog({ files, maxBytes: 1_000 });
    for (let i = 0; i < 200; i += 1) log.log("info", "batch.line", { i });
    await log.flush();
    const bytes = (path: string) =>
      new TextEncoder().encode(files.files.get(path) ?? "").length;
    expect(bytes(LOG_PATH)).toBeGreaterThan(0);
    expect(bytes(LOG_PATH)).toBeLessThanOrEqual(1_000);
    expect(bytes(PREVIOUS_LOG_PATH)).toBeLessThanOrEqual(1_000);
  });

  it("appends one JSON line per event", async () => {
    const files = memoryFiles();
    const log = new AppLog({
      files,
      now: () => new Date("2026-11-24T00:00:00Z"),
    });
    log.log("info", "session.opened", { route: "lan", ms: 12 });
    log.log("error", "app.error", { name: "TypeError" });
    await log.flush();
    const lines = files.files
      .get(LOG_PATH)!
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toEqual([
      {
        time: "2026-11-24T00:00:00.000Z",
        level: "info",
        event: "session.opened",
        route: "lan",
        ms: 12,
      },
      {
        time: "2026-11-24T00:00:00.000Z",
        level: "error",
        event: "app.error",
        name: "TypeError",
      },
    ]);
  });

  it("keeps the file before the current one when it grows past the cap", async () => {
    const files = memoryFiles();
    const log = new AppLog({ files, maxBytes: 200 });
    for (let index = 0; index < 4; index += 1) {
      log.log("info", "tick", { index });
      await log.flush();
    }
    expect(files.files.get(PREVIOUS_LOG_PATH)).toBeDefined();
    expect((files.files.get(LOG_PATH) ?? "").length).toBeLessThanOrEqual(200);
    expect(await log.read()).toContain('"index":3');
  });
});
