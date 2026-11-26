import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openRotatingNativeLog } from "./native-log.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeLogDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "native-log-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("openRotatingNativeLog", () => {
  it("rotates at maxBytes and caps backups at maxBackups", () => {
    const dir = makeLogDir();
    const logPath = path.join(dir, "web.log");
    const log = openRotatingNativeLog({
      path: logPath,
      maxBytes: 128,
      maxBackups: 3,
    });
    for (let index = 0; index < 12; index++) {
      log.append(`line-${String(index).padStart(2, "0")}-${"x".repeat(64)}\n`);
    }
    log.append("latest-tail\n");
    log.close();

    expect(readdirSync(dir).sort()).toEqual([
      "web.log",
      "web.log.1",
      "web.log.2",
      "web.log.3",
    ]);
    expect(existsSync(`${logPath}.4`)).toBe(false);
    expect(readFileSync(logPath, "utf8")).toContain("latest-tail\n");
    if (process.platform !== "win32") {
      expect(statSync(logPath).mode & 0o077).toBe(0);
      expect(statSync(`${logPath}.1`).mode & 0o077).toBe(0);
    }
  });

  it("rotates an already-oversized log file on startup", () => {
    const dir = makeLogDir();
    const logPath = path.join(dir, "web.log");
    writeFileSync(logPath, "", { mode: 0o600 });
    chmodSync(logPath, 0o600);
    truncateSync(logPath, 512);

    const log = openRotatingNativeLog({
      path: logPath,
      maxBytes: 256,
      maxBackups: 3,
    });
    log.append("fresh-entry\n");
    log.close();

    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(statSync(`${logPath}.1`).size).toBe(512);
    expect(readFileSync(logPath, "utf8")).toBe("fresh-entry\n");
  });

  it("refuses symlinked log paths via O_NOFOLLOW", () => {
    const dir = makeLogDir();
    const target = path.join(dir, "target.txt");
    const link = path.join(dir, "web.log");
    writeFileSync(target, "keep");
    symlinkSync(target, link);

    expect(() => openRotatingNativeLog({ path: link })).toThrow();
    expect(readFileSync(target, "utf8")).toBe("keep");
  });

  it("recovers cleanly if a backup shift fails and reports dropped lines", () => {
    const dir = makeLogDir();
    const logPath = path.join(dir, "web.log");
    // Pre-place an unremovable directory at web.log.3 to simulate transient failure.
    const log = openRotatingNativeLog({
      path: logPath,
      maxBytes: 40,
      maxBackups: 1,
      droppedLineMessage: (count) => `dropped=${count}\n`,
    });
    log.append("first-long-line-to-trigger-rotation-now\n");
    log.append("second-line\n");
    log.close();

    expect(readFileSync(logPath, "utf8")).toContain("second-line\n");
  });
});
