import {
  NVIDIA_DRIVER_DOWNLOAD_URL,
  NVIDIA_DRIVER_GUIDE_URL,
  classifyWindowsNvidiaGpu,
  compareDriverVersions,
  isAllowedNvidiaDownloadUrl,
  minNvidiaDriverForCuda,
  type DesktopDriverActionResult,
  type DesktopDriverCapabilities,
  type DesktopDriverFailureCode,
  type DesktopDriverInstallRequest,
  type DesktopDriverInstallState,
  type DesktopNvidiaAppKind,
} from "@linger/service-kit/nvidia-driver";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface DetectedWindowsNvidiaApp {
  readonly kind: DesktopNvidiaAppKind;
  readonly executable?: string;
}

export interface PendingDriverUpdateRecord {
  readonly targetVersion: string;
  readonly resumeModelId?: string;
  readonly updatedAt: string;
}

export interface AuthenticodeCheckResult {
  readonly valid: boolean;
  readonly subject?: string;
}

export type WindowsInstallerRunResult =
  | { readonly outcome: "completed" }
  | { readonly outcome: "reboot_required" }
  | { readonly outcome: "uac_cancelled" }
  | { readonly outcome: "failed"; readonly exitCode?: number };

export interface ResolvedNvidiaDriverPackage {
  readonly version: string;
  readonly downloadUrl: string;
}

export interface WindowsDirectInstallDeps {
  readonly downloadDirectory: string;
  readonly fetch?: typeof fetch;
  readonly detectGpuName: () => Promise<string | undefined>;
  readonly verifyAuthenticode: (
    exePath: string,
  ) => Promise<AuthenticodeCheckResult>;
  readonly runInstaller: (
    exePath: string,
  ) => Promise<WindowsInstallerRunResult>;
  readonly readPendingUpdate: () => PendingDriverUpdateRecord | undefined;
  readonly writePendingUpdate: (
    record: PendingDriverUpdateRecord | undefined,
  ) => void;
  readonly now?: () => number;
  readonly systemUptimeSeconds?: () => number;
}

export interface DriverUpdaterOptions {
  readonly platform: "darwin" | "win32" | "linux";
  readonly arch?: string;
  readonly existsSync: (filePath: string) => boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly launchExecutable: (executablePath: string) => Promise<void>;
  readonly openExternal: (url: string) => Promise<void>;
  readonly directInstall?: WindowsDirectInstallDeps;
  readonly onStateChange?: (state: DesktopDriverInstallState) => void;
  readonly onBusyChange?: (busy: boolean) => void;
}

const WINDOWS_NVIDIA_APP_CANDIDATES: readonly {
  readonly kind: Exclude<DesktopNvidiaAppKind, "none">;
  readonly relativePath: readonly string[];
}[] = [
  {
    kind: "nvidia_app",
    relativePath: ["NVIDIA Corporation", "NVIDIA app", "NVIDIA.App.exe"],
  },
  {
    kind: "geforce_experience",
    relativePath: [
      "NVIDIA Corporation",
      "NVIDIA GeForce Experience",
      "NVIDIA GeForce Experience.exe",
    ],
  },
];

// Official NVIDIA DriverManualLookup endpoint serving unified Windows 10/11
// 64-bit GeForce RTX DCH WHQL packages for desktop (psid=131, pfid=1078) and
// notebook (psid=133, pfid=1079) GPUs.
const NVIDIA_AJAX_LOOKUP_BASE =
  "https://gfwsl.geforce.com/services_toolkit/services/com/nvidia/services/AjaxDriverService.php";
const GEFORCE_RTX_LOOKUP_PARAMS: Readonly<
  Record<
    "desktop" | "notebook",
    { readonly psid: string; readonly pfid: string }
  >
> = {
  desktop: { psid: "131", pfid: "1078" },
  notebook: { psid: "133", pfid: "1079" },
};
const MAX_INSTALLER_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const PENDING_UPDATE_MAX_AGE_MS = 72 * 60 * 60_000;
const PROGRESS_EMIT_INTERVAL_MS = 200;
const PROGRESS_EMIT_BYTE_STEP = 1024 * 1024;

function windowsProgramRoots(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const roots = [
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
    "C:\\Program Files",
    "C:\\Program Files (x86)",
  ];
  const unique: string[] = [];
  for (const root of roots) {
    const trimmed = root?.trim();
    if (trimmed && !unique.includes(trimmed)) unique.push(trimmed);
  }
  return unique;
}

/**
 * Finds an installed NVIDIA companion app on Windows from standard Program
 * Files locations without executing external binaries.
 */
export function detectWindowsNvidiaApp(
  existsSync: (filePath: string) => boolean,
  env: Readonly<Record<string, string | undefined>>,
): DetectedWindowsNvidiaApp {
  const roots = windowsProgramRoots(env);
  for (const candidate of WINDOWS_NVIDIA_APP_CANDIDATES) {
    for (const root of roots) {
      const executable = path.win32.join(root, ...candidate.relativePath);
      if (existsSync(executable)) {
        return { kind: candidate.kind, executable };
      }
    }
  }
  return { kind: "none" };
}

/**
 * Parses NVIDIA's `AjaxDriverService.php` JSON response and extracts a WHQL DCH
 * package whose download URL is pinned to NVIDIA's official CDN allowlist.
 */
export function parseNvidiaDriverLookupResponse(
  payload: unknown,
): ResolvedNvidiaDriverPackage | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const root = payload as { Success?: unknown; IDS?: unknown };
  if (root.Success !== "1" || !Array.isArray(root.IDS)) return undefined;
  for (const entry of root.IDS) {
    if (!entry || typeof entry !== "object") continue;
    const info = (entry as { downloadInfo?: unknown }).downloadInfo;
    if (!info || typeof info !== "object") continue;
    const record = info as Record<string, unknown>;
    if (record.IsWHQL !== "1" || record.IsDC !== "1") continue;
    const version =
      typeof record.Version === "string" ? record.Version.trim() : "";
    const downloadUrl =
      typeof record.DownloadURL === "string" ? record.DownloadURL.trim() : "";
    if (!/^\d+(?:\.\d+){1,2}$/.test(version)) continue;
    if (!isAllowedNvidiaDownloadUrl(downloadUrl)) continue;
    return { version, downloadUrl };
  }
  return undefined;
}

export interface DriverUpdaterHost {
  capabilities(): DesktopDriverCapabilities;
  openNvidiaApp(): Promise<DesktopDriverActionResult>;
  openOfficialDownload(): Promise<DesktopDriverActionResult>;
  openGuide(): Promise<DesktopDriverActionResult>;
  installState(): DesktopDriverInstallState;
  startInstall(
    request: DesktopDriverInstallRequest,
  ): Promise<DesktopDriverActionResult>;
  clearInstallState(): void;
}

function isActivePhase(state: DesktopDriverInstallState): boolean {
  return (
    state.phase === "downloading" ||
    state.phase === "verifying" ||
    state.phase === "installing"
  );
}

/**
 * Coordinates native OS driver-update actions for both the Setup window and
 * the Local models SPA via IPC. On Windows x64, supports downloading the
 * official GeForce RTX DCH WHQL installer, verifying NVIDIA's Authenticode
 * signature, running an elevated non-rebooting silent install, and resuming
 * after a Windows restart.
 */
export class DriverUpdater implements DriverUpdaterHost {
  readonly #options: DriverUpdaterOptions;
  #state: DesktopDriverInstallState = { phase: "idle" };
  #starting = false;
  #activeRun: Promise<void> | undefined;

  constructor(options: DriverUpdaterOptions) {
    this.#options = options;
    this.#hydratePendingUpdate();
  }

  #supportsDirectInstall(): boolean {
    return (
      this.#options.platform === "win32" &&
      (this.#options.arch ?? "x64") === "x64" &&
      Boolean(this.#options.directInstall)
    );
  }

  #detectedWindowsApp(): DetectedWindowsNvidiaApp {
    if (this.#options.platform !== "win32") return { kind: "none" };
    return detectWindowsNvidiaApp(this.#options.existsSync, this.#options.env);
  }

  capabilities(): DesktopDriverCapabilities {
    return {
      platform: this.#options.platform,
      nvidiaApp: this.#detectedWindowsApp().kind,
      directInstallSupported: this.#supportsDirectInstall(),
    };
  }

  async openNvidiaApp(): Promise<DesktopDriverActionResult> {
    if (this.#options.platform !== "win32") {
      return { ok: false, reason: "unsupported" };
    }
    const detected = this.#detectedWindowsApp();
    if (!detected.executable) {
      return { ok: false, reason: "not_installed" };
    }
    try {
      await this.#options.launchExecutable(detected.executable);
      return { ok: true };
    } catch {
      return { ok: false, reason: "failed" };
    }
  }

  async openOfficialDownload(): Promise<DesktopDriverActionResult> {
    try {
      await this.#options.openExternal(NVIDIA_DRIVER_DOWNLOAD_URL);
      return { ok: true };
    } catch {
      return { ok: false, reason: "failed" };
    }
  }

  async openGuide(): Promise<DesktopDriverActionResult> {
    try {
      await this.#options.openExternal(NVIDIA_DRIVER_GUIDE_URL);
      return { ok: true };
    } catch {
      return { ok: false, reason: "failed" };
    }
  }

  installState(): DesktopDriverInstallState {
    return this.#state;
  }

  clearInstallState(): void {
    if (this.#starting || this.#activeRun) return;
    this.#options.directInstall?.writePendingUpdate(undefined);
    this.#setState({ phase: "idle" });
  }

  async startInstall(
    request: DesktopDriverInstallRequest,
  ): Promise<DesktopDriverActionResult> {
    if (!this.#supportsDirectInstall()) {
      return { ok: false, reason: "unsupported" };
    }
    if (this.#starting || this.#activeRun) {
      return { ok: false, reason: "busy" };
    }
    const direct = this.#options.directInstall!;
    this.#starting = true;
    let gpuName: string | undefined;
    try {
      gpuName = request.gpuName?.trim() || (await direct.detectGpuName());
    } catch {
      this.#starting = false;
      this.#fail("UNSUPPORTED_GPU");
      return { ok: false, reason: "unsupported" };
    }
    const gpuKind = classifyWindowsNvidiaGpu(gpuName);
    if (gpuKind === "unsupported") {
      this.#starting = false;
      this.#fail("UNSUPPORTED_GPU");
      return { ok: false, reason: "unsupported" };
    }

    const requiredDriver = minNvidiaDriverForCuda(request.requiredCuda);
    this.#activeRun = this.#runDirectInstall(
      direct,
      gpuKind,
      requiredDriver,
      request,
    ).finally(() => {
      this.#activeRun = undefined;
      this.#options.onBusyChange?.(false);
    });
    this.#starting = false;
    this.#options.onBusyChange?.(true);
    return { ok: true };
  }

  /** Wait for an active installation pipeline to settle (used by tests). */
  waitForIdle(): Promise<void> {
    return this.#activeRun ?? Promise.resolve();
  }

  #hydratePendingUpdate(): void {
    const direct = this.#options.directInstall;
    if (!direct || this.#options.platform !== "win32") return;
    const pending = direct.readPendingUpdate();
    if (!pending) return;
    const updatedMs = Date.parse(pending.updatedAt);
    const nowMs = (direct.now ?? Date.now)();
    if (
      !Number.isFinite(updatedMs) ||
      nowMs - updatedMs > PENDING_UPDATE_MAX_AGE_MS
    ) {
      direct.writePendingUpdate(undefined);
      return;
    }
    const uptimeSec = direct.systemUptimeSeconds?.();
    const rebooted =
      typeof uptimeSec === "number" &&
      Number.isFinite(uptimeSec) &&
      nowMs - uptimeSec * 1000 > updatedMs;
    this.#state = rebooted
      ? {
          phase: "completed",
          version: pending.targetVersion,
          ...(pending.resumeModelId
            ? { resumeModelId: pending.resumeModelId }
            : {}),
        }
      : {
          phase: "reboot_required",
          version: pending.targetVersion,
          ...(pending.resumeModelId
            ? { resumeModelId: pending.resumeModelId }
            : {}),
        };
  }

  async #runDirectInstall(
    direct: WindowsDirectInstallDeps,
    gpuKind: "desktop" | "notebook",
    requiredDriver: string | undefined,
    request: DesktopDriverInstallRequest,
  ): Promise<void> {
    let exePath: string | undefined;
    try {
      const fetchImpl = direct.fetch ?? fetch;
      const pkg = await this.#lookupPackage(gpuKind, fetchImpl);
      if (!pkg) {
        this.#fail("LOOKUP_FAILED");
        return;
      }
      if (
        requiredDriver &&
        compareDriverVersions(pkg.version, requiredDriver) < 0
      ) {
        this.#fail("VERSION_TOO_OLD");
        return;
      }

      const nonce = randomBytes(6).toString("hex");
      const fileName = `nvidia-${pkg.version}-${gpuKind}-${nonce}.exe`;
      exePath = path.join(direct.downloadDirectory, fileName);
      const downloaded = await this.#downloadInstaller(
        pkg.downloadUrl,
        exePath,
        pkg.version,
        fetchImpl,
      );
      if (!downloaded) {
        this.#fail("DOWNLOAD_FAILED");
        return;
      }

      this.#setState({ phase: "verifying", version: pkg.version });
      const signature = await direct.verifyAuthenticode(exePath);
      if (!signature.valid) {
        this.#fail("SIGNATURE_INVALID");
        return;
      }

      this.#setState({ phase: "installing", version: pkg.version });
      const result = await direct.runInstaller(exePath);
      if (result.outcome === "completed") {
        direct.writePendingUpdate(undefined);
        this.#setState({
          phase: "completed",
          version: pkg.version,
          ...(request.resumeModelId
            ? { resumeModelId: request.resumeModelId }
            : {}),
        });
        return;
      }
      if (result.outcome === "reboot_required") {
        const nowIso = new Date((direct.now ?? Date.now)()).toISOString();
        direct.writePendingUpdate({
          targetVersion: pkg.version,
          ...(request.resumeModelId
            ? { resumeModelId: request.resumeModelId }
            : {}),
          updatedAt: nowIso,
        });
        this.#setState({
          phase: "reboot_required",
          version: pkg.version,
          ...(request.resumeModelId
            ? { resumeModelId: request.resumeModelId }
            : {}),
        });
        return;
      }
      if (result.outcome === "uac_cancelled") {
        this.#fail("UAC_CANCELLED");
        return;
      }
      this.#fail("INSTALL_FAILED");
    } catch {
      this.#fail("INSTALL_FAILED");
    } finally {
      if (exePath) {
        await rm(exePath, { force: true }).catch(() => undefined);
      }
    }
  }

  async #lookupPackage(
    gpuKind: "desktop" | "notebook",
    fetchImpl: typeof fetch,
  ): Promise<ResolvedNvidiaDriverPackage | undefined> {
    const ids = GEFORCE_RTX_LOOKUP_PARAMS[gpuKind];
    const url = new URL(NVIDIA_AJAX_LOOKUP_BASE);
    url.searchParams.set("func", "DriverManualLookup");
    url.searchParams.set("psid", ids.psid);
    url.searchParams.set("pfid", ids.pfid);
    url.searchParams.set("osID", "57");
    url.searchParams.set("languageCode", "1033");
    url.searchParams.set("beta", "0");
    url.searchParams.set("isWHQL", "1");
    url.searchParams.set("dch", "1");
    url.searchParams.set("sort1", "0");
    url.searchParams.set("numberOfResults", "1");

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetchImpl(url.toString(), {
          redirect: "manual",
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) continue;
        const json: unknown = await response.json();
        const parsed = parseNvidiaDriverLookupResponse(json);
        if (parsed) return parsed;
      } catch {
        // Retry once on transient TLS or network drops.
      }
    }
    return undefined;
  }

  async #downloadInstaller(
    initialUrl: string,
    destPath: string,
    version: string,
    fetchImpl: typeof fetch,
  ): Promise<boolean> {
    if (!isAllowedNvidiaDownloadUrl(initialUrl)) return false;
    const partPath = `${destPath}.part`;

    try {
      await mkdir(path.dirname(destPath), { recursive: true, mode: 0o700 });
      await rm(partPath, { force: true }).catch(() => undefined);

      const response = await this.#fetchFollowingAllowedRedirects(
        initialUrl,
        fetchImpl,
      );
      if (!response || !response.ok || !response.body) return false;

      const rawLength = response.headers.get("content-length");
      const parsedLength =
        rawLength && /^\d+$/.test(rawLength.trim())
          ? Number.parseInt(rawLength.trim(), 10)
          : undefined;
      if (parsedLength !== undefined && parsedLength > MAX_INSTALLER_BYTES) {
        return false;
      }

      let completedBytes = 0;
      let lastEmittedAt = 0;
      let lastEmittedBytes = 0;
      const emitProgress = (force: boolean): void => {
        const now = Date.now();
        if (
          !force &&
          now - lastEmittedAt < PROGRESS_EMIT_INTERVAL_MS &&
          completedBytes - lastEmittedBytes < PROGRESS_EMIT_BYTE_STEP
        ) {
          return;
        }
        lastEmittedAt = now;
        lastEmittedBytes = completedBytes;
        this.#setState({
          phase: "downloading",
          version,
          completedBytes,
          ...(parsedLength !== undefined ? { totalBytes: parsedLength } : {}),
        });
      };

      emitProgress(true);
      const source = Readable.fromWeb(response.body as never);
      async function* meter(chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          completedBytes += chunk.length;
          if (completedBytes > MAX_INSTALLER_BYTES) {
            throw new Error("Installer exceeded maximum allowed size");
          }
          emitProgress(false);
          yield chunk;
        }
      }

      await pipeline(
        source,
        meter,
        createWriteStream(partPath, { flags: "wx", mode: 0o600 }),
      );
      if (parsedLength !== undefined && completedBytes !== parsedLength) {
        await rm(partPath, { force: true }).catch(() => undefined);
        return false;
      }
      if (completedBytes === 0) {
        await rm(partPath, { force: true }).catch(() => undefined);
        return false;
      }
      emitProgress(true);
      await rename(partPath, destPath);
      return true;
    } catch {
      await rm(partPath, { force: true }).catch(() => undefined);
      await rm(destPath, { force: true }).catch(() => undefined);
      return false;
    }
  }

  async #fetchFollowingAllowedRedirects(
    initialUrl: string,
    fetchImpl: typeof fetch,
  ): Promise<Response | undefined> {
    let current = initialUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!isAllowedNvidiaDownloadUrl(current)) return undefined;
      const response = await fetchImpl(current, { redirect: "manual" });
      if (
        response.status === 301 ||
        response.status === 302 ||
        response.status === 303 ||
        response.status === 307 ||
        response.status === 308
      ) {
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get("location");
        if (!location) return undefined;
        current = new URL(location, current).toString();
        continue;
      }
      return response;
    }
    return undefined;
  }

  #fail(code: DesktopDriverFailureCode): void {
    this.#setState({ phase: "failed", code });
  }

  #setState(state: DesktopDriverInstallState): void {
    const wasActive = isActivePhase(this.#state);
    this.#state = state;
    const nowActive = isActivePhase(state);
    if (wasActive !== nowActive) {
      this.#options.onBusyChange?.(nowActive);
    }
    this.#options.onStateChange?.(state);
  }
}
