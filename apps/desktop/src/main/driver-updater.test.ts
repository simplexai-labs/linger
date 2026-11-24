import {
  NVIDIA_DRIVER_DOWNLOAD_URL,
  NVIDIA_DRIVER_GUIDE_URL,
  type DesktopDriverInstallState,
} from "@linger/service-kit/nvidia-driver";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DriverUpdater,
  detectWindowsNvidiaApp,
  parseNvidiaDriverLookupResponse,
  type PendingDriverUpdateRecord,
  type WindowsDirectInstallDeps,
} from "./driver-updater.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "linger-driver-updater-"));
  tempDirs.push(dir);
  return dir;
}

function lookupJson(
  version = "621.24",
  downloadUrl = "https://us.download.nvidia.com/Windows/621.24/621.24-desktop-win10-win11-64bit-international-dch-whql.exe",
) {
  return {
    Success: "1",
    IDS: [
      {
        downloadInfo: {
          Version: version,
          IsWHQL: "1",
          IsDC: "1",
          DownloadURL: downloadUrl,
        },
      },
    ],
  };
}

function bytesResponse(body: string, status = 200): Response {
  const buf = Buffer.from(body);
  return new Response(buf, {
    status,
    headers: { "content-length": String(buf.length) },
  });
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("detectWindowsNvidiaApp", () => {
  it("prefers NVIDIA App over legacy GeForce Experience when both exist", () => {
    const present = new Set([
      "C:\\Program Files\\NVIDIA Corporation\\NVIDIA app\\NVIDIA.App.exe",
      "C:\\Program Files\\NVIDIA Corporation\\NVIDIA GeForce Experience\\NVIDIA GeForce Experience.exe",
    ]);
    const detected = detectWindowsNvidiaApp((file) => present.has(file), {
      ProgramFiles: "C:\\Program Files",
    });
    expect(detected).toEqual({
      kind: "nvidia_app",
      executable:
        "C:\\Program Files\\NVIDIA Corporation\\NVIDIA app\\NVIDIA.App.exe",
    });
  });

  it("falls back to legacy GeForce Experience when NVIDIA App is absent", () => {
    const present = new Set([
      "D:\\Apps\\NVIDIA Corporation\\NVIDIA GeForce Experience\\NVIDIA GeForce Experience.exe",
    ]);
    const detected = detectWindowsNvidiaApp((file) => present.has(file), {
      ProgramFiles: "D:\\Apps",
    });
    expect(detected).toEqual({
      kind: "geforce_experience",
      executable:
        "D:\\Apps\\NVIDIA Corporation\\NVIDIA GeForce Experience\\NVIDIA GeForce Experience.exe",
    });
  });

  it("returns none when neither app is installed", () => {
    expect(detectWindowsNvidiaApp(() => false, {})).toEqual({ kind: "none" });
  });
});

describe("parseNvidiaDriverLookupResponse", () => {
  it("accepts WHQL DCH entries hosted on NVIDIA CDN and rejects untrusted hosts", () => {
    expect(parseNvidiaDriverLookupResponse(lookupJson())).toEqual({
      version: "621.24",
      downloadUrl:
        "https://us.download.nvidia.com/Windows/621.24/621.24-desktop-win10-win11-64bit-international-dch-whql.exe",
    });
    expect(
      parseNvidiaDriverLookupResponse(
        lookupJson("621.24", "https://evil.example.com/driver.exe"),
      ),
    ).toBeUndefined();
  });
});

describe("DriverUpdater", () => {
  it("launches NVIDIA App on Windows and opens verified official URLs", async () => {
    const launched: string[] = [];
    const opened: string[] = [];
    const exe =
      "C:\\Program Files\\NVIDIA Corporation\\NVIDIA app\\NVIDIA.App.exe";
    const updater = new DriverUpdater({
      platform: "win32",
      existsSync: (file) => file === exe,
      env: { ProgramFiles: "C:\\Program Files" },
      launchExecutable: async (file) => {
        launched.push(file);
      },
      openExternal: async (url) => {
        opened.push(url);
      },
    });

    expect(updater.capabilities()).toEqual({
      platform: "win32",
      nvidiaApp: "nvidia_app",
      directInstallSupported: false,
    });
    expect(await updater.openNvidiaApp()).toEqual({ ok: true });
    expect(launched).toEqual([exe]);

    expect(await updater.openOfficialDownload()).toEqual({ ok: true });
    expect(await updater.openGuide()).toEqual({ ok: true });
    expect(opened).toEqual([
      NVIDIA_DRIVER_DOWNLOAD_URL,
      NVIDIA_DRIVER_GUIDE_URL,
    ]);
  });

  it("reports unsupported on non-Windows platforms", async () => {
    const updater = new DriverUpdater({
      platform: "linux",
      existsSync: () => true,
      env: {},
      launchExecutable: vi.fn(),
      openExternal: vi.fn(),
    });

    expect(updater.capabilities()).toEqual({
      platform: "linux",
      nvidiaApp: "none",
      directInstallSupported: false,
    });
    expect(await updater.openNvidiaApp()).toEqual({
      ok: false,
      reason: "unsupported",
    });
    expect(
      await updater.startInstall({
        gpuName: "NVIDIA GeForce RTX 5060",
        requiredCuda: "13.0",
      }),
    ).toEqual({ ok: false, reason: "unsupported" });
  });

  it("runs verified download, Authenticode check, and silent install to completion and cleans up the installer", async () => {
    const downloadDirectory = await makeTempDir();
    const states: DesktopDriverInstallState[] = [];
    const busyEvents: boolean[] = [];
    let pending: PendingDriverUpdateRecord | undefined;
    let verifiedPath = "";
    let installedPath = "";

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("AjaxDriverService.php")) {
        expect(url).toContain("psid=131");
        expect(url).toContain("pfid=1078");
        return new Response(JSON.stringify(lookupJson("621.24")), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return bytesResponse("signed-nvidia-installer-bytes");
    });

    const updater = new DriverUpdater({
      platform: "win32",
      arch: "x64",
      existsSync: () => false,
      env: {},
      launchExecutable: vi.fn(),
      openExternal: vi.fn(),
      onStateChange: (state) => states.push(state),
      onBusyChange: (busy) => busyEvents.push(busy),
      directInstall: {
        downloadDirectory,
        fetch: fetchMock as typeof fetch,
        detectGpuName: vi.fn(async () => "NVIDIA GeForce RTX 5060"),
        verifyAuthenticode: vi.fn(async (exePath) => {
          verifiedPath = exePath;
          expect(existsSync(exePath)).toBe(true);
          return { valid: true, subject: "CN=NVIDIA Corporation" };
        }),
        runInstaller: vi.fn(async (exePath: string) => {
          installedPath = exePath;
          return { outcome: "completed" as const };
        }),
        readPendingUpdate: () => pending,
        writePendingUpdate: (record) => {
          pending = record;
        },
      },
    });

    expect(updater.capabilities().directInstallSupported).toBe(true);
    expect(
      await updater.startInstall({
        gpuName: "NVIDIA GeForce RTX 5060",
        requiredCuda: "13.0",
        resumeModelId: "inkling-2-mini-q3-poly:UD-Q3_K_XL",
      }),
    ).toEqual({ ok: true });

    await updater.waitForIdle();

    expect(verifiedPath).toBe(installedPath);
    expect(existsSync(verifiedPath)).toBe(false);
    expect(await readdir(downloadDirectory)).toEqual([]);
    expect(pending).toBeUndefined();
    expect(updater.installState()).toEqual({
      phase: "completed",
      version: "621.24",
      resumeModelId: "inkling-2-mini-q3-poly:UD-Q3_K_XL",
    });
    expect(states.map((s) => s.phase)).toEqual([
      "downloading",
      "downloading",
      "verifying",
      "installing",
      "completed",
    ]);
    expect(busyEvents.at(0)).toBe(true);
    expect(busyEvents.at(-1)).toBe(false);
  });

  it("persists pendingDriverUpdate on reboot_required and transitions to completed after reboot", async () => {
    const downloadDirectory = await makeTempDir();
    let pending: PendingDriverUpdateRecord | undefined;
    const installTimeMs = Date.parse("2026-11-24T12:00:00.000Z");

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("AjaxDriverService.php")) {
        expect(url).toContain("psid=133");
        expect(url).toContain("pfid=1079");
        return new Response(
          JSON.stringify(
            lookupJson(
              "621.24",
              "https://us.download.nvidia.com/Windows/621.24/621.24-notebook-win10-win11-64bit-international-dch-whql.exe",
            ),
          ),
          { status: 200 },
        );
      }
      return bytesResponse("notebook-driver-payload");
    });

    const baseDirect: WindowsDirectInstallDeps = {
      downloadDirectory,
      fetch: fetchMock as typeof fetch,
      detectGpuName: vi.fn(async () => undefined),
      verifyAuthenticode: vi.fn(async () => ({
        valid: true,
        subject: "CN=NVIDIA Corporation",
      })),
      runInstaller: vi.fn(async () => ({
        outcome: "reboot_required" as const,
      })),
      readPendingUpdate: () => pending,
      writePendingUpdate: (record) => {
        pending = record;
      },
      now: () => installTimeMs,
      systemUptimeSeconds: () => 3600,
    };

    const updater = new DriverUpdater({
      platform: "win32",
      arch: "x64",
      existsSync: () => false,
      env: {},
      launchExecutable: vi.fn(),
      openExternal: vi.fn(),
      directInstall: baseDirect,
    });

    expect(
      await updater.startInstall({
        gpuName: "NVIDIA GeForce RTX 5060 Laptop GPU",
        requiredCuda: "13.0",
        resumeModelId: "inkling-2-mini-q3-poly:UD-Q3_K_XL",
      }),
    ).toEqual({ ok: true });
    await updater.waitForIdle();

    expect(updater.installState()).toEqual({
      phase: "reboot_required",
      version: "621.24",
      resumeModelId: "inkling-2-mini-q3-poly:UD-Q3_K_XL",
    });
    expect(pending).toEqual({
      targetVersion: "621.24",
      resumeModelId: "inkling-2-mini-q3-poly:UD-Q3_K_XL",
      updatedAt: "2026-11-24T12:00:00.000Z",
    });

    // App restart BEFORE Windows reboots still shows reboot_required.
    const beforeReboot = new DriverUpdater({
      platform: "win32",
      arch: "x64",
      existsSync: () => false,
      env: {},
      launchExecutable: vi.fn(),
      openExternal: vi.fn(),
      directInstall: {
        ...baseDirect,
        now: () => installTimeMs + 5 * 60_000,
        systemUptimeSeconds: () => 3900,
      },
    });
    expect(beforeReboot.installState()).toEqual({
      phase: "reboot_required",
      version: "621.24",
      resumeModelId: "inkling-2-mini-q3-poly:UD-Q3_K_XL",
    });

    // App launch AFTER Windows reboots (uptime 60s < 5 min since install) marks completed.
    const afterReboot = new DriverUpdater({
      platform: "win32",
      arch: "x64",
      existsSync: () => false,
      env: {},
      launchExecutable: vi.fn(),
      openExternal: vi.fn(),
      directInstall: {
        ...baseDirect,
        now: () => installTimeMs + 5 * 60_000,
        systemUptimeSeconds: () => 60,
      },
    });
    expect(afterReboot.installState()).toEqual({
      phase: "completed",
      version: "621.24",
      resumeModelId: "inkling-2-mini-q3-poly:UD-Q3_K_XL",
    });

    afterReboot.clearInstallState();
    expect(afterReboot.installState()).toEqual({ phase: "idle" });
    expect(pending).toBeUndefined();
  });

  it("deletes the downloaded binary and refuses execution when Authenticode signature fails", async () => {
    const downloadDirectory = await makeTempDir();
    const runInstaller = vi.fn();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("AjaxDriverService.php")) {
        return new Response(JSON.stringify(lookupJson("621.24")), {
          status: 200,
        });
      }
      return bytesResponse("tampered-binary");
    });

    const updater = new DriverUpdater({
      platform: "win32",
      arch: "x64",
      existsSync: () => false,
      env: {},
      launchExecutable: vi.fn(),
      openExternal: vi.fn(),
      directInstall: {
        downloadDirectory,
        fetch: fetchMock as typeof fetch,
        detectGpuName: vi.fn(async () => "NVIDIA GeForce RTX 5060"),
        verifyAuthenticode: vi.fn(async () => ({
          valid: false,
          subject: "CN=Untrusted",
        })),
        runInstaller,
        readPendingUpdate: () => undefined,
        writePendingUpdate: vi.fn(),
      },
    });

    expect(
      await updater.startInstall({
        gpuName: "NVIDIA GeForce RTX 5060",
        requiredCuda: "13.0",
      }),
    ).toEqual({ ok: true });
    await updater.waitForIdle();

    expect(runInstaller).not.toHaveBeenCalled();
    expect(await readdir(downloadDirectory)).toEqual([]);
    expect(updater.installState()).toEqual({
      phase: "failed",
      code: "SIGNATURE_INVALID",
    });
  });

  it("rejects redirects off NVIDIA CDN, versions below requiredDriver, non-RTX GPUs, and UAC cancellation", async () => {
    const downloadDirectory = await makeTempDir();

    // 1. Redirect off NVIDIA CDN fails cleanly without executing anything.
    const redirectFetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("AjaxDriverService.php")) {
        return new Response(JSON.stringify(lookupJson("621.24")), {
          status: 200,
        });
      }
      return new Response(null, {
        status: 302,
        headers: { location: "https://mirror.untrusted.example/driver.exe" },
      });
    });
    const redirectUpdater = new DriverUpdater({
      platform: "win32",
      arch: "x64",
      existsSync: () => false,
      env: {},
      launchExecutable: vi.fn(),
      openExternal: vi.fn(),
      directInstall: {
        downloadDirectory,
        fetch: redirectFetch as typeof fetch,
        detectGpuName: vi.fn(async () => "NVIDIA GeForce RTX 5060"),
        verifyAuthenticode: vi.fn(),
        runInstaller: vi.fn(),
        readPendingUpdate: () => undefined,
        writePendingUpdate: vi.fn(),
      },
    });
    await redirectUpdater.startInstall({
      gpuName: "NVIDIA GeForce RTX 5060",
      requiredCuda: "13.0",
    });
    await redirectUpdater.waitForIdle();
    expect(redirectUpdater.installState()).toEqual({
      phase: "failed",
      code: "DOWNLOAD_FAILED",
    });

    // 2. Driver older than requiredDriver is rejected before downloading.
    const oldFetch = vi.fn(
      async () =>
        new Response(JSON.stringify(lookupJson("572.83")), { status: 200 }),
    );
    const oldUpdater = new DriverUpdater({
      platform: "win32",
      arch: "x64",
      existsSync: () => false,
      env: {},
      launchExecutable: vi.fn(),
      openExternal: vi.fn(),
      directInstall: {
        downloadDirectory,
        fetch: oldFetch as typeof fetch,
        detectGpuName: vi.fn(async () => "NVIDIA GeForce RTX 5060"),
        verifyAuthenticode: vi.fn(),
        runInstaller: vi.fn(),
        readPendingUpdate: () => undefined,
        writePendingUpdate: vi.fn(),
      },
    });
    await oldUpdater.startInstall({
      gpuName: "NVIDIA GeForce RTX 5060",
      requiredCuda: "13.0",
    });
    await oldUpdater.waitForIdle();
    expect(oldUpdater.installState()).toEqual({
      phase: "failed",
      code: "VERSION_TOO_OLD",
    });

    // 3. Enterprise Quadro / RTX Ada returns unsupported cleanly.
    expect(
      await oldUpdater.startInstall({
        gpuName: "NVIDIA RTX 6000 Ada Generation",
        requiredCuda: "13.0",
      }),
    ).toEqual({ ok: false, reason: "unsupported" });
    expect(oldUpdater.installState()).toEqual({
      phase: "failed",
      code: "UNSUPPORTED_GPU",
    });

    // 4. UAC cancellation maps to UAC_CANCELLED.
    const uacFetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("AjaxDriverService.php")) {
        return new Response(JSON.stringify(lookupJson("621.24")), {
          status: 200,
        });
      }
      return bytesResponse("valid-installer");
    });
    const uacUpdater = new DriverUpdater({
      platform: "win32",
      arch: "x64",
      existsSync: () => false,
      env: {},
      launchExecutable: vi.fn(),
      openExternal: vi.fn(),
      directInstall: {
        downloadDirectory,
        fetch: uacFetch as typeof fetch,
        detectGpuName: vi.fn(async () => "NVIDIA GeForce RTX 5060"),
        verifyAuthenticode: vi.fn(async () => ({
          valid: true,
          subject: "CN=NVIDIA Corporation",
        })),
        runInstaller: vi.fn(async () => ({
          outcome: "uac_cancelled" as const,
        })),
        readPendingUpdate: () => undefined,
        writePendingUpdate: vi.fn(),
      },
    });
    await uacUpdater.startInstall({
      gpuName: "NVIDIA GeForce RTX 5060",
      requiredCuda: "13.0",
    });
    await uacUpdater.waitForIdle();
    expect(uacUpdater.installState()).toEqual({
      phase: "failed",
      code: "UAC_CANCELLED",
    });
  });

  it("transitions cleanly to DOWNLOAD_FAILED without unhandled rejection when downloadDirectory cannot be created", async () => {
    const tempDir = await makeTempDir();
    const blockingFile = path.join(tempDir, "not-a-directory");
    await writeFile(blockingFile, "occupied");
    const busyEvents: boolean[] = [];

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("AjaxDriverService.php")) {
        return new Response(JSON.stringify(lookupJson("621.24")), {
          status: 200,
        });
      }
      return bytesResponse("installer-bytes");
    });

    const updater = new DriverUpdater({
      platform: "win32",
      arch: "x64",
      existsSync: () => false,
      env: {},
      launchExecutable: vi.fn(),
      openExternal: vi.fn(),
      onBusyChange: (busy) => busyEvents.push(busy),
      directInstall: {
        downloadDirectory: path.join(blockingFile, "nested"),
        fetch: fetchMock as typeof fetch,
        detectGpuName: vi.fn(async () => "NVIDIA GeForce RTX 5060"),
        verifyAuthenticode: vi.fn(),
        runInstaller: vi.fn(),
        readPendingUpdate: () => undefined,
        writePendingUpdate: vi.fn(),
      },
    });

    expect(
      await updater.startInstall({
        gpuName: "NVIDIA GeForce RTX 5060",
        requiredCuda: "13.0",
      }),
    ).toEqual({ ok: true });
    await expect(updater.waitForIdle()).resolves.toBeUndefined();
    expect(updater.installState()).toEqual({
      phase: "failed",
      code: "DOWNLOAD_FAILED",
    });
    expect(busyEvents.at(-1)).toBe(false);
  });

  it("returns busy for concurrent startInstall calls while GPU detection is in flight", async () => {
    const downloadDirectory = await makeTempDir();
    let resolveGpu!: (value: string | undefined) => void;
    const detectGpuName = vi.fn(
      () =>
        new Promise<string | undefined>((resolve) => {
          resolveGpu = resolve;
        }),
    );
    const runInstaller = vi.fn(async () => ({ outcome: "completed" as const }));
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("AjaxDriverService.php")) {
        return new Response(JSON.stringify(lookupJson("621.24")), {
          status: 200,
        });
      }
      return bytesResponse("installer-bytes");
    });

    const updater = new DriverUpdater({
      platform: "win32",
      arch: "x64",
      existsSync: () => false,
      env: {},
      launchExecutable: vi.fn(),
      openExternal: vi.fn(),
      directInstall: {
        downloadDirectory,
        fetch: fetchMock as typeof fetch,
        detectGpuName,
        verifyAuthenticode: vi.fn(async () => ({
          valid: true,
          subject: "CN=NVIDIA Corporation",
        })),
        runInstaller,
        readPendingUpdate: () => undefined,
        writePendingUpdate: vi.fn(),
      },
    });

    const first = updater.startInstall({ requiredCuda: "13.0" });
    const second = await updater.startInstall({ requiredCuda: "13.0" });
    expect(second).toEqual({ ok: false, reason: "busy" });

    resolveGpu("NVIDIA GeForce RTX 5060");
    expect(await first).toEqual({ ok: true });
    await updater.waitForIdle();
    expect(detectGpuName).toHaveBeenCalledOnce();
    expect(runInstaller).toHaveBeenCalledOnce();
  });
});
