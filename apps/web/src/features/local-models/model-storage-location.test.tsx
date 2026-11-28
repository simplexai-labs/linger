import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  desktopModelStorage,
  desktopPlatform,
  openFolderMessage,
  revealFileMessage,
  type DesktopModelStorageApi,
  type DesktopPlatform,
} from "./desktop-model-storage";
import { localModelsMessages as m } from "./local-models.messages";
import {
  AdvancedStorageFact,
  ModelStorageFact,
  ModelStorageSummaryRow,
  displayStorageFileName,
} from "./model-storage-location";
import { gb, labView, localModel } from "./local-models-test-support";

function installDesktopStorage(
  platform: DesktopPlatform,
  overrides: Partial<DesktopModelStorageApi> = {},
) {
  const api: DesktopModelStorageApi = {
    openFolder: vi.fn(async () => ({ ok: true as const })),
    revealPath: vi.fn(async () => ({ ok: true as const })),
    ...overrides,
  };
  (window as { lingerDesktop?: unknown }).lingerDesktop = {
    localModelsStorage: api,
    platform,
  };
  return api;
}

afterEach(() => {
  cleanup();
  delete (window as { lingerDesktop?: unknown }).lingerDesktop;
});

describe("desktop-model-storage helpers", () => {
  it("picks OS-specific Open and Show labels for darwin, win32, and linux", () => {
    expect(openFolderMessage("darwin")).toBe(m.storageOpenInFinder);
    expect(openFolderMessage("win32")).toBe(m.storageOpenInFileExplorer);
    expect(openFolderMessage("linux")).toBe(m.storageOpenFolder);
    expect(openFolderMessage(undefined)).toBe(m.storageOpenFolder);

    expect(revealFileMessage("darwin")).toBe(m.storageShowInFinder);
    expect(revealFileMessage("win32")).toBe(m.storageShowInFileExplorer);
    expect(revealFileMessage("linux")).toBe(m.storageShowInFolder);
    expect(revealFileMessage(undefined)).toBe(m.storageShowInFolder);
  });

  it("reads the optional window.lingerDesktop.localModelsStorage bridge", () => {
    expect(desktopModelStorage()).toBeUndefined();
    expect(desktopPlatform()).toBeUndefined();

    const api = installDesktopStorage("darwin");
    expect(desktopModelStorage()).toBe(api);
    expect(desktopPlatform()).toBe("darwin");
  });

  it("computes relative display names cleanly for Windows and POSIX paths", () => {
    expect(
      displayStorageFileName(
        "C:\\Users\\Alice\\.simplexai\\runtime\\localmodels\\models\\models\\assets\\mmproj.gguf",
        "C:\\Users\\Alice\\.simplexai\\runtime\\localmodels\\models\\models",
      ),
    ).toBe("assets\\mmproj.gguf");
    expect(
      displayStorageFileName(
        "/Users/alice/.simplexai/runtime/localmodels/models/models/qwen.gguf",
        "/Users/alice/.simplexai/runtime/localmodels/models/models",
      ),
    ).toBe("qwen.gguf");
    expect(
      displayStorageFileName("/other/root/external.gguf", "/home/alice/models"),
    ).toBe("external.gguf");
  });
});

describe("ModelStorageSummaryRow", () => {
  it("renders nothing for non-owners or when models_dir is absent", () => {
    const base = labView();
    const { container } = render(<ModelStorageSummaryRow view={base} />);
    expect(container).toBeEmptyDOMElement();

    const nonOwner = labView({
      computer: {
        ...base.computer,
        host: {
          ...base.computer.host!,
          models_dir:
            "/home/alice/.simplexai/runtime/localmodels/models/models",
          models_dir_exists: true,
        },
      },
      viewer_is_owner: false,
    });
    const nonOwnerRender = render(<ModelStorageSummaryRow view={nonOwner} />);
    expect(nonOwnerRender.container).toBeEmptyDOMElement();
  });

  it("shows Copy only in browsers or for remote computers, and OS-aware Open on local Desktop", async () => {
    const modelsDir =
      "D:\\program\\Linger\\runtime\\localmodels\\models\\models";
    const view = labView({
      computer: {
        ...labView().computer,
        host: {
          ...labView().computer.host!,
          models_dir: modelsDir,
          models_dir_exists: true,
        },
      },
    });
    const api = installDesktopStorage("win32");

    // Remote computer inside Desktop hides Open button.
    const remote = render(
      <ModelStorageSummaryRow isLocalDesktop={false} view={view} />,
    );
    expect(screen.getByText(modelsDir)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Open in File Explorer" }),
    ).not.toBeInTheDocument();
    remote.unmount();

    // Local computer inside Windows Desktop shows Open in File Explorer.
    render(<ModelStorageSummaryRow isLocalDesktop view={view} />);
    const openBtn = screen.getByRole("button", {
      name: "Open in File Explorer",
    });
    fireEvent.click(openBtn);
    await waitFor(() => expect(api.openFolder).toHaveBeenCalledOnce());
  });

  it("handles models_dir_exists: false and OPEN_FAILED feedback", async () => {
    const modelsDir =
      "/home/alice/.simplexai/runtime/localmodels/models/models";
    const missingView = labView({
      computer: {
        ...labView().computer,
        host: {
          ...labView().computer.host!,
          models_dir: modelsDir,
          models_dir_exists: false,
        },
      },
    });
    installDesktopStorage("linux");

    const first = render(
      <ModelStorageSummaryRow isLocalDesktop view={missingView} />,
    );
    expect(screen.getByText("Created on first download")).toBeVisible();
    expect(screen.getByRole("button", { name: "Open folder" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: `Copy path ${modelsDir}` }),
    ).toBeEnabled();
    first.unmount();

    const failingApi = installDesktopStorage("linux", {
      openFolder: vi.fn(async () => ({
        code: "OPEN_FAILED" as const,
        message: "No desktop session",
        ok: false as const,
      })),
    });
    const existingView = labView({
      computer: {
        ...labView().computer,
        host: {
          ...labView().computer.host!,
          models_dir: modelsDir,
          models_dir_exists: true,
        },
      },
    });
    render(<ModelStorageSummaryRow isLocalDesktop view={existingView} />);
    fireEvent.click(screen.getByRole("button", { name: "Open folder" }));
    await waitFor(() => expect(failingApi.openFolder).toHaveBeenCalledOnce());
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't open folder — copy the path instead.",
    );
  });
});

describe("ModelStorageFact", () => {
  const dir = "/Users/alice/.simplexai/runtime/localmodels/models/models";
  const shard1 = `${dir}/Qwen3.8-27B-00001-of-00002.gguf`;
  const shard2 = `${dir}/Qwen3.8-27B-00002-of-00002.gguf`;
  const mmproj = `${dir}/assets/mmproj-Qwen3.8-27B-BF16.gguf`;

  it("shows primary path, missing-files warning, multi-file expansion, badges, and per-file reveal", async () => {
    const api = installDesktopStorage("darwin");
    const model = localModel({
      id: "qwen3.8-27b:Q4_K_M",
      name: "Qwen3.8 27B",
      state: "idle",
      storage: {
        dedicated_dir: false,
        dir,
        disk_bytes: gb(16.8),
        files: [
          {
            path: shard1,
            present: true,
            role: "weights",
            shared: false,
            size_bytes: gb(8.1),
          },
          {
            path: shard2,
            present: false,
            role: "weights",
            shared: false,
            size_bytes: 0,
          },
          {
            path: mmproj,
            present: true,
            role: "mmproj",
            shared: true,
            size_bytes: 632_000_000,
          },
        ],
        files_present: false,
        primary_path: shard1,
      },
    });

    render(<ModelStorageFact isLocalDesktop model={model} viewerIsOwner />);
    expect(screen.getByText(shard1)).toBeVisible();
    expect(
      screen.getByText("Some model files are missing on disk."),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Show in Finder" }));
    await waitFor(() =>
      expect(api.revealPath).toHaveBeenCalledExactlyOnceWith(shard1),
    );

    const toggle = screen.getByRole("button", { name: "3 files" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    expect(screen.getByText("Qwen3.8-27B-00001-of-00002.gguf")).toBeVisible();
    expect(
      screen.getByText("assets/mmproj-Qwen3.8-27B-BF16.gguf"),
    ).toBeVisible();
    expect(screen.getByText("mmproj")).toBeVisible();
    expect(screen.getByText("Shared")).toBeVisible();
    expect(screen.getByText("Missing")).toBeVisible();

    // Missing file reveal button is disabled; present shared mmproj reveals itself.
    expect(
      screen.getByRole("button", {
        name: "Show in Finder: Qwen3.8-27B-00002-of-00002.gguf",
      }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Show in Finder: assets/mmproj-Qwen3.8-27B-BF16.gguf",
      }),
    );
    await waitFor(() =>
      expect(api.revealPath).toHaveBeenLastCalledWith(mmproj),
    );
  });

  it("falls back to dir/openFolder when primary file is not yet present during download", async () => {
    const api = installDesktopStorage("darwin", {
      revealPath: vi.fn(async () => ({
        code: "NOT_FOUND" as const,
        ok: false as const,
      })),
    });
    const model = localModel({
      id: "qwen3.8-27b:Q4_K_M",
      name: "Qwen3.8 27B",
      state: "downloading",
      storage: {
        dedicated_dir: false,
        dir,
        disk_bytes: gb(2),
        files: [
          {
            path: shard1,
            present: false,
            role: "weights",
            shared: false,
            size_bytes: gb(2),
          },
        ],
        files_present: false,
        primary_path: shard1,
      },
    });

    render(<ModelStorageFact isLocalDesktop model={model} viewerIsOwner />);
    // Downloading does not show missing-files warning.
    expect(
      screen.queryByText("Some model files are missing on disk."),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show in Finder" }));
    await waitFor(() => {
      expect(api.revealPath).toHaveBeenCalledWith(dir);
      expect(api.openFolder).toHaveBeenCalledOnce();
    });
  });

  it("hides storage facts completely for non-owners", () => {
    const model = localModel({
      id: "qwen3.8-27b:Q4_K_M",
      name: "Qwen3.8 27B",
      state: "idle",
      storage: {
        dedicated_dir: false,
        dir,
        disk_bytes: gb(16),
        files: [
          {
            path: shard1,
            present: true,
            role: "weights",
            shared: false,
            size_bytes: gb(16),
          },
        ],
        files_present: true,
        primary_path: shard1,
      },
    });
    const { container } = render(
      <ModelStorageFact isLocalDesktop model={model} viewerIsOwner={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders AdvancedStorageFact inside Hardware details for owners only", () => {
    const host = {
      ...labView().computer.host!,
      models_dir: dir,
      models_dir_exists: true,
    };
    installDesktopStorage("darwin");
    render(<AdvancedStorageFact host={host} isLocalDesktop viewerIsOwner />);
    expect(screen.getByText("Model storage")).toBeVisible();
    expect(screen.getByText(dir)).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Open in Finder" }),
    ).toBeVisible();
  });
});
