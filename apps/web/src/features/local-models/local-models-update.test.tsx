import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act as reactAct,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Suspense } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { localComputersQueryOptions } from "@/features/local-computer/local-computer-queries";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { resetLanguageForTest } from "@/i18n/language";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { teamHubErrorResponse } from "@/test/teamhub-test-server";

import { ModelsPage } from "./local-models-page";
import { labView, macView } from "./local-models-test-support";
import type { DesktopLocalModelsUpdateState } from "./local-models-update";

const tenantId = "tenant-northstar";
const viewPath =
  "/v0/tenants/{tenantId}/local-computers/{computerId}/local-models";
const modelSourcePath =
  "/v0/tenants/{tenantId}/local-computers/{computerId}/model-source";

function installDesktopMock(
  computerId: string,
  initialState: DesktopLocalModelsUpdateState | null,
) {
  let current = initialState;
  const listeners = new Set<
    (state: DesktopLocalModelsUpdateState | null) => void
  >();
  const check = vi.fn(async () => {});
  const install = vi.fn(async () => {});
  const setAutoCheck = vi.fn(async (enabled: boolean) => {
    if (current) {
      current = { ...current, autoCheck: enabled };
      for (const listener of listeners) listener(current);
    }
  });
  const openNotes = vi.fn(async () => {});
  const desktopCheck = vi.fn(async () => {});

  Object.defineProperty(window, "lingerDesktop", {
    configurable: true,
    value: {
      version: "0.16.36",
      computer: {
        getStatus: async () => ({
          activeOperations: 0,
          bridge: "online",
          computerId,
          runtime: "ready",
        }),
        onStatus: () => () => {},
        enroll: async () => ({ computerId }),
      },
      update: {
        getState: async () => ({ kind: "idle" }),
        onState: () => () => {},
        install: async () => {},
        check: desktopCheck,
      },
      localModelsUpdate: {
        getState: async () => current,
        onState: (
          callback: (state: DesktopLocalModelsUpdateState | null) => void,
        ) => {
          listeners.add(callback);
          return () => listeners.delete(callback);
        },
        check,
        install,
        setAutoCheck,
        openNotes,
      },
    },
  });

  return {
    check,
    desktopCheck,
    install,
    openNotes,
    setAutoCheck,
    emit(next: DesktopLocalModelsUpdateState | null) {
      current = next;
      for (const listener of listeners) listener(next);
    },
  };
}

async function renderModelsPage(
  initialEntry = `/t/${tenantId}/settings/models`,
) {
  const views = [labView(), macView()];
  const runtime = createTestTeamHubRuntime();
  const template = runtime.seed.localComputers[0]!;
  runtime.seed.localComputers = views.map((view) => ({
    ...template,
    computer_id: view.computer.computer_id,
    display_name: view.computer.display_name,
    status: view.computer.status,
  }));
  const viewById = Object.fromEntries(
    views.map((view) => [view.computer.computer_id, view]),
  );
  let viewFetches = 0;
  runtime.server
    .on("GET", modelSourcePath, ({ params }) =>
      Response.json({
        computer_id: params.computerId,
        online: true,
        viewer_is_owner: true,
      }),
    )
    .on("GET", viewPath, ({ params }) => {
      viewFetches += 1;
      return (
        viewById[params.computerId!] ??
        teamHubErrorResponse(404, "LOCAL_COMPUTER_NOT_FOUND")
      );
    })
    .on("POST", viewPath, ({ params }) =>
      Response.json(
        { action: "refresh", computer_id: params.computerId },
        { status: 202 },
      ),
    );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await queryClient.ensureQueryData(
    localComputersQueryOptions(runtime.client, tenantId),
  );
  render(
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route
              element={
                <Suspense fallback={<div>loading</div>}>
                  <ModelsPage />
                </Suspense>
              }
              path="/t/:tenantId/settings/models"
            />
          </Routes>
        </MemoryRouter>
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
  return { getViewFetches: () => viewFetches, views };
}

afterEach(() => {
  cleanup();
  resetLanguageForTest();
  delete (window as { lingerDesktop?: unknown }).lingerDesktop;
});

describe("ModelsPage localmodels engine updates", () => {
  it("shows available update banner, progress, Details controls and refreshes after apply", async () => {
    const lab = labView();
    const mock = installDesktopMock(lab.computer.computer_id, {
      kind: "available",
      currentVersion: "0.1.0.dev47",
      source: "bundled",
      sourceCommit: "1234567890abcdef1234567890abcdef12345678",
      autoCheck: true,
      version: "0.1.0.dev48",
      summary: "Adds Qwen3.8 models.",
      hasNotes: true,
      bytes: 15 * 1024 * 1024,
    });

    const { getViewFetches } = await renderModelsPage();

    expect(
      await screen.findByText("Model engine 0.1.0.dev48 is available"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/without changing downloaded models/i),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Release notes" }));
    expect(mock.openNotes).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(mock.install).toHaveBeenCalledOnce();

    reactAct(() => {
      mock.emit({
        kind: "downloading",
        currentVersion: "0.1.0.dev47",
        source: "bundled",
        sourceCommit: "1234567890abcdef1234567890abcdef12345678",
        autoCheck: true,
        version: "0.1.0.dev48",
        completed: 5 * 1024 * 1024,
        total: 15 * 1024 * 1024,
      });
    });
    expect(
      screen.getByText(
        "Downloading model engine 0.1.0.dev48 (5.0 MB / 15.0 MB)…",
      ),
    ).toBeInTheDocument();

    const fetchesBeforeApply = getViewFetches();
    reactAct(() => {
      mock.emit({
        kind: "applying",
        currentVersion: "0.1.0.dev47",
        source: "bundled",
        sourceCommit: "1234567890abcdef1234567890abcdef12345678",
        autoCheck: true,
        version: "0.1.0.dev48",
      });
    });
    reactAct(() => {
      mock.emit({
        kind: "idle",
        currentVersion: "0.1.0.dev48",
        source: "updated",
        sourceCommit: "abcdef1234567890abcdef1234567890abcdef12",
        autoCheck: true,
      });
    });

    expect(
      await screen.findByText("Model engine updated to 0.1.0.dev48."),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(getViewFetches()).toBeGreaterThan(fetchesBeforeApply),
    );

    // Open Details dialog and verify version, manual check, and auto-check toggle.
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText("Model engine")).toBeInTheDocument();
    expect(screen.getByText("0.1.0.dev48")).toBeInTheDocument();
    expect(screen.getByText(/Updated · abcdef1/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(mock.check).toHaveBeenCalledOnce();

    const autoCheck = screen.getByLabelText("Check automatically");
    expect(autoCheck).toBeChecked();
    fireEvent.click(autoCheck);
    expect(mock.setAutoCheck).toHaveBeenCalledWith(false);
  });

  it("shows requires_app_update prompt and hides engine updates for other computers", async () => {
    const lab = labView();
    const mac = macView();
    const mock = installDesktopMock(lab.computer.computer_id, {
      kind: "requires_app_update",
      currentVersion: "0.1.0.dev47",
      source: "bundled",
      sourceCommit: "1234567890abcdef1234567890abcdef12345678",
      autoCheck: true,
      version: "0.2.0",
      minLingerVersion: "0.20.0",
    });

    await renderModelsPage(
      `/t/${tenantId}/settings/models?computer=${lab.computer.computer_id}`,
    );
    expect(
      await screen.findByText(
        "Model engine 0.2.0 requires Linger 0.20.0 or newer.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Check for Linger updates" }),
    );
    expect(mock.desktopCheck).toHaveBeenCalledOnce();

    cleanup();
    // Viewing a different computer hides this desktop's local engine updater.
    await renderModelsPage(
      `/t/${tenantId}/settings/models?computer=${mac.computer.computer_id}`,
    );
    await screen.findByRole("button", { name: "Details" });
    expect(
      screen.queryByText(/Model engine 0\.2\.0 requires/),
    ).not.toBeInTheDocument();
  });
});
