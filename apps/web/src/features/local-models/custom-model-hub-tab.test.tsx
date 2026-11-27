import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Suspense } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { resetLanguageForTest } from "@/i18n/language";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { teamHubErrorResponse } from "@/test/teamhub-test-server";

import type {
  CustomModelProbeResponse,
  CustomModelSearchResponse,
} from "./custom-models-queries";
import { ModelsPage } from "./local-models-page";
import type { LocalModelsView } from "./local-models-queries";
import {
  gb,
  localModel,
  macView,
  modelView,
} from "./local-models-test-support";

const tenantId = "tenant-northstar";
const viewPath =
  "/v0/tenants/{tenantId}/local-computers/{computerId}/local-models";
const actionPath =
  "/v0/tenants/{tenantId}/local-computers/{computerId}/local-models/{modelId}/actions";
const modelSourcePath =
  "/v0/tenants/{tenantId}/local-computers/{computerId}/model-source";
const customSearchPath =
  "/v0/tenants/{tenantId}/local-computers/{computerId}/local-models/custom/search";
const customProbePath =
  "/v0/tenants/{tenantId}/local-computers/{computerId}/local-models/custom/probe";
const customDownloadPath =
  "/v0/tenants/{tenantId}/local-computers/{computerId}/local-models/custom/download";

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-search">{location.search}</output>;
}

function searchFixture(): CustomModelSearchResponse {
  return {
    arch: "arm64",
    format: "compatible",
    hub: "all",
    platform: "darwin",
    query: "",
    results: [
      {
        architecture: "qwen2",
        compatible: true,
        context_tokens: 32768,
        default_quant: {
          id: "Q4_K_M",
          label: "Q4_K_M",
          size_bytes: gb(4.7),
        },
        description: "Community GGUF quantizations of Qwen2.5-7B-Instruct.",
        downloads: 184210,
        family: "qwen",
        format: "gguf",
        gated: false,
        hub: "huggingface",
        likes: 312,
        owner: "bartowski",
        parameter_billions: 7.6,
        quant_count: 2,
        repo_id: "bartowski/Qwen2.5-7B-Instruct-GGUF",
        title: "Qwen2.5-7B-Instruct-GGUF",
        url: "https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF",
      },
    ],
    supported_formats: ["gguf"],
    warnings: [],
  };
}

function readyProbeFixture(
  overrides?: Partial<CustomModelProbeResponse>,
): CustomModelProbeResponse {
  return {
    gguf_meta: {
      architecture: "qwen2",
      has_chat_template: true,
      moe: false,
      n_ctx_train: 32768,
      n_layer: 28,
    },
    host: {
      arch: "arm64",
      disk_free_bytes: gb(120),
      platform: "darwin",
      pool_hard_ceiling_bytes: gb(16),
      pool_soft_budget_bytes: gb(12),
      pool_total_bytes: gb(16),
      supported_formats: ["gguf"],
      target_pool: "unified",
    },
    metadata_complete: true,
    outcome: "ready",
    quant_variants: [
      {
        already_installed: false,
        bits_per_weight: 4.89,
        custom_model_id: "custom.hf.bartowski--qwen2.5-7b-instruct-gguf:Q4_K_M",
        disk_ok: true,
        disk_required_bytes: gb(5.2),
        estimated_memory_bytes: gb(6.4),
        files: [
          { path: "Qwen2.5-7B-Instruct-Q4_K_M.gguf", size_bytes: gb(4.7) },
        ],
        id: "Q4_K_M",
        label: "Q4_K_M",
        memory_estimate_basis: "gguf_header",
        memory_status: "comfortable",
        mmproj_bytes: 0,
        quant: "Q4_K_M",
        shard_count: 1,
        sharded: false,
        total_download_bytes: gb(4.7),
        weights_bytes: gb(4.7),
      },
      {
        already_installed: false,
        bits_per_weight: 4.5,
        custom_model_id: "custom.hf.bartowski--qwen2.5-7b-instruct-gguf:Q8_0",
        disk_ok: true,
        disk_required_bytes: gb(22),
        estimated_memory_bytes: gb(24),
        files: [
          {
            path: "Qwen2.5-7B-Instruct-Q8_0-00001-of-00002.gguf",
            size_bytes: gb(10),
          },
          {
            path: "Qwen2.5-7B-Instruct-Q8_0-00002-of-00002.gguf",
            size_bytes: gb(10),
          },
        ],
        id: "Q8_0",
        label: "Q8_0",
        memory_estimate_basis: "rough_1.2x_plus_0.8gb",
        memory_status: "exceeds",
        mmproj_bytes: 0,
        quant: "Q8_0",
        shard_count: 2,
        sharded: true,
        total_download_bytes: gb(20),
        weights_bytes: gb(20),
      },
    ],
    recommended_variant_id: "Q4_K_M",
    repo: {
      family: "qwen",
      format: "gguf",
      gated: false,
      hub: "huggingface",
      license: "apache-2.0",
      owner: "bartowski",
      repo_id: "bartowski/Qwen2.5-7B-Instruct-GGUF",
      title: "Qwen2.5-7B-Instruct-GGUF",
      url: "https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF",
    },
    selected_quant_id: "Q4_K_M",
    ...overrides,
  };
}

function renderCustomPage(options?: {
  initialPath?: string;
  onDownload?: (body: unknown) => Response;
  onProbe?: (body: unknown) => Response;
  onSearch?: (body: unknown) => Response;
  view?: LocalModelsView;
}) {
  const runtime = createTestTeamHubRuntime();
  const baseView = options?.view ?? macView();
  const template = runtime.seed.localComputers[0]!;
  runtime.seed.localComputers = [
    {
      ...template,
      computer_id: baseView.computer.computer_id,
      display_name: baseView.computer.display_name,
      status: baseView.computer.status,
    },
  ];

  const actions: { body: unknown; modelId: string }[] = [];
  const downloads: unknown[] = [];
  const probes: unknown[] = [];

  runtime.server
    .on("GET", modelSourcePath, ({ params }) =>
      Response.json({
        computer_id: params.computerId,
        online: true,
        status: { mode: "local", runtime: "pi" },
        viewer_is_owner: true,
      }),
    )
    .on("GET", viewPath, () => baseView)
    .on("POST", viewPath, ({ params }) =>
      Response.json(
        { action: "refresh", computer_id: params.computerId },
        { status: 202 },
      ),
    )
    .on("POST", actionPath, ({ body, params }) => {
      actions.push({ body, modelId: params.modelId! });
      return Response.json(
        {
          action: (body as { action: string }).action,
          computer_id: params.computerId,
          model_id: params.modelId,
        },
        { status: 202 },
      );
    })
    .on("POST", customSearchPath, ({ body }) =>
      options?.onSearch
        ? options.onSearch(body)
        : Response.json(searchFixture()),
    )
    .on("POST", customProbePath, ({ body }) => {
      probes.push(body);
      return options?.onProbe
        ? options.onProbe(body)
        : Response.json(readyProbeFixture());
    })
    .on("POST", customDownloadPath, ({ body }) => {
      downloads.push(body);
      return options?.onDownload
        ? options.onDownload(body)
        : Response.json(
            {
              action: "custom_download",
              computer_id: baseView.computer.computer_id,
              model_id: "custom.hf.bartowski--qwen2.5-7b-instruct-gguf:Q4_K_M",
            },
            { status: 202 },
          );
    });

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  render(
    <MemoryRouter
      initialEntries={[
        options?.initialPath ??
          `/t/${tenantId}/settings/models?computer=${baseView.computer.computer_id}`,
      ]}
    >
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <Suspense fallback={<div>Loading…</div>}>
            <Routes>
              <Route
                element={
                  <>
                    <ModelsPage />
                    <LocationProbe />
                  </>
                }
                path="/t/:tenantId/settings/models"
              />
            </Routes>
          </Suspense>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );

  return { actions, downloads, probes };
}

afterEach(() => {
  cleanup();
  resetLanguageForTest();
  localStorage.clear();
});

describe("Custom Model Hub Tab (Variant C)", () => {
  it("keeps curated models separated from custom models and widens main to 1200px on ?tab=custom", async () => {
    const customEntry = modelView(
      localModel({
        custom: {
          format: "gguf",
          hub: "huggingface",
          repo_id: "bartowski/Qwen2.5-7B-Instruct-GGUF",
          shard_count: 1,
          standby_on_restart: true,
          variant_id: "Q4_K_M",
        },
        download_bytes: gb(4.7),
        id: "custom.hf.bartowski--qwen2.5-7b-instruct-gguf:Q4_K_M",
        name: "Qwen2.5-7B-Instruct-GGUF",
        origin: "custom",
        quant: "Q4_K_M",
        state: "idle",
        verification: { status: "untested" },
      }),
    );
    const view = macView({
      models: [...macView().models, customEntry],
    });

    renderCustomPage({ view });

    // Curated tab is default: custom model is excluded from curated Library.
    expect(await screen.findByText("GPT-OSS 20B")).toBeVisible();
    expect(screen.queryByText("Qwen2.5-7B-Instruct-GGUF")).toBeNull();
    expect(screen.getByRole("main")).toHaveClass(
      "max-w-(--app-settings-width)",
    );

    // Switch to Custom Hub tab via segmented sub-tab.
    const customTab = screen.getByRole("tab", {
      name: /Custom · HF \/ ModelScope/i,
    });
    expect(customTab).toHaveTextContent("1");
    fireEvent.click(customTab);

    expect(
      await screen.findByText("Preflight & Quant Inspector"),
    ).toBeVisible();
    expect(screen.getByRole("main")).toHaveClass("max-w-[1200px]");
    expect(screen.getByTestId("location-search")).toHaveTextContent(
      "tab=custom",
    );
  });

  it("supports probing a repository, selecting escape-hatch quant, and starting custom download", async () => {
    const { downloads, probes } = renderCustomPage({
      initialPath: `/t/${tenantId}/settings/models?computer=computer-mac&tab=custom`,
    });

    // Click repo from community catalog to trigger zero-download probe.
    const repoButton = await screen.findByRole("button", {
      name: /bartowski\/Qwen2\.5-7B-Instruct-GGUF/i,
    });
    fireEvent.click(repoButton);

    await waitFor(() => expect(probes).toHaveLength(1));
    expect(await screen.findByText("Sweet-spot")).toBeVisible();

    // Select exceeding quant -> shows Install Anyway escape hatch.
    fireEvent.click(screen.getByRole("button", { name: /Q8_0/i }));
    const installAnyway = await screen.findByRole("button", {
      name: /Install Anyway/i,
    });
    fireEvent.click(installAnyway);

    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(downloads[0]).toMatchObject({
      force_memory: true,
      hub: "huggingface",
      repo_id: "bartowski/Qwen2.5-7B-Instruct-GGUF",
      variant_id: "Q8_0",
    });
  });

  it("handles gated 401 unlock with transient token only (no demo button, no localStorage)", async () => {
    const { probes } = renderCustomPage({
      initialPath: `/t/${tenantId}/settings/models?computer=computer-mac&tab=custom`,
      onProbe: (body) => {
        const req = body as { token?: string };
        if (!req.token) {
          return Response.json({
            hub_http_status: 401,
            outcome: "gated",
            repo: {
              hub: "huggingface",
              repo_id: "meta-llama/Llama-3.1-8B-Instruct-GGUF",
              url: "https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct-GGUF",
            },
            token_provided: false,
          } satisfies CustomModelProbeResponse);
        }
        return Response.json(
          readyProbeFixture({
            repo: {
              family: "llama",
              format: "gguf",
              gated: true,
              hub: "huggingface",
              repo_id: "meta-llama/Llama-3.1-8B-Instruct-GGUF",
              url: "https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct-GGUF",
            },
            token_provided: true,
          }),
        );
      },
    });

    const input = await screen.findByLabelText(
      "Custom model URL or search query",
    );
    fireEvent.change(input, {
      target: {
        value: "https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct-GGUF",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Probe" }));

    expect(
      await screen.findByText("Gated or Private Repository"),
    ).toBeVisible();
    // Production UI must never include a demo token button.
    expect(screen.queryByRole("button", { name: /demo token/i })).toBeNull();

    const tokenInput = screen.getByLabelText("Read-only access token");
    fireEvent.change(tokenInput, {
      target: { value: "hf_transient_test_token_1234567890" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Unlock Repo" }));

    expect(await screen.findByText("Token unlocked")).toBeVisible();
    expect(probes).toHaveLength(2);
    expect(JSON.stringify(localStorage)).not.toContain(
      "hf_transient_test_token_1234567890",
    );
  });

  it("handles incompatible Safetensors repos with 1-click GGUF search escape", async () => {
    const searchBodies: unknown[] = [];
    renderCustomPage({
      initialPath: `/t/${tenantId}/settings/models?computer=computer-mac&tab=custom`,
      onProbe: () =>
        Response.json({
          outcome: "incompatible",
          reason: "raw_safetensors",
          repo: {
            format: "safetensors",
            hub: "huggingface",
            repo_id: "Qwen/Qwen2.5-7B-Instruct",
            url: "https://huggingface.co/Qwen/Qwen2.5-7B-Instruct",
          },
          suggested_search_query: "Qwen2.5-7B-Instruct GGUF",
        } satisfies CustomModelProbeResponse),
      onSearch: (body) => {
        searchBodies.push(body);
        return Response.json(searchFixture());
      },
    });

    const input = await screen.findByLabelText(
      "Custom model URL or search query",
    );
    fireEvent.change(input, {
      target: { value: "https://huggingface.co/Qwen/Qwen2.5-7B-Instruct" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Probe" }));

    expect(
      await screen.findByText("Incompatible raw Safetensors / PyTorch weights"),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", {
        name: /Search community GGUF equivalents/i,
      }),
    );

    await waitFor(() =>
      expect(
        searchBodies.some(
          (entry) =>
            (entry as { query?: string; format?: string }).query ===
              "Qwen2.5-7B-Instruct GGUF" &&
            (entry as { format?: string }).format === "gguf",
        ),
      ).toBe(true),
    );
  });

  it("runs smoke test, retry ctx=2048 on OOM, and 1-click delete on unused custom models", async () => {
    const failedOomCustom = modelView(
      localModel({
        custom: {
          format: "gguf",
          hub: "modelscope",
          repo_id: "Qwen/Qwen2.5-32B-Instruct-GGUF",
          shard_count: 3,
          standby_on_restart: true,
          variant_id: "Q4_K_M",
        },
        download_bytes: gb(19.8),
        id: "custom.ms.qwen--qwen2.5-32b-instruct-gguf:Q4_K_M",
        name: "Qwen2.5-32B-Instruct-GGUF",
        origin: "custom",
        quant: "Q4_K_M",
        state: "idle",
        verification: {
          context_tokens: 4096,
          failure: {
            can_redownload: false,
            can_retry_lower_ctx: true,
            code: "OUT_OF_MEMORY",
            context_tokens: 4096,
            diagnostic_log: "[llama-server] failed to allocate KV buffer",
            kind: "oom",
          },
          status: "failed",
        },
      }),
    );

    const view = macView({
      models: [...macView().models, failedOomCustom],
    });

    const { actions } = renderCustomPage({
      initialPath: `/t/${tenantId}/settings/models?computer=computer-mac&tab=custom`,
      view,
    });

    const retryButtons = await screen.findAllByRole("button", {
      name: /Retry at ctx=2048/i,
    });
    fireEvent.click(retryButtons[0]!);

    await waitFor(() =>
      expect(actions).toContainEqual({
        body: { action: "smoke_test", context_tokens: 2048 },
        modelId: failedOomCustom.model.id,
      }),
    );

    const deleteButtons = screen.getAllByRole("button", {
      name: /Delete & Free/i,
    });
    fireEvent.click(deleteButtons[0]!);
    await waitFor(() =>
      expect(actions).toContainEqual({
        body: { action: "remove" },
        modelId: failedOomCustom.model.id,
      }),
    );
  });

  it("shows a helpful upgrade notice when the Computer returns LOCAL_MODELS_CUSTOM_UNSUPPORTED", async () => {
    renderCustomPage({
      initialPath: `/t/${tenantId}/settings/models?computer=computer-mac&tab=custom`,
      onSearch: () =>
        teamHubErrorResponse(409, "LOCAL_MODELS_CUSTOM_UNSUPPORTED"),
    });

    expect(
      await screen.findByText("Update Linger to install custom models"),
    ).toBeVisible();
  });
});
