import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubVoiceMediaPolicy } from "@/features/teamhub/teamhub-types";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { teamHubErrorResponse } from "@/test/teamhub-test-server";

import { RecordingEntry } from "./recording-entry";
import {
  resetRecordingWindowForTest,
  useRecordingWindow,
  type RecordingWindowState,
} from "./recording-window-store";
import { resetVoicePipForTest } from "../chat/voice-mode/voice-pip";
import { subscribeVoiceMediaPolicy } from "./use-voice-media-policy";
import {
  VoiceCapabilitiesContext,
  VoiceControlContext,
  type VoiceControlContextValue,
} from "./voice-control-context";
import { VoiceKeyDialog } from "./voice-key-dialog";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  resetRecordingWindowForTest();
  resetVoicePipForTest();
});

/** Records every Recording window state the page publishes. */
function RecordingWindowProbe({ seen }: { seen: RecordingWindowState[] }) {
  const state = useRecordingWindow();
  useEffect(() => {
    seen.push(state);
  }, [seen, state]);
  return null;
}

const missing = { source: "none" as const, can_save: true };
const noKeys: TeamHubVoiceMediaPolicy = {
  voice_available: true,
  voice_media_supported: false,
  live_supported: false,
  soniox_key: missing,
  xai_key: missing,
};
const sonioxSaved: TeamHubVoiceMediaPolicy = {
  ...noKeys,
  voice_media_supported: true,
  soniox_key: { source: "stored", can_save: true },
};

function renderWithRuntime(
  runtime: ReturnType<typeof createTestTeamHubRuntime>,
  children: ReactNode,
) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <TeamHubRuntimeProvider runtime={runtime}>
        {children}
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
}

/**
 * Stands in for the workspace voice provider: capabilities follow the
 * published policy, and the voice engine appears once Soniox works.
 */
function VoiceWorkspace({
  children,
  initial,
  selectTargetRoom,
}: {
  children: ReactNode;
  initial: TeamHubVoiceMediaPolicy;
  selectTargetRoom: () => Promise<void>;
}) {
  const [policy, setPolicy] = useState(initial);
  useEffect(
    () => subscribeVoiceMediaPolicy((_tenantId, next) => setPolicy(next)),
    [],
  );
  const voice = policy.voice_media_supported
    ? ({ selectTargetRoom } as unknown as VoiceControlContextValue)
    : null;
  return (
    <VoiceControlContext value={voice}>
      <VoiceCapabilitiesContext
        value={{
          policy,
          voiceAvailable:
            policy.voice_available ?? policy.voice_media_supported,
          voiceMedia: policy.voice_media_supported,
        }}
      >
        {children}
      </VoiceCapabilitiesContext>
    </VoiceControlContext>
  );
}

describe("Recording entry visibility", () => {
  it.each([
    [{ voice_available: true, voice_media_supported: false }, true],
    [{ voice_available: false, voice_media_supported: false }, false],
    // Older servers do not send voice_available.
    [{ voice_media_supported: false }, false],
    [{ voice_media_supported: true }, true],
  ])("for policy %j shows the entry: %s", (policy, shown) => {
    const runtime = createTestTeamHubRuntime();
    renderWithRuntime(
      runtime,
      <VoiceWorkspace initial={policy} selectTargetRoom={vi.fn()}>
        <RecordingEntry
          anotherMeRoomId="another-me"
          tenantId="tenant-northstar"
        />
      </VoiceWorkspace>,
    );
    expect(Boolean(screen.queryByRole("button", { name: "Meetings" }))).toBe(
      shown,
    );
  });
});

describe("Recording without a Soniox key", () => {
  it("asks for the key, waits for voice, then starts recording", async () => {
    const runtime = createTestTeamHubRuntime();
    let saved = false;
    let saves = 0;
    runtime.server
      .on("GET", "/v0/tenants/{tenantId}/voice-media-policy", () =>
        saved ? sonioxSaved : noKeys,
      )
      .on("PUT", "/v0/voice-provider-keys/{provider}", ({ body, params }) => {
        expect(params.provider).toBe("soniox");
        expect(body).toEqual({ api_key: "soniox-key" });
        saves += 1;
        saved = true;
        return { source: "stored", can_save: true };
      });
    const selectTargetRoom = vi.fn(async () => undefined);
    const recordingWindow: RecordingWindowState[] = [];
    renderWithRuntime(
      runtime,
      <VoiceWorkspace initial={noKeys} selectTargetRoom={selectTargetRoom}>
        <RecordingEntry
          anotherMeRoomId="another-me"
          tenantId="tenant-northstar"
        />
        <RecordingWindowProbe seen={recordingWindow} />
      </VoiceWorkspace>,
    );
    const entry = screen.getByRole("button", { name: "Meetings" });
    expect(entry).toBeEnabled();
    fireEvent.click(entry);
    const dialog = await screen.findByRole("dialog", { name: "Soniox key" });
    fireEvent.change(within(dialog).getByLabelText("Soniox API key"), {
      target: { value: " soniox-key " },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save key" }));
    const closed = {
      open: false,
      minimized: false,
      autoStart: false,
      ending: false,
    };
    await waitFor(() =>
      expect(recordingWindow).toEqual([
        closed,
        { ...closed, open: true, autoStart: true },
      ]),
    );
    expect(selectTargetRoom).toHaveBeenCalledWith("another-me");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(saves).toBe(1);
    // One fresh read after the save; nothing polls.
    expect(
      runtime.server.requestsTo(
        "GET",
        "/v0/tenants/{tenantId}/voice-media-policy",
      ),
    ).toHaveLength(1);
  });
});

describe("VoiceKeyDialog", () => {
  function renderDialog(
    runtime: ReturnType<typeof createTestTeamHubRuntime>,
    policy: TeamHubVoiceMediaPolicy,
    onReady = vi.fn(),
  ) {
    renderWithRuntime(
      runtime,
      <VoiceKeyDialog
        onClose={vi.fn()}
        onReady={onReady}
        policy={policy}
        providers={["soniox"]}
        tenantId="tenant-northstar"
      />,
    );
    return onReady;
  }

  it.each([
    [
      "VOICE_KEY_REJECTED",
      400,
      "Soniox rejected this key. Check it and try again.",
    ],
    [
      "VOICE_KEY_NO_BALANCE",
      400,
      "Your Soniox account is out of balance or reached its monthly budget. Add funds or raise the budget in the Soniox Console, then try again.",
    ],
    [
      "VOICE_KEY_NO_REALTIME_PERMISSION",
      400,
      "This key cannot use Soniox real-time transcription. Allow it for the key in the Soniox Console, or use another key.",
    ],
    [
      "VOICE_PROVIDER_UNAVAILABLE",
      503,
      "Could not reach Soniox to check the key. Try again in a moment.",
    ],
    [
      "VOICE_KEY_STORAGE_UNAVAILABLE",
      503,
      "This server cannot store keys. Whoever runs it must set TEAMHUB_SECRET_ENCRYPTION_KEY.",
    ],
  ])("keeps the dialog open on %s", async (code, status, message) => {
    const runtime = createTestTeamHubRuntime();
    runtime.server.on("PUT", "/v0/voice-provider-keys/{provider}", () =>
      // The prose is irrelevant: only the code picks the message.
      teamHubErrorResponse(status, code, "unrelated server prose"),
    );
    const onReady = renderDialog(runtime, noKeys);
    fireEvent.change(screen.getByLabelText("Soniox API key"), {
      target: { value: "bad-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    expect(await screen.findByText(message)).toBeVisible();
    expect(screen.getByRole("dialog", { name: "Soniox key" })).toBeVisible();
    expect(screen.queryByText("unrelated server prose")).toBeNull();
    expect(onReady).not.toHaveBeenCalled();
  });

  it("says voice is turning on while the save waits for it", async () => {
    const runtime = createTestTeamHubRuntime();
    let answer: (() => void) | undefined;
    runtime.server.on(
      "PUT",
      "/v0/voice-provider-keys/{provider}",
      () =>
        new Promise((resolve) => {
          answer = () => resolve({ source: "stored", can_save: true });
        }),
    );
    renderDialog(runtime, noKeys);
    fireEvent.change(screen.getByLabelText("Soniox API key"), {
      target: { value: "soniox-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    expect(
      await screen.findByRole("button", { name: /Turning on voice/ }),
    ).toBeDisabled();
    answer!();
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /Turning on voice/ }),
      ).toBeNull(),
    );
  });

  it("explains that the deployment must configure a key it cannot save", () => {
    const runtime = createTestTeamHubRuntime();
    renderDialog(runtime, {
      ...noKeys,
      soniox_key: { source: "none", can_save: false },
    });
    expect(screen.queryByLabelText("Soniox API key")).toBeNull();
    expect(
      screen.getByText(/This server cannot save a Soniox key here/u),
    ).toBeVisible();
    expect(screen.getByText("SONIOX_API_KEY")).toBeVisible();
  });

  describe("local model page", () => {
    const localReady = { ...noKeys, local_dictation_supported: true };

    function renderWithLocal(
      runtime: ReturnType<typeof createTestTeamHubRuntime>,
      onReady = vi.fn(),
    ) {
      renderWithRuntime(
        runtime,
        <VoiceKeyDialog
          onClose={vi.fn()}
          onReady={onReady}
          policy={noKeys}
          providers={["soniox", "local"]}
          tenantId="tenant-northstar"
        />,
      );
      return onReady;
    }

    it("saves the rewrite model, then turns local dictation on", async () => {
      const runtime = createTestTeamHubRuntime();
      runtime.server
        .on("GET", "/v0/voice-dictation-settings", () => ({
          local_model: "ready",
          default_polish_model: "haiku",
        }))
        .on("PUT", "/v0/voice-dictation-settings", () => ({
          local_model: "ready",
          polish_model: "haiku",
          default_polish_model: "haiku",
        }))
        .on(
          "GET",
          "/v0/tenants/{tenantId}/voice-media-policy",
          () => localReady,
        );
      const onReady = renderWithLocal(runtime);
      fireEvent.click(screen.getByRole("button", { name: "Local model" }));
      expect(await screen.findByRole("status")).toHaveTextContent(
        "The speech model is ready.",
      );
      expect(
        screen.getByRole("combobox", {
          name: "Model that rewrites dictated text",
        }),
      ).toHaveTextContent("Haiku (fastest, recommended)");
      expect(screen.queryByLabelText("Soniox API key")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Use local model" }));
      await waitFor(() =>
        expect(onReady).toHaveBeenCalledWith("local", localReady),
      );
      expect(
        runtime.server.requestsTo("PUT", "/v0/voice-dictation-settings"),
      ).toHaveLength(1);
      await expect(
        runtime.server
          .requestsTo("PUT", "/v0/voice-dictation-settings")[0]!
          .json(),
      ).resolves.toEqual({ polish_source: "cli", polish_model: "haiku" });
    });

    it("offers the aliases every Claude CLI takes, not one person's catalog", async () => {
      const runtime = createTestTeamHubRuntime();
      runtime.server
        .on("GET", "/v0/voice-dictation-settings", () => ({
          local_model: "ready",
          default_polish_model: "haiku",
        }))
        .on("PUT", "/v0/voice-dictation-settings", () => ({
          local_model: "ready",
          polish_model: "sonnet",
          default_polish_model: "haiku",
        }))
        .on(
          "GET",
          "/v0/tenants/{tenantId}/voice-media-policy",
          () => localReady,
        );
      renderWithLocal(runtime);
      fireEvent.click(screen.getByRole("button", { name: "Local model" }));
      await screen.findByRole("status");
      fireEvent.click(
        screen.getByRole("combobox", {
          name: "Model that rewrites dictated text",
        }),
      );
      expect(
        (await screen.findAllByRole("option")).map((option) =>
          option.textContent?.trim(),
        ),
      ).toEqual(["Haiku (fastest, recommended)", "Sonnet", "Opus"]);

      fireEvent.click(screen.getByRole("option", { name: "Sonnet" }));
      fireEvent.click(screen.getByRole("button", { name: "Use local model" }));
      await waitFor(() =>
        expect(
          runtime.server.requestsTo("PUT", "/v0/voice-dictation-settings"),
        ).toHaveLength(1),
      );
      await expect(
        runtime.server
          .requestsTo("PUT", "/v0/voice-dictation-settings")[0]!
          .json(),
      ).resolves.toEqual({ polish_source: "cli", polish_model: "sonnet" });
    });

    describe("with an API of the person's own", () => {
      const ready = {
        local_model: "ready",
        default_polish_model: "haiku",
        can_save_api_key: true,
      };

      async function openApiPage(
        runtime: ReturnType<typeof createTestTeamHubRuntime>,
      ) {
        const onReady = renderWithLocal(runtime);
        fireEvent.click(screen.getByRole("button", { name: "Local model" }));
        await screen.findByRole("status");
        fireEvent.click(screen.getByRole("button", { name: "My API key" }));
        return onReady;
      }

      it("saves the address, model and key, then turns dictation on", async () => {
        const runtime = createTestTeamHubRuntime();
        runtime.server
          .on("GET", "/v0/voice-dictation-settings", () => ready)
          .on("PUT", "/v0/voice-dictation-settings", () => ({
            ...ready,
            polish_source: "api",
            polish_api: {
              base_url: "https://api.deepseek.com/v1",
              model: "deepseek-chat",
              key_saved: true,
            },
          }))
          .on(
            "GET",
            "/v0/tenants/{tenantId}/voice-media-policy",
            () => localReady,
          );
        const onReady = await openApiPage(runtime);
        expect(screen.getByLabelText("API address")).toHaveValue(
          "https://api.deepseek.com/v1",
        );
        expect(screen.getByLabelText("Model")).toHaveValue("deepseek-chat");
        const save = screen.getByRole("button", { name: "Use local model" });
        expect(save).toBeDisabled();

        fireEvent.change(screen.getByLabelText("API key"), {
          target: { value: "sk-test-key" },
        });
        expect(save).toBeEnabled();
        fireEvent.click(save);
        await waitFor(() =>
          expect(onReady).toHaveBeenCalledWith("local", localReady),
        );
        await expect(
          runtime.server
            .requestsTo("PUT", "/v0/voice-dictation-settings")[0]!
            .json(),
        ).resolves.toEqual({
          polish_source: "api",
          polish_api: {
            base_url: "https://api.deepseek.com/v1",
            model: "deepseek-chat",
            api_key: "sk-test-key",
          },
        });
      });

      it("keeps a saved key when the field is left empty", async () => {
        const runtime = createTestTeamHubRuntime();
        runtime.server
          .on("GET", "/v0/voice-dictation-settings", () => ({
            ...ready,
            polish_source: "api",
            polish_api: {
              base_url: "https://api.example.com/v1",
              model: "fast-model",
              key_saved: true,
            },
          }))
          .on("PUT", "/v0/voice-dictation-settings", () => ready)
          .on(
            "GET",
            "/v0/tenants/{tenantId}/voice-media-policy",
            () => localReady,
          );
        await openApiPage(runtime);
        expect(screen.getByLabelText("API address")).toHaveValue(
          "https://api.example.com/v1",
        );
        expect(
          screen.getByText("A key is saved. Leave this empty to keep it."),
        ).toBeVisible();
        fireEvent.click(
          screen.getByRole("button", { name: "Use local model" }),
        );
        await waitFor(() =>
          expect(
            runtime.server.requestsTo("PUT", "/v0/voice-dictation-settings"),
          ).toHaveLength(1),
        );
        await expect(
          runtime.server
            .requestsTo("PUT", "/v0/voice-dictation-settings")[0]!
            .json(),
        ).resolves.toEqual({
          polish_source: "api",
          polish_api: {
            base_url: "https://api.example.com/v1",
            model: "fast-model",
          },
        });
      });

      it("asks for a key of its own once the address is not the saved one", async () => {
        const runtime = createTestTeamHubRuntime();
        runtime.server.on("GET", "/v0/voice-dictation-settings", () => ({
          ...ready,
          polish_source: "api",
          polish_api: {
            base_url: "https://api.example.com/v1",
            model: "fast-model",
            key_saved: true,
          },
        }));
        await openApiPage(runtime);
        const save = screen.getByRole("button", { name: "Use local model" });
        expect(save).toBeEnabled();

        fireEvent.change(screen.getByLabelText("API address"), {
          target: { value: "https://other.example.com/v1" },
        });
        expect(save).toBeDisabled();
        expect(
          screen.getByText(
            "Enter this address's own key. The saved key is used only at the address it was saved for.",
          ),
        ).toBeVisible();

        fireEvent.change(screen.getByLabelText("API key"), {
          target: { value: "sk-other" },
        });
        expect(save).toBeEnabled();
        // The address typed with a slash is still the saved one.
        fireEvent.change(screen.getByLabelText("API key"), {
          target: { value: "" },
        });
        fireEvent.change(screen.getByLabelText("API address"), {
          target: { value: "https://api.example.com/v1/" },
        });
        expect(save).toBeEnabled();
      });

      it("says when the API rejects the key and does not continue", async () => {
        const runtime = createTestTeamHubRuntime();
        runtime.server
          .on("GET", "/v0/voice-dictation-settings", () => ready)
          .on("PUT", "/v0/voice-dictation-settings", () =>
            teamHubErrorResponse(400, "VOICE_KEY_REJECTED"),
          );
        const onReady = await openApiPage(runtime);
        fireEvent.change(screen.getByLabelText("API key"), {
          target: { value: "sk-wrong" },
        });
        fireEvent.click(
          screen.getByRole("button", { name: "Use local model" }),
        );
        expect(await screen.findByRole("alert")).toHaveTextContent(
          "The API rejected this key. Check it and try again.",
        );
        expect(onReady).not.toHaveBeenCalled();
      });

      it("explains a server that cannot store the key", async () => {
        const runtime = createTestTeamHubRuntime();
        runtime.server.on("GET", "/v0/voice-dictation-settings", () => ({
          ...ready,
          can_save_api_key: false,
        }));
        await openApiPage(runtime);
        expect(await screen.findByRole("alert")).toHaveTextContent(
          "TEAMHUB_SECRET_ENCRYPTION_KEY",
        );
        fireEvent.change(screen.getByLabelText("API key"), {
          target: { value: "sk-test-key" },
        });
        expect(
          screen.getByRole("button", { name: "Use local model" }),
        ).toBeDisabled();
      });

      describe("listing the API's models", () => {
        const listModels = "Get models from the API";

        it("fills the model from the list once the address and key are given", async () => {
          const runtime = createTestTeamHubRuntime();
          runtime.server
            .on("GET", "/v0/voice-dictation-settings", () => ready)
            .on("POST", "/v0/voice-dictation-settings/models", () => ({
              models: ["deepseek-chat", "deepseek-flash"],
            }));
          await openApiPage(runtime);
          const refresh = screen.getByRole("button", { name: listModels });
          expect(refresh).toBeDisabled();

          fireEvent.change(screen.getByLabelText("API key"), {
            target: { value: "sk-test-key" },
          });
          expect(refresh).toBeEnabled();
          fireEvent.click(refresh);
          fireEvent.click(
            await screen.findByRole("option", { name: "deepseek-flash" }),
          );

          expect(screen.getByLabelText("Model")).toHaveValue("deepseek-flash");
          expect(
            screen.getByText(
              "2 models available. Pick one or type another name.",
            ),
          ).toBeVisible();
          await expect(
            runtime.server
              .requestsTo("POST", "/v0/voice-dictation-settings/models")[0]!
              .json(),
          ).resolves.toEqual({
            base_url: "https://api.deepseek.com/v1",
            api_key: "sk-test-key",
          });
        });

        it("uses the saved key for the saved address and no other", async () => {
          const runtime = createTestTeamHubRuntime();
          runtime.server
            .on("GET", "/v0/voice-dictation-settings", () => ({
              ...ready,
              polish_source: "api",
              polish_api: {
                base_url: "https://api.example.com/v1",
                model: "fast-model",
                key_saved: true,
              },
            }))
            .on("POST", "/v0/voice-dictation-settings/models", () => ({
              models: ["fast-model"],
            }));
          await openApiPage(runtime);
          const refresh = screen.getByRole("button", { name: listModels });
          expect(refresh).toBeEnabled();
          fireEvent.click(refresh);
          await screen.findByRole("option", { name: "fast-model" });
          await expect(
            runtime.server
              .requestsTo("POST", "/v0/voice-dictation-settings/models")[0]!
              .json(),
          ).resolves.toEqual({ base_url: "https://api.example.com/v1" });

          fireEvent.change(screen.getByLabelText("API address"), {
            target: { value: "https://other.example.com/v1" },
          });
          expect(refresh).toBeDisabled();
          expect(screen.queryByRole("option")).not.toBeInTheDocument();
        });

        it("says when the API refuses the key", async () => {
          const runtime = createTestTeamHubRuntime();
          runtime.server
            .on("GET", "/v0/voice-dictation-settings", () => ready)
            .on("POST", "/v0/voice-dictation-settings/models", () =>
              teamHubErrorResponse(400, "VOICE_KEY_REJECTED"),
            );
          await openApiPage(runtime);
          fireEvent.change(screen.getByLabelText("API key"), {
            target: { value: "sk-wrong" },
          });
          fireEvent.click(screen.getByRole("button", { name: listModels }));
          expect(
            await screen.findByText(
              "The API rejected this key. Check it and try again.",
            ),
          ).toBeVisible();
          expect(screen.getByLabelText("Model")).toHaveValue("deepseek-chat");
        });

        it("asks for a typed name when the API lists none", async () => {
          const runtime = createTestTeamHubRuntime();
          runtime.server
            .on("GET", "/v0/voice-dictation-settings", () => ready)
            .on("POST", "/v0/voice-dictation-settings/models", () => ({
              models: [],
            }));
          await openApiPage(runtime);
          fireEvent.change(screen.getByLabelText("API key"), {
            target: { value: "sk-test-key" },
          });
          fireEvent.click(screen.getByRole("button", { name: listModels }));
          expect(
            await screen.findByText(
              "This API does not list its models. Type the name of the model to use.",
            ),
          ).toBeVisible();
          expect(screen.queryByRole("option")).not.toBeInTheDocument();
        });
      });
    });

    it("keeps the button off while the speech model is not available", async () => {
      const runtime = createTestTeamHubRuntime();
      runtime.server.on("GET", "/v0/voice-dictation-settings", () => ({
        local_model: "unavailable",
        default_polish_model: "haiku",
      }));
      renderWithLocal(runtime);
      fireEvent.click(screen.getByRole("button", { name: "Local model" }));
      expect(await screen.findByRole("status")).toHaveTextContent(
        "This server has no speech model.",
      );
      expect(
        screen.getByRole("button", { name: "Use local model" }),
      ).toBeDisabled();
    });
  });

  it("offers a retry when the fresh policy does not report voice", async () => {
    const runtime = createTestTeamHubRuntime();
    let reads = 0;
    runtime.server
      .on("GET", "/v0/tenants/{tenantId}/voice-media-policy", () => {
        reads += 1;
        return reads === 1
          ? teamHubErrorResponse(503, "UNAVAILABLE")
          : sonioxSaved;
      })
      .on("PUT", "/v0/voice-provider-keys/{provider}", () => ({
        source: "stored",
        can_save: true,
      }));
    const onReady = renderDialog(runtime, noKeys);
    fireEvent.change(screen.getByLabelText("Soniox API key"), {
      target: { value: "soniox-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The key is saved, but voice could not be turned on. Try again.",
    );
    expect(onReady).not.toHaveBeenCalled();
    expect(reads).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(onReady).toHaveBeenCalledWith("soniox", sonioxSaved),
    );
    expect(reads).toBe(2);
    expect(
      runtime.server.requestsTo("PUT", "/v0/voice-provider-keys/{provider}"),
    ).toHaveLength(1);
  });
});
