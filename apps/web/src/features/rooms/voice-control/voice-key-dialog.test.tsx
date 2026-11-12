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
import { openRecordingWindow } from "./recording-window-store";
import { subscribeVoiceMediaPolicy } from "./use-voice-media-policy";
import {
  VoiceCapabilitiesContext,
  VoiceControlContext,
  type VoiceControlContextValue,
} from "./voice-control-context";
import { VoiceKeyDialog } from "./voice-key-dialog";

vi.mock("./recording-window-store", () => ({ openRecordingWindow: vi.fn() }));
vi.mock("../chat/voice-mode/voice-pip", () => ({
  closeVoicePip: vi.fn(),
  openVoicePip: vi.fn(async () => undefined),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

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
    renderWithRuntime(
      runtime,
      <VoiceWorkspace initial={noKeys} selectTargetRoom={selectTargetRoom}>
        <RecordingEntry
          anotherMeRoomId="another-me"
          tenantId="tenant-northstar"
        />
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
    await waitFor(() => expect(openRecordingWindow).toHaveBeenCalledOnce());
    expect(openRecordingWindow).toHaveBeenCalledWith({ autoStart: true });
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
