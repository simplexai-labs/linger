import {
  NVIDIA_DRIVER_DOWNLOAD_URL,
  NVIDIA_DRIVER_GUIDE_URL,
} from "@linger/service-kit/nvidia-driver";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UpdateDriverDialog } from "./local-model-driver-dialog";
import type { LocalModel, LocalModelsView } from "./local-models-queries";

function makeView(
  overrides: {
    platform?: "windows" | "linux" | "darwin";
    osLabel?: string;
    gpuName?: string;
    downloadable?: boolean;
  } = {},
): LocalModelsView {
  const downloadable = overrides.downloadable ?? false;
  const model: LocalModel = {
    availability: downloadable
      ? { downloadable: true }
      : {
          downloadable: false,
          reason: {
            code: "DRIVER_UPDATE_REQUIRED",
            detected_cuda: "12.8",
            driver_version: "572.83",
            required_cuda: "13.0",
          },
        },
    context_tokens: 65536,
    description: "Fast assistant on PolyStrata.",
    download_bytes: 13_600_000_000,
    engine: "polystrata",
    engine_label: "PolyStrata 0.2.19-poly.1",
    fit: downloadable ? "gpu" : "none",
    id: "inkling-2-mini-q3-poly:UD-Q3_K_XL",
    memory_bytes: 8_053_063_680,
    name: "Inkling 2 Mini (UD-Q3_K_XL)",
    quant: "UD-Q3_K_XL",
    recommended: false,
    state: "absent",
    vision: true,
  };
  return {
    available: true,
    computer: {
      computer_id: "computer-win",
      display_name: "Workstation",
      host: {
        arch: "x86_64",
        disk_free_bytes: 200_000_000_000,
        engine_label: "PolyStrata",
        gpus: [
          {
            free_bytes: 7_500_000_000,
            index: 0,
            name: overrides.gpuName ?? "NVIDIA GeForce RTX 5060",
            total_bytes: 8_589_934_592,
            uuid: "GPU-1",
          },
        ],
        os_label: overrides.osLabel ?? "Windows 11",
        platform: overrides.platform ?? "windows",
        ram_total_bytes: 34_359_738_368,
      },
      status: "online",
    },
    models: [{ model, used_by: [] }],
    pools: [],
    viewer_is_owner: true,
  };
}

describe("UpdateDriverDialog", () => {
  afterEach(() => {
    delete (window as { lingerDesktop?: unknown }).lingerDesktop;
    vi.restoreAllMocks();
  });

  it("offers NVIDIA App launch on local Windows desktop and auto-rechecks on window focus", async () => {
    const openNvidiaApp = vi.fn(async () => ({ ok: true as const }));
    const openOfficialDownload = vi.fn(async () => ({ ok: true as const }));
    const openGuide = vi.fn(async () => ({ ok: true as const }));
    (window as { lingerDesktop?: unknown }).lingerDesktop = {
      driverUpdate: {
        getCapabilities: vi.fn(async () => ({
          directInstallSupported: false,
          nvidiaApp: "nvidia_app",
          platform: "win32",
        })),
        getInstallState: vi.fn(async () => ({ phase: "idle" })),
        onInstallState: vi.fn(() => () => {}),
        openGuide,
        openNvidiaApp,
        openOfficialDownload,
        startInstall: vi.fn(async () => ({
          ok: false,
          reason: "unsupported",
        })),
      },
    };
    const onRecheck = vi.fn();
    const view = makeView();

    render(
      <UpdateDriverDialog
        isLocalDesktop
        model={view.models[0]!.model}
        onClose={vi.fn()}
        onRecheck={onRecheck}
        reason={{
          detected_cuda: "12.8",
          driver_version: "572.83",
          required_cuda: "13.0",
        }}
        view={view}
      />,
    );

    expect(screen.getByText("NVIDIA GeForce RTX 5060")).toBeVisible();
    expect(screen.getByText("Driver 572.83 · CUDA 12.8")).toBeVisible();
    expect(screen.getByText("Driver 580+ · CUDA 13.0")).toBeVisible();
    expect(
      screen.getByText(
        "Only the NVIDIA graphics driver needs an update — CUDA Toolkit is not required.",
      ),
    ).toBeVisible();

    const nvidiaAppButton = await screen.findByRole("button", {
      name: "Open NVIDIA App",
    });
    fireEvent.click(nvidiaAppButton);
    await waitFor(() => expect(openNvidiaApp).toHaveBeenCalledOnce());

    // Returning focus to Linger triggers an automatic driver recheck.
    window.dispatchEvent(new Event("focus"));
    expect(onRecheck).toHaveBeenCalledOnce();

    fireEvent.click(
      screen.getByRole("button", { name: "Read step-by-step guide" }),
    );
    await waitFor(() => expect(openGuide).toHaveBeenCalledOnce());
  });

  it("renders browser official download links when outside desktop shell", () => {
    const view = makeView();
    render(
      <UpdateDriverDialog
        isLocalDesktop={false}
        model={view.models[0]!.model}
        onClose={vi.fn()}
        onRecheck={vi.fn()}
        reason={{
          detected_cuda: "12.8",
          driver_version: "572.83",
          required_cuda: "13.0",
        }}
        view={view}
      />,
    );

    const downloadLink = screen.getByRole("link", {
      name: "Download from NVIDIA",
    });
    expect(downloadLink).toHaveAttribute("href", NVIDIA_DRIVER_DOWNLOAD_URL);

    const guideLink = screen.getByRole("link", {
      name: "Read step-by-step guide",
    });
    expect(guideLink).toHaveAttribute("href", NVIDIA_DRIVER_GUIDE_URL);
  });

  it("shows copyable distro commands on Linux and switches between Ubuntu and Fedora", async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    const view = makeView({ osLabel: "Ubuntu 24.04", platform: "linux" });

    render(
      <UpdateDriverDialog
        isLocalDesktop={false}
        model={view.models[0]!.model}
        onClose={vi.fn()}
        onRecheck={vi.fn()}
        reason={{
          detected_cuda: "12.8",
          driver_version: "570.12",
          required_cuda: "13.0",
        }}
        view={view}
      />,
    );

    expect(
      screen.getByText(
        "sudo apt update && sudo apt install -y nvidia-driver-580 && sudo reboot",
      ),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "sudo apt update && sudo apt install -y nvidia-driver-580 && sudo reboot",
      ),
    );

    fireEvent.click(screen.getByRole("tab", { name: "Fedora" }));
    expect(
      screen.getByText(
        "sudo dnf upgrade --refresh akmod-nvidia xorg-x11-drv-nvidia-cuda && sudo reboot",
      ),
    ).toBeVisible();
  });

  it("shows a ready notice once the updated driver unlocks the model", () => {
    const view = makeView({ downloadable: true });
    render(
      <UpdateDriverDialog
        isLocalDesktop={false}
        model={view.models[0]!.model}
        onClose={vi.fn()}
        onRecheck={vi.fn()}
        reason={{
          detected_cuda: "12.8",
          driver_version: "572.83",
          required_cuda: "13.0",
        }}
        view={view}
      />,
    );

    expect(
      screen.getByText(
        "Your NVIDIA driver now meets the requirement. You can download this model now.",
      ),
    ).toBeVisible();
  });

  it("runs signed one-click Windows installation with live progress, reboot notice, and error fallback", async () => {
    let listener: ((state: unknown) => void) | undefined;
    const startInstall = vi.fn(async () => ({ ok: true as const }));
    const openNvidiaApp = vi.fn(async () => ({ ok: true as const }));
    (window as { lingerDesktop?: unknown }).lingerDesktop = {
      driverUpdate: {
        clearInstallState: vi.fn(async () => {}),
        getCapabilities: vi.fn(async () => ({
          directInstallSupported: true,
          nvidiaApp: "nvidia_app",
          platform: "win32",
        })),
        getInstallState: vi.fn(async () => ({ phase: "idle" })),
        onInstallState: vi.fn((cb: (state: unknown) => void) => {
          listener = cb;
          return () => {
            listener = undefined;
          };
        }),
        openGuide: vi.fn(async () => ({ ok: true as const })),
        openNvidiaApp,
        openOfficialDownload: vi.fn(async () => ({ ok: true as const })),
        startInstall,
      },
    };
    const onRecheck = vi.fn();
    const view = makeView();

    render(
      <UpdateDriverDialog
        isLocalDesktop
        model={view.models[0]!.model}
        onClose={vi.fn()}
        onRecheck={onRecheck}
        reason={{
          detected_cuda: "12.8",
          driver_version: "572.83",
          required_cuda: "13.0",
        }}
        view={view}
      />,
    );

    const installButton = await screen.findByRole("button", {
      name: "Install driver update",
    });
    fireEvent.click(installButton);
    await waitFor(() =>
      expect(startInstall).toHaveBeenCalledWith({
        gpuName: "NVIDIA GeForce RTX 5060",
        requiredCuda: "13.0",
        resumeModelId: "inkling-2-mini-q3-poly:UD-Q3_K_XL",
      }),
    );

    // Emit live download -> verify -> install -> reboot_required transitions.
    listener?.({
      completedBytes: 512 * 1024 * 1024,
      phase: "downloading",
      totalBytes: 1024 * 1024 * 1024,
      version: "621.24",
    });
    expect(
      await screen.findByText(/Downloading NVIDIA driver 621\.24.*50%/),
    ).toBeVisible();
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "50",
    );

    listener?.({ phase: "verifying", version: "621.24" });
    expect(
      await screen.findByText("Verifying NVIDIA digital signature for 621.24…"),
    ).toBeVisible();

    listener?.({ phase: "installing", version: "621.24" });
    expect(
      await screen.findByText(
        "Installing NVIDIA driver 621.24… Your screen may blink briefly.",
      ),
    ).toBeVisible();

    listener?.({
      phase: "reboot_required",
      resumeModelId: "inkling-2-mini-q3-poly:UD-Q3_K_XL",
      version: "621.24",
    });
    expect(
      await screen.findByText(
        "NVIDIA driver 621.24 installed. Restart Windows to finish — when you reopen Linger, your GPU will be rechecked automatically.",
      ),
    ).toBeVisible();

    // Signature failure surfaces a clear safety warning while keeping fallback buttons active.
    listener?.({ code: "SIGNATURE_INVALID", phase: "failed" });
    expect(
      await screen.findByText(
        "The downloaded file failed NVIDIA digital signature verification and was deleted for safety. Use Download from NVIDIA.",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Open NVIDIA App" }),
    ).toBeEnabled();
  });
});
