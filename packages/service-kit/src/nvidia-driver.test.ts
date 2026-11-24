import { describe, expect, it } from "vitest";

import {
  NVIDIA_DRIVER_DOWNLOAD_URL,
  NVIDIA_DRIVER_GUIDE_URL,
  NVIDIA_SMI_VERIFY_COMMAND,
  classifyWindowsNvidiaGpu,
  compareDriverVersions,
  isAllowedNvidiaDownloadUrl,
  linuxNvidiaDriverCommand,
  minNvidiaDriverForCuda,
} from "./nvidia-driver.js";

describe("nvidia-driver helpers", () => {
  it("exposes verified official URLs and verification command", () => {
    expect(NVIDIA_DRIVER_DOWNLOAD_URL).toBe(
      "https://www.nvidia.com/Download/index.aspx",
    );
    expect(NVIDIA_DRIVER_GUIDE_URL).toBe(
      "https://docs.heylinger.com/install/nvidia-driver",
    );
    expect(NVIDIA_SMI_VERIFY_COMMAND).toBe("nvidia-smi");
  });

  it("maps known CUDA versions to their minimum NVIDIA driver branch", () => {
    expect(minNvidiaDriverForCuda("13.0")).toBe("580");
    expect(minNvidiaDriverForCuda("13.0.3")).toBe("580");
    expect(minNvidiaDriverForCuda("12.8")).toBe("570");
    expect(minNvidiaDriverForCuda("12.4")).toBe("550");
    expect(minNvidiaDriverForCuda("99.0")).toBeUndefined();
    expect(minNvidiaDriverForCuda(undefined)).toBeUndefined();
  });

  it("builds copyable Linux driver update commands for Ubuntu and Fedora", () => {
    expect(linuxNvidiaDriverCommand("ubuntu", "580")).toBe(
      "sudo apt update && sudo apt install -y nvidia-driver-580 && sudo reboot",
    );
    expect(linuxNvidiaDriverCommand("ubuntu")).toBe(
      "sudo ubuntu-drivers install && sudo reboot",
    );
    expect(linuxNvidiaDriverCommand("fedora", "580")).toBe(
      "sudo dnf upgrade --refresh akmod-nvidia xorg-x11-drv-nvidia-cuda && sudo reboot",
    );
  });

  it("allows only standard-port HTTPS .exe URLs on official NVIDIA download hosts", () => {
    expect(
      isAllowedNvidiaDownloadUrl(
        "https://us.download.nvidia.com/Windows/621.24/621.24-desktop-win10-win11-64bit-international-dch-whql.exe",
      ),
    ).toBe(true);
    expect(
      isAllowedNvidiaDownloadUrl(
        "https://cn.download.nvidia.com/Windows/580.88/580.88-notebook-win10-win11-64bit-international-dch-whql.exe",
      ),
    ).toBe(true);
    expect(
      isAllowedNvidiaDownloadUrl(
        "http://us.download.nvidia.com/Windows/621.24/driver.exe",
      ),
    ).toBe(false);
    expect(
      isAllowedNvidiaDownloadUrl(
        "https://us.download.nvidia.com:8443/Windows/621.24/driver.exe",
      ),
    ).toBe(false);
    expect(
      isAllowedNvidiaDownloadUrl(
        "https://evil.example.com/Windows/621.24/driver.exe",
      ),
    ).toBe(false);
    expect(
      isAllowedNvidiaDownloadUrl(
        "https://user:pass@us.download.nvidia.com/Windows/621.24/driver.exe",
      ),
    ).toBe(false);
    expect(
      isAllowedNvidiaDownloadUrl(
        "https://us.download.nvidia.com/Windows/621.24/release-notes.pdf",
      ),
    ).toBe(false);
    expect(isAllowedNvidiaDownloadUrl("not a url")).toBe(false);
  });

  it("classifies GeForce RTX desktop and notebook GPUs while rejecting enterprise/legacy cards", () => {
    expect(classifyWindowsNvidiaGpu("NVIDIA GeForce RTX 5060")).toBe("desktop");
    expect(classifyWindowsNvidiaGpu("NVIDIA GeForce RTX 4090")).toBe("desktop");
    expect(classifyWindowsNvidiaGpu("NVIDIA GeForce RTX 5060 Laptop GPU")).toBe(
      "notebook",
    );
    expect(
      classifyWindowsNvidiaGpu("NVIDIA GeForce RTX 3080 with Max-Q Design"),
    ).toBe("notebook");
    expect(classifyWindowsNvidiaGpu("NVIDIA RTX 6000 Ada Generation")).toBe(
      "unsupported",
    );
    expect(classifyWindowsNvidiaGpu("NVIDIA GeForce GTX 1080 Ti")).toBe(
      "unsupported",
    );
    expect(classifyWindowsNvidiaGpu("AMD Radeon RX 7900 XTX")).toBe(
      "unsupported",
    );
    expect(classifyWindowsNvidiaGpu(undefined)).toBe("unsupported");
  });

  it("compares dotted NVIDIA driver version strings numerically", () => {
    expect(compareDriverVersions("621.24", "580")).toBeGreaterThan(0);
    expect(compareDriverVersions("580.00", "580")).toBe(0);
    expect(compareDriverVersions("572.83", "580")).toBeLessThan(0);
    expect(compareDriverVersions("580.12", "580.2")).toBeGreaterThan(0);
  });
});
