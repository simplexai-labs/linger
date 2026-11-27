import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Suspense } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import { TeamHubEventSync } from "@/features/rooms/event-sync";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubLocalSpeechView } from "@/features/teamhub/teamhub-types";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";

import { ModelsPage } from "./local-models-page";
import { labView } from "./local-models-test-support";

const tenantId = "tenant-northstar";
const computerId = "lab";
const localModelsPath =
  "/v0/tenants/{tenantId}/local-computers/{computerId}/local-models";
const modelSourcePath =
  "/v0/tenants/{tenantId}/local-computers/{computerId}/model-source";
const localSpeechPath =
  "/v0/tenants/{tenantId}/local-computers/{computerId}/local-speech";
const voicePolicyPath = "/v0/tenants/{tenantId}/voice-media-policy";

function speechSnapshot(
  overrides: Partial<TeamHubLocalSpeechView> = {},
): TeamHubLocalSpeechView {
  return {
    available: true,
    computer: {
      computer_id: computerId,
      display_name: "Lab",
      status: "online",
    },
    config: {
      keep_loaded_seconds: 900,
      language: "auto",
      model_id: "sensevoice-small",
      use_gpu: true,
    },
    models: [
      {
        active: true,
        commercial_notice:
          "Custom license (FunASR MODEL_LICENSE v1.1); user opt-in download only.",
        disk_size_bytes: 248_512_512,
        engine: "sherpa-onnx",
        gpu_supported: false,
        id: "sensevoice-small",
        language_count: 5,
        languages: ["zh", "en", "ja", "ko", "yue"],
        license: "FunASR-MODEL-LICENSE-1.1",
        license_url:
          "https://huggingface.co/FunAudioLLM/SenseVoiceSmall/blob/main/MODEL_LICENSE",
        name: "SenseVoice Small (INT8)",
        quality_rating: "fast-cjk",
        ram_estimate_bytes: 629_145_600,
        state: "loaded",
        vram_estimate_bytes: 0,
      },
    ],
    observed_at: "2026-11-26T13:20:00Z",
    runtime: {
      active_model: "sensevoice-small",
      active_sessions: 0,
      effective_device: "cpu",
      engine: "sherpa-onnx",
      fallback_detail: null,
      fallback_reason: "cpu_optimal_for_int8",
      idle_remaining_seconds: 800,
      keep_loaded_seconds: 900,
      ram_used_bytes: 500_000_000,
      requested_device: "gpu",
      running: true,
      state: "loaded",
      vram_used_bytes: 0,
    },
    viewer_is_owner: true,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("ModelsPage Voice tab", () => {
  it("keeps Voice orthogonal to Agent LLM ModelSourceMode, shows independent active dots, and syncs on local-speech hints", async () => {
    const runtime = createTestTeamHubRuntime();
    const view = labView();
    const template = runtime.seed.localComputers[0]!;
    runtime.seed.localComputers = [
      {
        ...template,
        computer_id: computerId,
        display_name: "Lab",
        status: "online",
      },
    ];

    let speech = speechSnapshot();
    runtime.server
      .on("GET", modelSourcePath, () =>
        Response.json({
          computer_id: computerId,
          online: true,
          status: {
            byok: { configured: true, key_saved: true },
            mode: "byok",
            runtime: "pi",
          },
          viewer_is_owner: true,
        }),
      )
      .on("GET", localModelsPath, () => view)
      .on("POST", localModelsPath, ({ params }) =>
        Response.json(
          { action: "refresh", computer_id: params.computerId },
          { status: 202 },
        ),
      )
      .on("GET", localSpeechPath, () => speech)
      .on("GET", voicePolicyPath, () => ({
        active_speech_provider: "local" as const,
        local_speech_available: true,
        local_speech_ready: true,
        voice_available: true,
        voice_media_supported: true,
      }));

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <TeamHubEventSync />
          <MemoryRouter initialEntries={[`/t/${tenantId}/settings/models`]}>
            <Suspense fallback={null}>
              <Routes>
                <Route
                  element={<ModelsPage />}
                  path="/t/:tenantId/settings/models"
                />
                <Route
                  element={<div>Voice settings page</div>}
                  path="/t/:tenantId/settings/voice"
                />
              </Routes>
            </Suspense>
          </MemoryRouter>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );

    // Agent LLM source is BYOK (active), while Voice ALSO has its own green dot!
    const byokTab = await screen.findByRole("tab", {
      name: /BYOK/u,
      selected: true,
    });
    expect(byokTab.querySelector('[role="img"]')).toBeInTheDocument();

    const voiceTab = await screen.findByRole("tab", { name: /Voice/u });
    await waitFor(() =>
      expect(voiceTab.querySelector('[role="img"]')).toBeInTheDocument(),
    );

    // Click Voice tab -> renders shared VoiceLocalModelsSection + Voice settings link
    fireEvent.click(voiceTab);
    expect(
      await screen.findByText("SenseVoice Small (INT8)"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Voice settings/u }),
    ).toHaveAttribute("href", `/t/${tenantId}/settings/voice`);

    // Realtime local-speech invalidation refreshes shared speech view
    speech = speechSnapshot({
      models: [
        {
          ...speech.models[0]!,
          download: {
            bytes_per_second: 10_000_000,
            done_bytes: 198_810_009,
            step: "download",
            total_bytes: 248_512_512,
          },
          state: "downloading",
        },
      ],
    });
    act(() => {
      runtime.events.emitSignal({
        hint: { id: computerId, resource: "local-speech", tenant_id: tenantId },
        type: "resource.invalidated",
      });
    });

    expect(
      await screen.findByRole("progressbar", {
        name: /SenseVoice Small \(INT8\) download progress/u,
      }),
    ).toHaveAttribute("aria-valuenow", "80");
  });
});
