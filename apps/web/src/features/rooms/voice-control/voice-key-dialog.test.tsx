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
    {
      onClose = vi.fn(),
      providers = ["soniox"] as readonly ("soniox" | "xai")[],
    } = {},
  ) {
    renderWithRuntime(
      runtime,
      <VoiceKeyDialog
        onClose={onClose}
        onReady={onReady}
        policy={policy}
        providers={providers}
        tenantId="tenant-northstar"
      />,
    );
    return { onClose, onReady };
  }

  it("renders the Option A form layout with inline link, helper, show/hide toggle, and Cancel", () => {
    const runtime = createTestTeamHubRuntime();
    const { onClose } = renderDialog(runtime, noKeys);

    const dialog = screen.getByRole("dialog", { name: "Soniox key" });
    expect(dialog).toHaveClass("app-key-dialog");
    expect(dialog.querySelector(".app-dialog-description")).toBeNull();
    expect(dialog.querySelector("ol")).toBeNull();
    expect(dialog).not.toHaveTextContent("Get your API key");
    expect(
      within(dialog).getByRole("link", { name: "Get a key" }),
    ).toHaveAttribute("href", "https://console.soniox.com/");

    const input = within(dialog).getByLabelText("Soniox API key");
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("placeholder", "Paste your API key");
    expect(input).toHaveAccessibleDescription(
      "Transcribes meetings, Pocket Notes dictation and Voice Mode dictation.",
    );

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Show API key" }),
    );
    expect(input).toHaveAttribute("type", "text");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Hide API key" }),
    );
    expect(input).toHaveAttribute("type", "password");

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the replace hint when a single provider already has a stored key", () => {
    const runtime = createTestTeamHubRuntime();
    renderDialog(runtime, sonioxSaved);

    const dialog = screen.getByRole("dialog", { name: "Soniox key" });
    expect(dialog.querySelector(".app-dialog-description")).toHaveTextContent(
      "A key is active. Save a new key to replace it.",
    );
  });

  it("switches providers with the segmented control without duplicating the purpose copy", () => {
    const runtime = createTestTeamHubRuntime();
    renderDialog(runtime, noKeys, vi.fn(), {
      providers: ["soniox", "xai"],
    });

    const dialog = screen.getByRole("dialog", { name: "Turn on voice" });
    const group = within(dialog).getByRole("group", { name: "Voice provider" });
    expect(
      within(group).getByRole("button", { name: "Soniox" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(dialog).getAllByText(
        "Transcribes meetings, Pocket Notes dictation and Voice Mode dictation.",
      ),
    ).toHaveLength(1);

    fireEvent.click(within(group).getByRole("button", { name: "xAI" }));
    expect(within(group).getByRole("button", { name: "xAI" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      within(dialog).getByRole("link", { name: "Get a key" }),
    ).toHaveAttribute("href", "https://console.x.ai/");
    expect(
      within(dialog).getByLabelText("xAI API key"),
    ).toHaveAccessibleDescription(
      "Turns Voice Mode into a live conversation with Grok.",
    );
    expect(
      within(dialog).getAllByText(
        "Turns Voice Mode into a live conversation with Grok.",
      ),
    ).toHaveLength(1);
  });

  it("explains when the server sets a key from the environment", () => {
    const runtime = createTestTeamHubRuntime();
    renderDialog(runtime, {
      ...noKeys,
      soniox_key: { source: "environment", can_save: false },
    });

    const dialog = screen.getByRole("dialog", { name: "Soniox key" });
    expect(dialog.querySelector(".app-dialog-description")).toBeNull();
    expect(within(dialog).queryByLabelText("Soniox API key")).toBeNull();
    expect(dialog).toHaveTextContent(
      "This server sets the Soniox key with SONIOX_API_KEY, so it cannot be changed here.",
    );
    expect(within(dialog).getByText("SONIOX_API_KEY").tagName).toBe("CODE");
  });

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
    const { onReady } = renderDialog(runtime, noKeys);
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
    const { onClose, onReady } = renderDialog(runtime, noKeys);
    fireEvent.change(screen.getByLabelText("Soniox API key"), {
      target: { value: "soniox-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The key is saved, but voice could not be turned on. Try again.",
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(onReady).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
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
