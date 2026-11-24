/** Official NVIDIA driver download portal. */
export const NVIDIA_DRIVER_DOWNLOAD_URL =
  "https://www.nvidia.com/Download/index.aspx";

/** Linger documentation guide for updating the NVIDIA display driver. */
export const NVIDIA_DRIVER_GUIDE_URL =
  "https://docs.heylinger.com/install/nvidia-driver";

/** Command that prints the active NVIDIA driver and maximum supported CUDA version. */
export const NVIDIA_SMI_VERIFY_COMMAND = "nvidia-smi";

/** Allowlisted official NVIDIA CDN hosts for verified direct driver downloads. */
export const NVIDIA_DOWNLOAD_HOSTS: readonly string[] = [
  "us.download.nvidia.com",
  "international.download.nvidia.com",
  "cn.download.nvidia.com",
  "uk.download.nvidia.com",
  "de.download.nvidia.com",
  "download.nvidia.com",
];

/**
 * Minimum NVIDIA display driver branch supporting each CUDA minor version
 * (NVIDIA CUDA Compatibility Table). Unmapped versions return undefined rather
 * than guessing a driver branch.
 */
const MIN_DRIVER_BY_CUDA: Readonly<Record<string, string>> = {
  "12.4": "550",
  "12.6": "560",
  "12.8": "570",
  "12.9": "575",
  "13.0": "580",
  "13.1": "580",
};

export type DesktopNvidiaAppKind = "nvidia_app" | "geforce_experience" | "none";

export type WindowsNvidiaGpuKind = "desktop" | "notebook" | "unsupported";

export type DesktopDriverFailureCode =
  | "UNSUPPORTED_GPU"
  | "LOOKUP_FAILED"
  | "VERSION_TOO_OLD"
  | "DOWNLOAD_FAILED"
  | "SIGNATURE_INVALID"
  | "UAC_CANCELLED"
  | "INSTALL_FAILED";

export interface DesktopDriverCapabilities {
  readonly platform: "darwin" | "win32" | "linux";
  /** Detected NVIDIA companion app on Windows. */
  readonly nvidiaApp: DesktopNvidiaAppKind;
  /** True when signed one-click Windows driver installation is available on this host. */
  readonly directInstallSupported: boolean;
}

export type DesktopDriverActionResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "not_installed" | "unsupported" | "busy" | "failed";
    };

export interface DesktopDriverInstallRequest {
  readonly gpuName?: string;
  readonly requiredCuda?: string;
  readonly resumeModelId?: string;
}

export type DesktopDriverInstallState =
  | { readonly phase: "idle" }
  | {
      readonly phase: "downloading";
      readonly version: string;
      readonly completedBytes: number;
      readonly totalBytes?: number;
    }
  | { readonly phase: "verifying"; readonly version: string }
  | { readonly phase: "installing"; readonly version: string }
  | {
      readonly phase: "reboot_required";
      readonly version: string;
      readonly resumeModelId?: string;
    }
  | {
      readonly phase: "completed";
      readonly version: string;
      readonly resumeModelId?: string;
    }
  | { readonly phase: "failed"; readonly code: string };

export type LinuxNvidiaDistro = "ubuntu" | "fedora";

/**
 * Accepts only standard-port HTTPS installer URLs hosted directly on NVIDIA's
 * official CDN allowlist, without embedded credentials.
 */
export function isAllowedNvidiaDownloadUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.port) return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  if (!NVIDIA_DOWNLOAD_HOSTS.includes(host)) return false;
  return parsed.pathname.toLowerCase().endsWith(".exe");
}

/**
 * Classifies a Windows GPU display name for unified GeForce RTX DCH WHQL
 * direct installation. Enterprise/Workstation (Quadro, RTX PRO, Tesla) and
 * older legacy cards return `"unsupported"` so the UI guides them to NVIDIA's
 * official driver portal instead of guessing a package branch.
 */
export function classifyWindowsNvidiaGpu(
  gpuName: string | null | undefined,
): WindowsNvidiaGpuKind {
  const normalized = (gpuName ?? "").trim();
  if (!normalized) return "unsupported";
  if (!/\bgeforce\s+rtx\b/i.test(normalized)) return "unsupported";
  if (/\b(?:laptop|notebook|mobile|max-q)\b/i.test(normalized)) {
    return "notebook";
  }
  return "desktop";
}

/**
 * Compares two numeric dotted NVIDIA driver versions (for example `"621.24"`
 * vs `"580"`). Returns negative if `a < b`, 0 if equal, positive if `a > b`.
 */
export function compareDriverVersions(a: string, b: string): number {
  const partsA = a
    .trim()
    .split(".")
    .map((segment) => Number.parseInt(segment, 10) || 0);
  const partsB = b
    .trim()
    .split(".")
    .map((segment) => Number.parseInt(segment, 10) || 0);
  const length = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < length; i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function normalizeMajorMinor(version: string | null | undefined): string {
  if (typeof version !== "string") return "";
  const match = version.trim().match(/^(\d+)(?:\.(\d+))?/);
  if (!match) return "";
  return `${match[1]}.${match[2] ?? "0"}`;
}

/**
 * Minimum NVIDIA display driver branch required to support `requiredCuda`, or
 * undefined when that CUDA version is not in the verified table.
 */
export function minNvidiaDriverForCuda(
  requiredCuda: string | null | undefined,
): string | undefined {
  const key = normalizeMajorMinor(requiredCuda);
  return key ? MIN_DRIVER_BY_CUDA[key] : undefined;
}

/** Copyable shell command for updating the NVIDIA display driver on Linux. */
export function linuxNvidiaDriverCommand(
  distro: LinuxNvidiaDistro,
  requiredDriver?: string | null,
): string {
  const branch =
    typeof requiredDriver === "string" && /^\d+$/.test(requiredDriver.trim())
      ? requiredDriver.trim()
      : undefined;
  switch (distro) {
    case "ubuntu":
      return branch
        ? `sudo apt update && sudo apt install -y nvidia-driver-${branch} && sudo reboot`
        : "sudo ubuntu-drivers install && sudo reboot";
    case "fedora":
      return "sudo dnf upgrade --refresh akmod-nvidia xorg-x11-drv-nvidia-cuda && sudo reboot";
  }
}
