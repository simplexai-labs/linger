import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LocalModelsStorage,
  isAbsolutePlatformPath,
  isPathWithinRoot,
  normalizePlatformPath,
  stripWindowsExtendedPrefix,
  type LocalModelsStorageFs,
} from "./local-models-storage.js";

const tempRoots: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "linger-model-storage-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("path helpers", () => {
  it("strips Windows extended-length prefixes including UNC", () => {
    expect(stripWindowsExtendedPrefix("\\\\?\\C:\\Users\\Alice\\models")).toBe(
      "C:\\Users\\Alice\\models",
    );
    expect(
      stripWindowsExtendedPrefix("\\\\?\\UNC\\fileserver\\share\\models"),
    ).toBe("\\\\fileserver\\share\\models");
    expect(stripWindowsExtendedPrefix("D:\\program\\Linger\\models")).toBe(
      "D:\\program\\Linger\\models",
    );
  });

  it("validates absolute paths per platform", () => {
    expect(isAbsolutePlatformPath("/Users/alice/models", "darwin")).toBe(true);
    expect(isAbsolutePlatformPath("relative/models", "darwin")).toBe(false);
    expect(isAbsolutePlatformPath("/Users/alice/\0bad", "linux")).toBe(false);
    expect(
      isAbsolutePlatformPath("D:\\program\\Linger\\runtime\\models", "win32"),
    ).toBe(true);
    expect(
      isAbsolutePlatformPath("\\\\?\\C:\\Users\\Alice\\models", "win32"),
    ).toBe(true);
    expect(isAbsolutePlatformPath("C:relative\\path", "win32")).toBe(false);
    expect(isAbsolutePlatformPath("\\drive-relative\\path", "win32")).toBe(
      false,
    );
  });

  it("enforces strict root containment across Windows and POSIX", () => {
    expect(
      isPathWithinRoot(
        "D:\\program\\Linger\\runtime\\localmodels\\models\\models",
        "d:\\program\\linger\\runtime\\localmodels\\models\\models\\qwen.gguf",
        "win32",
      ),
    ).toBe(true);
    expect(
      isPathWithinRoot(
        "\\\\?\\C:\\Users\\Alice\\.simplexai\\runtime\\localmodels\\models\\models",
        "C:\\Users\\Alice\\.simplexai\\runtime\\localmodels\\models\\models\\assets\\mmproj.gguf",
        "win32",
      ),
    ).toBe(true);
    // Cross-drive escape must be rejected.
    expect(
      isPathWithinRoot(
        "C:\\Users\\Alice\\.simplexai\\runtime\\localmodels\\models\\models",
        "D:\\Users\\Alice\\.simplexai\\runtime\\localmodels\\models\\models\\qwen.gguf",
        "win32",
      ),
    ).toBe(false);
    // Prefix-sibling directory and parent traversal must be rejected.
    expect(
      isPathWithinRoot(
        "C:\\Linger\\models\\models",
        "C:\\Linger\\models\\models-evil\\payload.exe",
        "win32",
      ),
    ).toBe(false);
    expect(
      isPathWithinRoot(
        "C:\\Linger\\models\\models",
        "C:\\Linger\\models\\engines\\llama-server.exe",
        "win32",
      ),
    ).toBe(false);
    // POSIX containment, including filenames starting with two dots inside root.
    expect(
      isPathWithinRoot(
        "/home/alice/models",
        "/home/alice/models/..a.gguf",
        "linux",
      ),
    ).toBe(true);
    expect(
      isPathWithinRoot(
        "/home/alice/models",
        "/home/alice/models/../engines",
        "linux",
      ),
    ).toBe(false);
    expect(
      isPathWithinRoot(
        "/home/alice/models",
        "/home/alice/models-other/a.gguf",
        "linux",
      ),
    ).toBe(false);
  });
});

describe("LocalModelsStorage (real filesystem POSIX)", () => {
  it("opens <baseDir>/models on macOS and excludes sibling engines/deployments", async () => {
    const baseDir = await makeTempDir();
    const modelsRoot = path.join(baseDir, "models");
    const enginesDir = path.join(baseDir, "engines");
    const deployDir = path.join(baseDir, "deployments", "d1");
    await fs.mkdir(path.join(modelsRoot, "inkling-2-mini"), {
      recursive: true,
    });
    await fs.mkdir(enginesDir, { recursive: true });
    await fs.mkdir(deployDir, { recursive: true });
    const weightFile = path.join(modelsRoot, "qwen3.gguf");
    const bundleDir = path.join(modelsRoot, "inkling-2-mini");
    const apiKeyFile = path.join(deployDir, "api-key");
    const engineBin = path.join(enginesDir, "llama-server");
    await fs.writeFile(weightFile, "weights");
    await fs.writeFile(apiKeyFile, "secret");
    await fs.writeFile(engineBin, "binary");

    const openPath = vi.fn(async () => "");
    const showItemInFolder = vi.fn();
    const storage = new LocalModelsStorage({
      platform: "darwin",
      resolveBaseDir: () => baseDir,
      openPath,
      showItemInFolder,
    });

    const realModelsRoot = await fs.realpath(modelsRoot);
    const realWeight = await fs.realpath(weightFile);
    const realBundleDir = await fs.realpath(bundleDir);

    expect(await storage.openFolder()).toEqual({ ok: true });
    expect(openPath).toHaveBeenCalledExactlyOnceWith(realModelsRoot);
    expect(showItemInFolder).not.toHaveBeenCalled();

    // Revealing a file MUST call showItemInFolder and NEVER openPath.
    expect(await storage.revealPath(weightFile)).toEqual({ ok: true });
    expect(showItemInFolder).toHaveBeenCalledExactlyOnceWith(realWeight);
    expect(openPath).toHaveBeenCalledOnce();

    // A directory below modelsRoot (a macOS .app bundle would launch under
    // openPath) is revealed in its parent, never opened.
    expect(await storage.revealPath(bundleDir)).toEqual({ ok: true });
    expect(showItemInFolder).toHaveBeenLastCalledWith(realBundleDir);
    expect(openPath).toHaveBeenCalledOnce();

    // Revealing the root itself opens it.
    expect(await storage.revealPath(modelsRoot)).toEqual({ ok: true });
    expect(openPath).toHaveBeenLastCalledWith(realModelsRoot);

    // Sibling secrets and binaries under baseDir are strictly outside modelsRoot.
    expect(await storage.revealPath(apiKeyFile)).toEqual({
      ok: false,
      code: "OUTSIDE_ROOT",
    });
    expect(await storage.revealPath(engineBin)).toEqual({
      ok: false,
      code: "OUTSIDE_ROOT",
    });
    expect(
      await storage.revealPath(
        path.join(modelsRoot, "..", "deployments", "d1", "api-key"),
      ),
    ).toEqual({
      ok: false,
      code: "OUTSIDE_ROOT",
    });
  });

  it("allows symlinks pointing inside modelsRoot and rejects symlinks escaping it", async () => {
    const baseDir = await makeTempDir();
    const outsideDir = await makeTempDir();
    const modelsRoot = path.join(baseDir, "models");
    await fs.mkdir(modelsRoot, { recursive: true });
    const insideTarget = path.join(modelsRoot, "real.gguf");
    const outsideTarget = path.join(outsideDir, "evil.sh");
    await fs.writeFile(insideTarget, "ok");
    await fs.writeFile(outsideTarget, "#!/bin/sh\n");

    const insideLink = path.join(modelsRoot, "alias.gguf");
    const escapeLink = path.join(modelsRoot, "escape.gguf");
    const brokenLink = path.join(modelsRoot, "broken.gguf");
    await fs.symlink(insideTarget, insideLink);
    await fs.symlink(outsideTarget, escapeLink);
    await fs.symlink(path.join(modelsRoot, "does-not-exist.gguf"), brokenLink);

    const openPath = vi.fn(async () => "");
    const showItemInFolder = vi.fn();
    const storage = new LocalModelsStorage({
      platform: "darwin",
      resolveBaseDir: () => baseDir,
      openPath,
      showItemInFolder,
    });

    const realInside = await fs.realpath(insideTarget);
    expect(await storage.revealPath(insideLink)).toEqual({ ok: true });
    expect(showItemInFolder).toHaveBeenCalledExactlyOnceWith(realInside);
    expect(openPath).not.toHaveBeenCalled();

    expect(await storage.revealPath(escapeLink)).toEqual({
      ok: false,
      code: "OUTSIDE_ROOT",
    });
    expect(await storage.revealPath(brokenLink)).toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
  });

  it("returns NOT_FOUND before first download and NOT_AVAILABLE when unconfigured", async () => {
    const baseDir = await makeTempDir();
    const storage = new LocalModelsStorage({
      platform: "darwin",
      resolveBaseDir: () => baseDir,
      openPath: vi.fn(async () => ""),
      showItemInFolder: vi.fn(),
    });
    expect(await storage.openFolder()).toEqual({
      ok: false,
      code: "NOT_FOUND",
    });

    const unconfigured = new LocalModelsStorage({
      platform: "darwin",
      resolveBaseDir: () => undefined,
      openPath: vi.fn(async () => ""),
      showItemInFolder: vi.fn(),
    });
    expect(await unconfigured.openFolder()).toEqual({
      ok: false,
      code: "NOT_AVAILABLE",
    });
    expect(await unconfigured.revealPath("/tmp/model.gguf")).toEqual({
      ok: false,
      code: "NOT_AVAILABLE",
    });
  });

  it("rejects invalid paths before touching the filesystem", async () => {
    const realpath = vi.fn();
    const storage = new LocalModelsStorage({
      platform: "darwin",
      resolveBaseDir: () =>
        "/Users/alice/.simplexai/runtime/localmodels/models",
      fs: { realpath, stat: vi.fn() },
      openPath: vi.fn(async () => ""),
      showItemInFolder: vi.fn(),
    });
    expect(await storage.revealPath("")).toEqual({
      ok: false,
      code: "INVALID_PATH",
    });
    expect(await storage.revealPath("relative.gguf")).toEqual({
      ok: false,
      code: "INVALID_PATH",
    });
    expect(await storage.revealPath("/Users/alice/\0evil")).toEqual({
      ok: false,
      code: "INVALID_PATH",
    });
    expect(realpath).not.toHaveBeenCalled();
  });
});

describe("LocalModelsStorage (Windows & Linux semantics)", () => {
  it("normalizes Windows paths, strips \\\\?\\ prefix, supports custom drives, and never calls openPath on files", async () => {
    const baseDir = "D:\\program\\Linger\\runtime\\localmodels\\models";
    const modelsRoot = `${baseDir}\\models`;
    const fileTarget = `${modelsRoot}\\Qwen3.8-27B.gguf`;
    const fakeFs: LocalModelsStorageFs = {
      realpath: vi.fn(async (p: string) => {
        const clean = normalizePlatformPath(p, "win32");
        if (clean.toLowerCase() === modelsRoot.toLowerCase()) {
          return `\\\\?\\${modelsRoot}`;
        }
        if (clean.toLowerCase() === fileTarget.toLowerCase()) {
          return `\\\\?\\${fileTarget}`;
        }
        if (clean.toLowerCase().startsWith("c:\\")) {
          return clean;
        }
        const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        throw err;
      }),
      stat: vi.fn(async (p: string) => ({
        isDirectory: () => p.endsWith("\\models"),
        isFile: () => p.endsWith(".gguf"),
      })),
    };
    const openPath = vi.fn(async () => "");
    const showItemInFolder = vi.fn();
    const storage = new LocalModelsStorage({
      platform: "win32",
      resolveBaseDir: () => baseDir,
      fs: fakeFs,
      openPath,
      showItemInFolder,
    });

    expect(await storage.openFolder()).toEqual({ ok: true });
    expect(openPath).toHaveBeenCalledExactlyOnceWith(modelsRoot);

    // Mixed forward slashes from older plans still reveal with clean backslashes and no \\?\.
    expect(
      await storage.revealPath(
        "D:\\program\\Linger\\runtime\\localmodels\\models/models/Qwen3.8-27B.gguf",
      ),
    ).toEqual({ ok: true });
    expect(showItemInFolder).toHaveBeenCalledExactlyOnceWith(fileTarget);
    expect(openPath).toHaveBeenCalledOnce();

    // Cross-drive path is strictly rejected.
    expect(await storage.revealPath("C:\\Windows\\System32\\cmd.exe")).toEqual({
      ok: false,
      code: "OUTSIDE_ROOT",
    });
  });

  it("handles Linux headless sessions and xdg-open failures cleanly", async () => {
    const baseDir = "/home/alice/.simplexai/runtime/localmodels/models";
    const modelsRoot = `${baseDir}/models`;
    const modelFile = `${modelsRoot}/qwen.gguf`;
    const fakeFs: LocalModelsStorageFs = {
      realpath: vi.fn(async (p: string) => p),
      stat: vi.fn(async (p: string) => ({
        isDirectory: () => p === modelsRoot,
        isFile: () => p === modelFile,
      })),
    };

    // Headless Linux (no DISPLAY / WAYLAND_DISPLAY) returns OPEN_FAILED instead of silently no-oping.
    const showHeadless = vi.fn();
    const xdgHeadless = vi.fn(async () => {});
    const headless = new LocalModelsStorage({
      platform: "linux",
      env: {},
      resolveBaseDir: () => baseDir,
      fs: fakeFs,
      openPath: vi.fn(async () => ""),
      openWithXdg: xdgHeadless,
      showItemInFolder: showHeadless,
    });
    expect(await headless.openFolder()).toMatchObject({
      ok: false,
      code: "OPEN_FAILED",
    });
    expect(await headless.revealPath(modelFile)).toMatchObject({
      ok: false,
      code: "OPEN_FAILED",
    });
    expect(xdgHeadless).not.toHaveBeenCalled();
    expect(showHeadless).not.toHaveBeenCalled();

    // Graphical Linux with failing xdg-open surfaces OPEN_FAILED.
    const failingXdg = new LocalModelsStorage({
      platform: "linux",
      env: { DISPLAY: ":0" },
      resolveBaseDir: () => baseDir,
      fs: fakeFs,
      openPath: vi.fn(async () => ""),
      openWithXdg: vi.fn(async () => {
        throw new Error("spawn xdg-open ENOENT");
      }),
      showItemInFolder: vi.fn(),
    });
    expect(await failingXdg.openFolder()).toEqual({
      ok: false,
      code: "OPEN_FAILED",
      message: "spawn xdg-open ENOENT",
    });

    // Graphical Linux with working Wayland session succeeds via openWithXdg / showItemInFolder.
    const showWayland = vi.fn();
    const openWayland = vi.fn(async () => {});
    const wayland = new LocalModelsStorage({
      platform: "linux",
      env: { WAYLAND_DISPLAY: "wayland-0" },
      resolveBaseDir: () => baseDir,
      fs: fakeFs,
      openPath: vi.fn(async () => ""),
      openWithXdg: openWayland,
      showItemInFolder: showWayland,
    });
    expect(await wayland.openFolder()).toEqual({ ok: true });
    expect(openWayland).toHaveBeenCalledExactlyOnceWith(modelsRoot);
    expect(await wayland.revealPath(modelFile)).toEqual({ ok: true });
    expect(showWayland).toHaveBeenCalledExactlyOnceWith(modelFile);
  });
});
