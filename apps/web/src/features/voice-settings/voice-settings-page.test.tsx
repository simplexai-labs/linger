import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TeamHubEventSync } from "@/features/rooms/event-sync";
import {
  VoiceControlContext,
  type VoiceControlContextValue,
} from "@/features/rooms/voice-control/voice-control-context";
import { deviceStorageKey } from "@/features/rooms/voice-control/voice-control-storage";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubLocalSpeechModel,
  TeamHubLocalSpeechView,
  TeamHubVoiceMediaPolicy,
  TeamHubVoiceSettings,
} from "@/features/teamhub/teamhub-types";
import {
  createTestTeamHubRuntime,
  type TestTeamHubRuntime,
} from "@/test/teamhub-test-runtime";

import { VoiceSettingsPage } from "./voice-settings-page";
import { resolveSpeechComputer } from "./voice-settings-queries";

const audioMeter = vi.hoisted(() => ({
  dispose: vi.fn(),
  listener: undefined as ((level: number) => void) | undefined,
}));

vi.mock("@/features/rooms/chat/voice-mode/voice-media-room", () => ({
  observeAudioLevel: (
    _track: MediaStreamTrack,
    update: (level: number) => void,
  ) => {
    audioMeter.listener = update;
    return audioMeter.dispose;
  },
}));

const tenantId = "tenant-northstar";
const computerId = "comp-studio";
const voiceSettingsPath = "/v0/tenants/{tenantId}/voice-settings";
const voicePolicyPath = "/v0/tenants/{tenantId}/voice-media-policy";
const localSpeechPath =
  "/v0/tenants/{tenantId}/local-computers/{computerId}/local-speech";
const localSpeechActionPath =
  "/v0/tenants/{tenantId}/local-computers/{computerId}/local-speech/actions";

function senseVoiceModel(
  overrides: Partial<TeamHubLocalSpeechModel> = {},
): TeamHubLocalSpeechModel {
  return {
    active: false,
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
    state: "absent",
    vram_estimate_bytes: 0,
    ...overrides,
  };
}

function whisperModel(
  overrides: Partial<TeamHubLocalSpeechModel> = {},
): TeamHubLocalSpeechModel {
  return {
    active: true,
    commercial_notice: null,
    disk_size_bytes: 601_882_624,
    engine: "whisper.cpp",
    gpu_supported: true,
    id: "whisper-large-v3-turbo",
    language_count: 99,
    languages: ["auto"],
    license: "MIT",
    license_url:
      "https://huggingface.co/openai/whisper-large-v3-turbo/blob/main/LICENSE",
    name: "Whisper Large v3 Turbo (Q5_0)",
    quality_rating: "high-multilingual",
    ram_estimate_bytes: 1_288_490_188,
    state: "loaded",
    vram_estimate_bytes: 1_073_741_824,
    ...overrides,
  };
}

function speechView(
  overrides: Partial<TeamHubLocalSpeechView> = {},
): TeamHubLocalSpeechView {
  return {
    available: true,
    computer: {
      computer_id: computerId,
      display_name: "Studio Mac",
      status: "online",
    },
    config: {
      keep_loaded_seconds: 900,
      language: "auto",
      model_id: "whisper-large-v3-turbo",
      use_gpu: true,
    },
    models: [senseVoiceModel(), whisperModel()],
    observed_at: "2026-11-26T13:20:00Z",
    runtime: {
      active_model: "whisper-large-v3-turbo",
      active_sessions: 0,
      effective_device: "metal",
      engine: "whisper.cpp",
      fallback_detail: null,
      idle_remaining_seconds: 850,
      keep_loaded_seconds: 900,
      ram_used_bytes: 800_000_000,
      requested_device: "gpu",
      running: true,
      state: "loaded",
      vram_used_bytes: 900_000_000,
    },
    tool_version: "0.1.0.dev60",
    viewer_is_owner: true,
    ...overrides,
  };
}

interface Fixture {
  actions: unknown[];
  policy: TeamHubVoiceMediaPolicy;
  runtime: TestTeamHubRuntime;
  settings: TeamHubVoiceSettings;
  settingsUpdates: unknown[];
  view: TeamHubLocalSpeechView;
}

function setupFixture(options?: {
  policy?: Partial<TeamHubVoiceMediaPolicy>;
  settings?: Partial<TeamHubVoiceSettings>;
  view?: Partial<TeamHubLocalSpeechView>;
}): Fixture {
  const runtime = createTestTeamHubRuntime();
  const template = runtime.seed.localComputers[0]!;
  const view = speechView(options?.view);
  runtime.seed.localComputers = [
    {
      ...template,
      computer_id: view.computer.computer_id,
      display_name: view.computer.display_name,
      status: view.computer.status,
    },
  ];
  const fixture: Fixture = {
    actions: [],
    policy: {
      active_speech_provider: "local",
      local_speech_available: true,
      local_speech_ready: true,
      soniox_key: { can_save: true, source: "none" },
      voice_available: true,
      voice_media_supported: true,
      xai_key: { can_save: true, source: "none" },
      ...options?.policy,
    },
    runtime,
    settings: {
      keep_loaded_seconds: 900,
      language: "auto",
      local_computer_id: view.computer.computer_id,
      local_model_id: "whisper-large-v3-turbo",
      silence_timeout_seconds: 0,
      speech_provider: "local",
      use_gpu: true,
      ...options?.settings,
    },
    settingsUpdates: [],
    view,
  };

  runtime.server
    .on("GET", voicePolicyPath, () => fixture.policy)
    .on("GET", voiceSettingsPath, () => fixture.settings)
    .on("PUT", voiceSettingsPath, ({ body }) => {
      fixture.settingsUpdates.push(body);
      fixture.settings = {
        ...fixture.settings,
        ...(body as Partial<TeamHubVoiceSettings>),
      };
      return fixture.settings;
    })
    .on("GET", localSpeechPath, () => fixture.view)
    .on("POST", localSpeechActionPath, ({ body }) => {
      fixture.actions.push(body);
      const action = (body as { action: string; model_id?: string }).action;
      return Response.json(
        {
          action,
          computer_id: fixture.view.computer.computer_id,
          model_id: (body as { model_id?: string }).model_id,
        },
        { status: 202 },
      );
    });

  return fixture;
}

function renderVoicePage(
  fixture: Fixture,
  options?: {
    initialEntry?: string;
    voiceControl?: VoiceControlContextValue | null;
  },
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={fixture.runtime}>
          <TeamHubEventSync />
          <VoiceControlContext value={options?.voiceControl ?? null}>
            <MemoryRouter
              initialEntries={[
                options?.initialEntry ?? `/t/${tenantId}/settings/voice`,
              ]}
            >
              <Routes>
                <Route
                  element={<VoiceSettingsPage />}
                  path="/t/:tenantId/settings/voice"
                />
                <Route
                  element={<div>Computers page</div>}
                  path="/t/:tenantId/settings/computers"
                />
              </Routes>
            </MemoryRouter>
          </VoiceControlContext>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    ),
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  window.localStorage.clear();
  audioMeter.listener = undefined;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: undefined,
  });
});

describe("VoiceSettingsPage", () => {
  it("renders On this computer and Cloud tabs, model states, GPU device badge, and mandatory FunASR license disclosure", async () => {
    const fixture = setupFixture();
    renderVoicePage(fixture);

    expect(
      await screen.findByText("SenseVoice Small (INT8)"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Whisper Large v3 Turbo (Q5_0)"),
    ).toBeInTheDocument();
    expect(screen.getByText("GPU · Metal")).toBeInTheDocument();

    // Mandatory license link + opt-in notice on SenseVoice BEFORE download.
    const licenseLink = screen.getByRole("link", {
      name: /FunASR MODEL_LICENSE v1\.1/u,
    });
    expect(licenseLink).toHaveAttribute(
      "href",
      "https://huggingface.co/FunAudioLLM/SenseVoiceSmall/blob/main/MODEL_LICENSE",
    );
    expect(licenseLink).toHaveAttribute("target", "_blank");
    expect(
      screen.getByText(/Custom license — opt-in download only/u),
    ).toBeInTheDocument();

    // Switch to Cloud tab and verify Soniox setup & speaker separation note.
    fireEvent.click(screen.getByRole("tab", { name: /Cloud/u }));
    expect(await screen.findByText("Soniox Cloud")).toBeInTheDocument();
    expect(
      screen.getByText(/automatic speaker separation in Meeting Recordings/u),
    ).toBeInTheDocument();
  });

  it("executes Download, Cancel, Use, and confirmed Delete actions on speech models", async () => {
    const fixture = setupFixture({
      settings: {
        local_model_id: undefined,
      },
      view: {
        models: [
          senseVoiceModel({ state: "absent" }),
          whisperModel({ active: false, state: "idle" }),
        ],
      },
    });
    renderVoicePage(fixture);

    // Download SenseVoice
    const senseRow = (
      await screen.findByText("SenseVoice Small (INT8)")
    ).closest("[data-speech-model]") as HTMLElement;
    fireEvent.click(within(senseRow).getByRole("button", { name: "Download" }));
    await waitFor(() =>
      expect(fixture.actions).toContainEqual({
        action: "download",
        include_gpu_engine: false,
        model_id: "sensevoice-small",
      }),
    );

    // Live local-speech invalidation updates row to downloading + Cancel
    fixture.view = speechView({
      models: [
        senseVoiceModel({
          download: {
            bytes_per_second: 12_582_912,
            done_bytes: 124_256_256,
            step: "download",
            total_bytes: 248_512_512,
          },
          state: "downloading",
        }),
        whisperModel({ active: false, state: "idle" }),
      ],
    });
    act(() => {
      fixture.runtime.events.emitSignal({
        hint: {
          id: computerId,
          resource: "local-speech",
          tenant_id: tenantId,
        },
        type: "resource.invalidated",
      });
    });

    expect(
      await within(senseRow).findByRole("progressbar", {
        name: /SenseVoice Small \(INT8\) download progress/u,
      }),
    ).toHaveAttribute("aria-valuenow", "50");

    fireEvent.click(within(senseRow).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(fixture.actions).toContainEqual({
        action: "cancel",
        model_id: "sensevoice-small",
      }),
    );

    // Use Whisper (idle -> saves voice-settings + configure)
    const whisperRow = screen
      .getByText("Whisper Large v3 Turbo (Q5_0)")
      .closest("[data-speech-model]") as HTMLElement;
    fireEvent.click(within(whisperRow).getByRole("button", { name: "Use" }));
    await waitFor(() =>
      expect(fixture.settingsUpdates).toContainEqual({
        local_computer_id: computerId,
        local_model_id: "whisper-large-v3-turbo",
        speech_provider: "local",
      }),
    );

    // Delete requires ModalDialog confirmation
    fireEvent.click(
      within(whisperRow).getByRole("button", {
        name: /Delete Whisper Large v3 Turbo/u,
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Delete speech model?"),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(fixture.actions).toContainEqual({
        action: "remove",
        model_id: "whisper-large-v3-turbo",
      }),
    );
  });

  it("shows localized GPU fallback notice banner when use_gpu is true and fallback_reason is set", async () => {
    const fixture = setupFixture({
      view: {
        runtime: {
          ...speechView().runtime!,
          effective_device: "cpu",
          fallback_reason: "yielded_to_llm",
          requested_device: "gpu",
        },
      },
    });
    renderVoicePage(fixture);

    expect(
      await screen.findByText(
        /yielded GPU memory to the active local LLM and is running on CPU/u,
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText("CPU").length).toBeGreaterThanOrEqual(1);
  });

  it("persists Language, Stop after silence, Use GPU, and Keep model loaded (-1/0/900) and forwards configure", async () => {
    const fixture = setupFixture();
    renderVoicePage(fixture);

    await screen.findByText("Whisper Large v3 Turbo (Q5_0)");

    // Toggle Use GPU off
    const gpuSwitch = screen.getByRole("switch", { name: "Use GPU" });
    expect(gpuSwitch).toBeChecked();
    fireEvent.click(gpuSwitch);
    await waitFor(() =>
      expect(fixture.settingsUpdates).toContainEqual({ use_gpu: false }),
    );
    await waitFor(() =>
      expect(fixture.actions).toContainEqual(
        expect.objectContaining({
          action: "configure",
          use_gpu: false,
        }),
      ),
    );

    // Change Keep model loaded to Never unload (-1)
    fireEvent.click(
      screen.getByRole("combobox", { name: "Keep model loaded" }),
    );
    fireEvent.click(
      await screen.findByRole("option", { name: "Never unload" }),
    );
    await waitFor(() =>
      expect(fixture.settingsUpdates).toContainEqual({
        keep_loaded_seconds: -1,
      }),
    );

    // Change Language to Japanese
    fireEvent.click(screen.getByRole("combobox", { name: "Language" }));
    fireEvent.click(await screen.findByRole("option", { name: "Japanese" }));
    await waitFor(() =>
      expect(fixture.settingsUpdates).toContainEqual({ language: "ja" }),
    );

    // Change Stop after silence to 5 seconds
    fireEvent.click(
      screen.getByRole("combobox", { name: "Stop after silence" }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "5 seconds" }));
    await waitFor(() =>
      expect(fixture.settingsUpdates).toContainEqual({
        silence_timeout_seconds: 5,
      }),
    );
  });

  it("keeps microphone selection strictly in localStorage and runs clash-safe Test with full cleanup", async () => {
    const trackStop = vi.fn();
    const fakeStream = {
      getAudioTracks: () => [{ stop: trackStop }],
      getTracks: () => [{ stop: trackStop }],
    } as unknown as MediaStream;

    const getUserMedia = vi.fn(async () => fakeStream);
    const enumerateDevices = vi.fn(async () => [
      {
        deviceId: "mic-usb",
        groupId: "grp-1",
        kind: "audioinput",
        label: "USB Studio Mic",
      },
    ]);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        addEventListener: vi.fn(),
        enumerateDevices,
        getUserMedia,
        removeEventListener: vi.fn(),
      },
    });

    const fixture = setupFixture();
    const { unmount } = renderVoicePage(fixture);

    await screen.findByText("Whisper Large v3 Turbo (Q5_0)");

    // Select USB mic -> stored in localStorage, NEVER sent to voice-settings API.
    fireEvent.click(screen.getByRole("combobox", { name: "Input" }));
    fireEvent.click(
      await screen.findByRole("option", { name: "USB Studio Mic" }),
    );
    await waitFor(() =>
      expect(window.localStorage.getItem(deviceStorageKey(tenantId))).toContain(
        "mic-usb",
      ),
    );
    expect(fixture.settingsUpdates).toEqual([]);

    // Click Test -> opens getUserMedia, drives level meter, stops cleanly on unmount.
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByRole("button", { name: "Stop test" }),
    ).toBeInTheDocument();

    act(() => {
      audioMeter.listener?.(0.64);
    });
    expect(
      screen.getByRole("meter", { name: "Microphone input level" }),
    ).toHaveAttribute("aria-valuenow", "64");

    unmount();
    expect(audioMeter.dispose).toHaveBeenCalledTimes(1);
    expect(trackStop).toHaveBeenCalledTimes(1);
  });

  it("disables microphone Test with an explanatory hint while a recording is active", async () => {
    const fixture = setupFixture();
    const activeRecordingControl = {
      captureState: {
        capture: { id: "cap-1" },
        status: "recording",
      },
      composerMicrophoneActive: false,
      devices: [],
      listenerStatus: "listening",
      selectedDeviceId: "",
    } as unknown as VoiceControlContextValue;

    renderVoicePage(fixture, { voiceControl: activeRecordingControl });
    await screen.findByText("Whisper Large v3 Turbo (Q5_0)");

    expect(screen.getByRole("button", { name: "Test" })).toBeDisabled();
    expect(
      screen.getByText(/Microphone is currently in use/u),
    ).toBeInTheDocument();
  });

  it("guides offline users to Settings -> Computers with a 1-click Switch to Cloud CTA", async () => {
    const fixture = setupFixture({
      policy: {
        active_speech_provider: "none",
        local_speech_available: false,
        local_speech_ready: false,
      },
      view: {
        available: false,
        computer: {
          computer_id: computerId,
          display_name: "Studio Mac",
          status: "offline",
        },
        models: [],
      },
    });
    renderVoicePage(fixture);

    expect(
      await screen.findByText("Studio Mac is offline"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Switch to Cloud" }));
    expect(await screen.findByText("Soniox Cloud")).toBeInTheDocument();
  });

  it("prefers an online Computer consistently over an offline configured Computer unless explicitly picked", () => {
    const runtime = createTestTeamHubRuntime();
    const base = runtime.seed.localComputers[0]!;
    const offlineConfigured = {
      ...base,
      computer_id: "comp-offline",
      display_name: "Offline Mac",
      status: "offline" as const,
    };
    const onlineSecondary = {
      ...base,
      computer_id: "comp-online",
      display_name: "Online Studio",
      status: "online" as const,
    };

    expect(
      resolveSpeechComputer({
        computers: [offlineConfigured, onlineSecondary],
        configuredComputerId: "comp-offline",
      })?.computer_id,
    ).toBe("comp-online");

    expect(
      resolveSpeechComputer({
        computers: [offlineConfigured, onlineSecondary],
        configuredComputerId: "comp-offline",
        selectedComputerId: "comp-offline",
      })?.computer_id,
    ).toBe("comp-offline");

    expect(
      resolveSpeechComputer({
        computers: [offlineConfigured],
        configuredComputerId: "comp-offline",
      })?.computer_id,
    ).toBe("comp-offline");
  });
});
