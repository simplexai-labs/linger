import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileLogger } from "./log.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createLogDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "desktop-log-"));
  tempDirs.push(dir);
  return dir;
}

describe("fileLogger", () => {
  it("prunes daily desktop logs older than 14 days on initialization", () => {
    const dir = createLogDir();
    writeFileSync(path.join(dir, "desktop-20261031.log"), "too-old\n");
    writeFileSync(path.join(dir, "desktop-20261101.log"), "expired-edge\n");
    writeFileSync(path.join(dir, "desktop-20261102.log"), "boundary-keep\n");
    writeFileSync(path.join(dir, "desktop-20261116.log"), "today\n");
    writeFileSync(path.join(dir, "computer-daemon.log"), "unrelated\n");
    writeFileSync(path.join(dir, "other.txt"), "unrelated\n");

    const logger = fileLogger(dir, {
      now: () => new Date("2026-11-16T12:00:00.000Z"),
    });
    logger.info("desktop.started", { ok: true });

    expect(readdirSync(dir).sort()).toEqual([
      "computer-daemon.log",
      "desktop-20261102.log",
      "desktop-20261116.log",
      "other.txt",
    ]);
    expect(
      readFileSync(path.join(dir, "desktop-20261116.log"), "utf8"),
    ).toContain('"event":"desktop.started"');
  });

  it("ignores symlinked log names instead of unlinking link entries or targets", () => {
    const dir = createLogDir();
    const target = path.join(dir, "keep-me.txt");
    writeFileSync(target, "important");
    symlinkSync(target, path.join(dir, "desktop-20250101.log"));

    fileLogger(dir, {
      now: () => new Date("2026-11-16T12:00:00.000Z"),
    });

    expect(readFileSync(target, "utf8")).toBe("important");
    expect(readdirSync(dir)).toContain("desktop-20250101.log");
  });
});
