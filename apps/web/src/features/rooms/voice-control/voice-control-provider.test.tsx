import type { VoiceEventSubscription } from "@/features/teamhub/voice-event-transport";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createTestTeamHubRuntime,
  type TestTeamHubRuntime,
} from "@/test/teamhub-test-runtime";
import {
  teamHubErrorResponse,
  type TestRouteMethod,
  type TestRouteRequest,
} from "@/test/teamhub-test-server";
import { acceptVoice } from "@/test/teamhub-voice-routes";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubVoiceCapture,
  TeamHubVoiceSession,
  TeamHubVoiceTranscriptEventPage,
} from "@/features/teamhub/teamhub-types";
import * as publisherLease from "./voice-publisher-lease";
import {
  useVoiceControl,
  type VoiceControlContextValue,
} from "./voice-control-context";
import { LiveKitVoiceControlProvider } from "./voice-control-provider";
import { VoiceFocusSurface } from "./voice-focus-surface";
import {
  teamHubData,
  type TeamHubApiPath,
} from "@/features/teamhub/teamhub-api";

const media = vi.hoisted(() => ({
  listeners: new Map<string, () => void>(),
  publish: vi.fn(async () => undefined),
  stop: vi.fn(),
  mute: vi.fn(async () => undefined),
  unmute: vi.fn(async () => undefined),
  disconnect: vi.fn(async () => undefined),
  unpublish: vi.fn<() => Promise<void>>(async () => undefined),
  tracks: [] as EventTarget[],
  trackOptions: [] as unknown[],
  audioTrackFailuresRemaining: 0,
  missingDeviceIds: [] as string[],
  openedDeviceId: "microphone",
}));

vi.mock("livekit-client", () => ({
  RoomEvent: {
    Reconnecting: "reconnecting",
    Reconnected: "reconnected",
    Disconnected: "disconnected",
    MediaDevicesError: "mediaDevicesError",
  },
  Track: { Source: { Microphone: "microphone" } },
  createLocalAudioTrack: async (options: { deviceId?: { exact: string } }) => {
    media.trackOptions.push(options);
    if (media.audioTrackFailuresRemaining > 0) {
      media.audioTrackFailuresRemaining -= 1;
      throw new DOMException("signal is aborted without reason", "AbortError");
    }
    const requested = options.deviceId?.exact;
    if (requested && media.missingDeviceIds.includes(requested))
      throw new DOMException("gone", "OverconstrainedError");
    const deviceId = requested ?? media.openedDeviceId;
    const track = Object.assign(new EventTarget(), {
      getSettings: () => ({ deviceId }),
    });
    media.tracks.push(track);
    return {
      stop: media.stop,
      mute: media.mute,
      unmute: media.unmute,
      mediaStreamTrack: track,
      setDeviceId: async () => undefined,
    };
  },
  Room: class {
    localParticipant = {
      publishTrack: media.publish,
      unpublishTrack: media.unpublish,
    };
    on(event: string, listener: () => void) {
      media.listeners.set(event, listener);
    }
    async connect() {}
    async disconnect() {
      await media.disconnect();
    }
  },
}));

function ListenerState({ autoEnable = true }: { autoEnable?: boolean }) {
  const voice = useVoiceControl();
  const { enable } = voice;
  useEffect(() => {
    if (autoEnable) void enable().catch(() => undefined);
  }, [autoEnable, enable]);
  return (
    <>
      <output>{voice.listenerStatus}</output>
      <div aria-label="capture">
        {voice.captureState.status}:
        {"capture" in voice.captureState ? voice.captureState.capture?.id : ""}
      </div>
      {voice.listenerError ? <p role="alert">{voice.listenerError}</p> : null}
      <button onClick={() => void voice.disable()}>Disable</button>
      <button onClick={() => void voice.enable().catch(() => undefined)}>
        Enable
      </button>
      <button onClick={() => void voice.leavePage?.().catch(() => undefined)}>
        Leave
      </button>
      <button
        onClick={() =>
          void voice.selectTargetRoom?.("agent-direct").catch(() => undefined)
        }
      >
        Select Agent
      </button>
      <div aria-label="target">{voice.targetRoomId}</div>
      <button onClick={() => void voice.startCapture()}>Start</button>
      <button onClick={() => void voice.startNewCapture()}>Start new</button>
      <button onClick={() => void voice.stopCapture()}>Stop</button>
      <button onClick={() => void voice.setMicrophoneMuted(true)}>Pause</button>
      <div aria-label="microphone">
        {voice.microphoneMuted ? "muted" : "on"}
      </div>
      <div aria-label="transcript">
        {voice.transcriptItems.map((item) => (
          <p key={item.id}>{item.text}</p>
        ))}
        {voice.partialTranscript}
      </div>
    </>
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
  media.listeners.clear();
  media.tracks.length = 0;
  media.trackOptions.length = 0;
  media.audioTrackFailuresRemaining = 0;
  media.missingDeviceIds = [];
  media.openedDeviceId = "microphone";
  vi.clearAllMocks();
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
  window.localStorage.setItem(
    "linger.voice.device.tenant-northstar",
    JSON.stringify({ deviceId: "microphone", groupId: "desk", label: "Desk" }),
  );
});
afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

/**
 * Serves one accepted voice route through a spy; a JSON answer resolves as
 * its value so a test can read what the route returned.
 */
function spyVoiceRoute(
  runtime: TestTeamHubRuntime,
  accepted: ReturnType<typeof acceptVoice>,
  method: TestRouteMethod,
  path: TeamHubApiPath,
) {
  const handler = accepted(method, path);
  const spy = vi.fn(async (request: TestRouteRequest) => {
    const answer = await handler(request);
    return answer instanceof Response && answer.ok ? answer.json() : answer;
  });
  runtime.server.on(method, path, spy);
  return spy;
}

describe("LiveKit voice input lifecycle", () => {
  it("lends the microphone to Voice Mode while the Meeting is saving", async () => {
    const runtime = createTestTeamHubRuntime();
    const accepted = acceptVoice(runtime);
    const stop = spyVoiceRoute(
      runtime,
      accepted,
      "POST",
      "/v0/voice-captures/{captureSessionId}/stop",
    );
    const getCapture = accepted("GET", "/v0/voice-captures/{captureSessionId}");
    runtime.server.on(
      "GET",
      "/v0/voice-captures/{captureSessionId}",
      async (request) => {
        const stopped = await stop.mock.results[0]?.value;
        return stopped ?? getCapture(request);
      },
    );
    let voice!: VoiceControlContextValue;
    function CaptureVoice() {
      const current = useVoiceControl();
      useEffect(() => {
        voice = current;
      }, [current]);
      return <ListenerState />;
    }
    render(
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter>
          <LiveKitVoiceControlProvider tenantId="tenant-northstar">
            <CaptureVoice />
          </LiveKitVoiceControlProvider>
        </MemoryRouter>
      </TeamHubRuntimeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() =>
      expect(screen.getByLabelText("capture")).toHaveTextContent("recording:"),
    );
    await act(() => voice.leavePage?.());
    expect(screen.getByLabelText("capture")).toHaveTextContent("finalizing:");

    await act(async () => {
      const release = await voice.acquireComposerMicrophone({
        resumeListening: false,
      });
      expect(voice.captureState.status).toBe("finalizing");
      await release();
    });
    expect(stop).toHaveBeenCalledOnce();
  });

  it.each([3, 6])(
    "keeps microphone retry errors out of recording startup until %i failures are resolved",
    async (failures) => {
      media.audioTrackFailuresRemaining = failures;
      let releaseDiscovery!: () => void;
      const pendingDiscovery = new Promise<void>((resolve) => {
        releaseDiscovery = resolve;
      });
      const enumerateDevices = vi.fn(async () => {
        await pendingDiscovery;
        return [
          {
            deviceId: "microphone",
            groupId: "desk",
            kind: "audioinput",
            label: "Desk",
            toJSON: () => ({}),
          },
        ];
      });
      const previousMediaDevices = Object.getOwnPropertyDescriptor(
        navigator,
        "mediaDevices",
      );
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          addEventListener: vi.fn(),
          enumerateDevices,
          getUserMedia: vi.fn(),
          removeEventListener: vi.fn(),
        },
      });
      const runtime = createTestTeamHubRuntime();
      const accepted = acceptVoice(runtime);

      const start = spyVoiceRoute(
        runtime,
        accepted,
        "POST",
        "/v0/voice-sessions/{voiceSessionId}/captures",
      );
      const view = render(
        <TeamHubRuntimeProvider runtime={runtime}>
          <MemoryRouter>
            <LiveKitVoiceControlProvider tenantId="tenant-northstar">
              <VoiceFocusSurface autoStart onExit={vi.fn()} />
            </LiveKitVoiceControlProvider>
          </MemoryRouter>
        </TeamHubRuntimeProvider>,
      );
      try {
        await waitFor(() => expect(enumerateDevices).toHaveBeenCalledOnce());
        expect(
          screen.getByRole("heading", { name: "Starting recording…" }),
        ).toBeVisible();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        expect(start).not.toHaveBeenCalled();
        await act(async () => releaseDiscovery());
        if (failures === 3) {
          await waitFor(() => expect(start).toHaveBeenCalledOnce());
          expect(screen.getByLabelText("Recording duration")).toBeVisible();
          expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        } else {
          expect(
            await screen.findByRole("heading", {
              name: "Recording did not start",
            }),
          ).toBeVisible();
          expect(screen.getByRole("alert")).toHaveTextContent(
            "signal is aborted without reason",
          );
          expect(start).not.toHaveBeenCalled();
        }
      } finally {
        await act(async () => releaseDiscovery());
        view.unmount();
        if (previousMediaDevices)
          Object.defineProperty(
            navigator,
            "mediaDevices",
            previousMediaDevices,
          );
        else Reflect.deleteProperty(navigator, "mediaDevices");
      }
    },
  );

  it.each(["pending", "running", "failed"] as const)(
    "does not restore previous %s transcription while arming a new recording",
    async (recoveryStatus) => {
      const runtime = createTestTeamHubRuntime();
      const accepted = acceptVoice(runtime);

      const previousCapture: TeamHubVoiceCapture = {
        id: "capture_previous",
        room_id: "room-another-me",
        voice_session_id: "voice_session_previous",
        status: "recovering",
        transcript_recovery_status: recoveryStatus,
        audio_document_version_id: "audio_previous",
        requested_start_offset_ms: 0,
        gap_count: 0,
        gap_duration_ms: 0,
        created_at: "2026-09-19T00:00:00Z",
        updated_at: "2026-09-19T00:00:01Z",
      };
      runtime.server.on(
        "GET",
        "/v0/rooms/{roomId}/active-voice-capture",
        () => previousCapture,
      );
      const readCapture = accepted(
        "GET",
        "/v0/voice-captures/{captureSessionId}",
      );
      runtime.server.on(
        "GET",
        "/v0/voice-captures/{captureSessionId}",
        (request) =>
          request.params.captureSessionId === previousCapture.id
            ? previousCapture
            : readCapture(request),
      );
      const createCredential = accepted(
        "POST",
        "/v0/voice-sessions/{voiceSessionId}/connection-credentials",
      );
      let releaseCredential!: () => void;
      const pendingCredential = new Promise<void>((resolve) => {
        releaseCredential = resolve;
      });
      const credentials = vi.fn(async (request: TestRouteRequest) => {
        await pendingCredential;
        return createCredential(request);
      });
      runtime.server.on(
        "POST",
        "/v0/voice-sessions/{voiceSessionId}/connection-credentials",
        credentials,
      );
      const start = spyVoiceRoute(
        runtime,
        accepted,
        "POST",
        "/v0/voice-sessions/{voiceSessionId}/captures",
      );
      const view = render(
        <TeamHubRuntimeProvider runtime={runtime}>
          <MemoryRouter>
            <LiveKitVoiceControlProvider tenantId="tenant-northstar">
              <ListenerState autoEnable={false} />
              <VoiceFocusSurface autoStart onExit={vi.fn()} />
            </LiveKitVoiceControlProvider>
          </MemoryRouter>
        </TeamHubRuntimeProvider>,
      );
      try {
        await waitFor(() => expect(credentials).toHaveBeenCalledOnce());
        expect(screen.getByLabelText("capture")).toHaveTextContent("idle:");
        expect(
          screen.getByRole("heading", { name: "Starting recording…" }),
        ).toBeVisible();
        expect(
          screen.queryByRole("status", {
            name: "Recording transcript recovery",
          }),
        ).not.toBeInTheDocument();
        expect(media.stop).not.toHaveBeenCalled();
        await act(async () => releaseCredential());
        await waitFor(() => expect(start).toHaveBeenCalledOnce());
        await waitFor(() =>
          expect(screen.getByLabelText("capture")).toHaveTextContent(
            "recording:",
          ),
        );
        expect(screen.getByLabelText("capture")).not.toHaveTextContent(
          previousCapture.id,
        );
        expect(previousCapture.transcript_recovery_status).toBe(recoveryStatus);
      } finally {
        releaseCredential();
        view.unmount();
      }
    },
  );

  it("closes a late session response instead of publishing after pagehide", async () => {
    const runtime = createTestTeamHubRuntime();
    const accepted = acceptVoice(runtime);

    const create = accepted("POST", "/v0/rooms/{roomId}/voice-sessions");
    let finishCreation!: () => void;
    const pending = new Promise<void>((resolve) => {
      finishCreation = resolve;
    });
    const createSession = vi.fn(async (request: TestRouteRequest) => {
      const session = await create(request);
      await pending;
      return session;
    });
    runtime.server.on(
      "POST",
      "/v0/rooms/{roomId}/voice-sessions",
      createSession,
    );
    const closeSession = spyVoiceRoute(
      runtime,
      accepted,
      "DELETE",
      "/v0/voice-sessions/{voiceSessionId}",
    );
    render(
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter>
          <LiveKitVoiceControlProvider tenantId="tenant-northstar">
            <ListenerState />
          </LiveKitVoiceControlProvider>
        </MemoryRouter>
      </TeamHubRuntimeProvider>,
    );
    await waitFor(() => expect(createSession).toHaveBeenCalledOnce());
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    await act(async () => {
      finishCreation();
    });
    await waitFor(() => expect(closeSession).toHaveBeenCalledOnce());
    expect(media.publish).not.toHaveBeenCalled();
    expect(media.stop).toHaveBeenCalled();
    expect(
      screen.getByText("disabled", { selector: "output" }),
    ).toBeInTheDocument();
  });

  it("does not connect a remembered microphone until the page explicitly requests it", async () => {
    const runtime = createTestTeamHubRuntime();
    const accepted = acceptVoice(runtime);

    const createSession = spyVoiceRoute(
      runtime,
      accepted,
      "POST",
      "/v0/rooms/{roomId}/voice-sessions",
    );
    render(
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter>
          <LiveKitVoiceControlProvider tenantId="tenant-northstar">
            <ListenerState autoEnable={false} />
          </LiveKitVoiceControlProvider>
        </MemoryRouter>
      </TeamHubRuntimeProvider>,
    );
    await act(async () => undefined);
    expect(
      screen.getByText("disabled", { selector: "output" }),
    ).toBeInTheDocument();
    expect(createSession).not.toHaveBeenCalled();
    expect(media.publish).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    expect(
      await screen.findByText("listening", { selector: "output" }),
    ).toBeInTheDocument();
  });

  it("keeps the same microphone and session when the tab is hidden and visible again", async () => {
    const runtime = createTestTeamHubRuntime();
    const accepted = acceptVoice(runtime);

    const closeSession = spyVoiceRoute(
      runtime,
      accepted,
      "DELETE",
      "/v0/voice-sessions/{voiceSessionId}",
    );
    const stopCapture = spyVoiceRoute(
      runtime,
      accepted,
      "POST",
      "/v0/voice-captures/{captureSessionId}/stop",
    );
    const view = render(
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter>
          <LiveKitVoiceControlProvider tenantId="tenant-northstar">
            <ListenerState />
          </LiveKitVoiceControlProvider>
        </MemoryRouter>
      </TeamHubRuntimeProvider>,
    );
    expect(
      await screen.findByText("listening", { selector: "output" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() =>
      expect(screen.getByLabelText("capture")).toHaveTextContent("recording:"),
    );
    const capture = screen.getByLabelText("capture").textContent;
    const publications = media.publish.mock.calls.length;
    media.stop.mockClear();
    media.disconnect.mockClear();
    const visibility = vi.spyOn(document, "visibilityState", "get");
    try {
      for (const state of ["hidden", "visible"] as const) {
        visibility.mockReturnValue(state);
        await act(async () =>
          document.dispatchEvent(new Event("visibilitychange")),
        );
        expect(screen.getByLabelText("capture").textContent).toBe(capture);
        expect(
          screen.getByText("listening", { selector: "output" }),
        ).toBeInTheDocument();
        expect(media.stop).not.toHaveBeenCalled();
        expect(media.disconnect).not.toHaveBeenCalled();
        expect(stopCapture).not.toHaveBeenCalled();
        expect(closeSession).not.toHaveBeenCalled();
        expect(media.publish).toHaveBeenCalledTimes(publications);
      }
    } finally {
      visibility.mockRestore();
      view.unmount();
    }
  });

  it.each(["pagehide", "unmount", "leave"])(
    "cuts the microphone and session on %s without awaiting unpublish",
    async (exit) => {
      const runtime = createTestTeamHubRuntime();
      const accepted = acceptVoice(runtime);

      const closeSession = spyVoiceRoute(
        runtime,
        accepted,
        "DELETE",
        "/v0/voice-sessions/{voiceSessionId}",
      );
      const view = render(
        <TeamHubRuntimeProvider runtime={runtime}>
          <MemoryRouter>
            <LiveKitVoiceControlProvider tenantId="tenant-northstar">
              <ListenerState />
            </LiveKitVoiceControlProvider>
          </MemoryRouter>
        </TeamHubRuntimeProvider>,
      );
      expect(
        await screen.findByText("listening", { selector: "output" }),
      ).toBeInTheDocument();
      media.stop.mockClear();
      media.disconnect.mockClear();
      let finishUnpublish!: () => void;
      media.unpublish.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishUnpublish = resolve;
          }),
      );
      if (exit === "pagehide")
        act(() => {
          window.dispatchEvent(new Event("pagehide"));
        });
      else if (exit === "unmount") view.unmount();
      else fireEvent.click(screen.getByRole("button", { name: "Leave" }));
      expect(media.stop).toHaveBeenCalled();
      expect(media.disconnect).toHaveBeenCalled();
      await waitFor(() => expect(closeSession).toHaveBeenCalledOnce());
      const publications = media.publish.mock.calls.length;
      await act(async () => {
        finishUnpublish();
      });
      if (exit !== "unmount") {
        expect(
          screen.getByText("disabled", { selector: "output" }),
        ).toBeInTheDocument();
        expect(media.publish).toHaveBeenCalledTimes(publications);
      }
    },
  );

  it("opens the bound microphone, falls back to the system default once it is gone, and binds what opened", async () => {
    media.missingDeviceIds = ["microphone"];
    media.openedDeviceId = "usb";
    const input = (deviceId: string, label: string) => ({
      deviceId,
      groupId: `${deviceId}-group`,
      kind: "audioinput",
      label,
      toJSON: () => ({}),
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        addEventListener: vi.fn(),
        enumerateDevices: vi.fn(async () => [
          input("microphone", "Desk"),
          input("usb", "USB microphone"),
        ]),
        getUserMedia: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    const runtime = createTestTeamHubRuntime();
    acceptVoice(runtime);

    const view = render(
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter>
          <LiveKitVoiceControlProvider tenantId="tenant-northstar">
            <ListenerState />
          </LiveKitVoiceControlProvider>
        </MemoryRouter>
      </TeamHubRuntimeProvider>,
    );
    await waitFor(() =>
      expect(
        JSON.parse(
          window.localStorage.getItem("linger.voice.device.tenant-northstar")!,
        ),
      ).toMatchObject({ deviceId: "usb", label: "USB microphone" }),
    );
    expect(media.trackOptions).toEqual([
      expect.objectContaining({ deviceId: { exact: "microphone" } }),
      expect.objectContaining({ deviceId: undefined }),
    ]);
    view.unmount();
  });

  it("resumes listening when the interrupted microphone comes back", async () => {
    let deviceChanged = () => {};
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        addEventListener: vi.fn((_: string, listener: () => void) => {
          deviceChanged = listener;
        }),
        enumerateDevices: vi.fn(async () => [
          {
            deviceId: "microphone",
            groupId: "desk",
            kind: "audioinput",
            label: "Desk",
            toJSON: () => ({}),
          },
        ]),
        getUserMedia: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    const runtime = createTestTeamHubRuntime();
    acceptVoice(runtime);

    const view = render(
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter>
          <LiveKitVoiceControlProvider tenantId="tenant-northstar">
            <ListenerState />
          </LiveKitVoiceControlProvider>
        </MemoryRouter>
      </TeamHubRuntimeProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("listening"),
    );
    act(() => {
      media.tracks.at(-1)!.dispatchEvent(new Event("ended"));
    });
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "device_disconnected",
      ),
    );
    const publications = media.publish.mock.calls.length;
    act(() => deviceChanged());
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("listening"),
    );
    expect(media.publish).toHaveBeenCalledTimes(publications + 1);
    view.unmount();
  });

  it("retries a transient microphone abort and then listens", async () => {
    media.audioTrackFailuresRemaining = 1;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        addEventListener: vi.fn(),
        enumerateDevices: vi.fn(async () => [
          {
            deviceId: "microphone",
            groupId: "desk",
            kind: "audioinput",
            label: "Desk",
            toJSON: () => ({}),
          },
        ]),
        getUserMedia: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    const runtime = createTestTeamHubRuntime();
    acceptVoice(runtime);

    const view = render(
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter>
          <LiveKitVoiceControlProvider tenantId="tenant-northstar">
            <ListenerState />
          </LiveKitVoiceControlProvider>
        </MemoryRouter>
      </TeamHubRuntimeProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("listening"),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    view.unmount();
  });

  it("keeps SSE subscribed through presentation rerenders and projects Stop without waiting for polling", async () => {
    const runtime = createTestTeamHubRuntime();
    const accepted = acceptVoice(runtime);

    const subscriptions: VoiceEventSubscription[] = [];
    const closed = vi.fn();
    runtime.voiceEvents = {
      subscribe: vi.fn((input: VoiceEventSubscription) => {
        subscriptions.push(input);
        return Object.assign(closed, { catchUp: async () => undefined });
      }),
    };
    const getCapture = spyVoiceRoute(
      runtime,
      accepted,
      "GET",
      "/v0/voice-captures/{captureSessionId}",
    );
    const tree = (label: string) => (
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter>
          <LiveKitVoiceControlProvider tenantId="tenant-northstar">
            <span>{label}</span>
            <ListenerState />
          </LiveKitVoiceControlProvider>
        </MemoryRouter>
      </TeamHubRuntimeProvider>
    );
    const view = render(tree("first"));
    await waitFor(() => expect(subscriptions).toHaveLength(1));
    act(() => subscriptions[0]!.onMode("sse"));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() =>
      expect(screen.getByLabelText("capture")).toHaveTextContent("recording:"),
    );
    view.rerender(tree("second"));
    expect(subscriptions).toHaveLength(1);
    expect(closed).not.toHaveBeenCalled();
    const captureId = screen
      .getByLabelText("capture")
      .textContent.split(":")[1]!;
    const capture = await teamHubData(
      runtime.client.api.GET("/v0/voice-captures/{captureSessionId}", {
        params: { path: { captureSessionId: captureId } },
      }),
    );
    const before = getCapture.mock.calls.length;
    act(() =>
      subscriptions[0]!.onEvents({
        next_cursor: `${capture.voice_session_id}:2`,
        has_more: false,
        items: [
          {
            kind: "capture",
            capture: {
              ...capture,
              status: "finalizing",
              updated_at: new Date(Date.now() + 1000).toISOString(),
            },
          },
        ],
      }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("capture")).toHaveTextContent("finalizing:"),
    );
    expect(getCapture).toHaveBeenCalledTimes(before);
    await waitFor(() => expect(media.stop).toHaveBeenCalledOnce());
    expect(subscriptions).toHaveLength(1);
    view.unmount();
    expect(closed).toHaveBeenCalledOnce();
  });

  it("aborts an in-flight active-capture resync when SSE delivers finalizing without duplicating the GET", async () => {
    vi.useFakeTimers();
    const runtime = createTestTeamHubRuntime();
    const accepted = acceptVoice(runtime);
    const subscriptions: VoiceEventSubscription[] = [];
    runtime.voiceEvents = {
      subscribe: vi.fn((input: VoiceEventSubscription) => {
        subscriptions.push(input);
        return Object.assign(vi.fn(), { catchUp: async () => undefined });
      }),
    };
    const start = spyVoiceRoute(
      runtime,
      accepted,
      "POST",
      "/v0/voice-sessions/{voiceSessionId}/captures",
    );
    const readCapture = accepted(
      "GET",
      "/v0/voice-captures/{captureSessionId}",
    );
    let holdResync = false;
    let resyncAborted = false;
    const getCapture = vi.fn(async (request: TestRouteRequest) => {
      if (!holdResync) return readCapture(request);
      return new Promise((_resolve, reject) => {
        const abort = () => {
          resyncAborted = true;
          reject(request.request.signal.reason);
        };
        if (request.request.signal.aborted) {
          abort();
          return;
        }
        request.request.signal.addEventListener("abort", abort, { once: true });
      });
    });
    runtime.server.on(
      "GET",
      "/v0/voice-captures/{captureSessionId}",
      getCapture,
    );
    const view = render(
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter>
          <LiveKitVoiceControlProvider tenantId="tenant-northstar">
            <ListenerState />
          </LiveKitVoiceControlProvider>
        </MemoryRouter>
      </TeamHubRuntimeProvider>,
    );
    try {
      await act(async () => vi.advanceTimersByTimeAsync(0));
      expect(subscriptions).toHaveLength(1);
      act(() => subscriptions[0]!.onMode("sse"));
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
      await act(async () => vi.advanceTimersByTimeAsync(0));
      const capture = (await start.mock.results[0]!
        .value) as TeamHubVoiceCapture;
      expect(screen.getByLabelText("capture")).toHaveTextContent(
        `recording:${capture.id}`,
      );
      const beforeReconnect = getCapture.mock.calls.length;
      expect(beforeReconnect).toBe(1);

      // Reconnect SSE while the Capture is already recording and hold its
      // resync read in flight until live SSE delivers finalizing.
      holdResync = true;
      act(() => {
        subscriptions[0]!.onMode("recovering");
        subscriptions[0]!.onMode("sse");
      });
      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      expect(getCapture).toHaveBeenCalledTimes(beforeReconnect + 1);
      expect(resyncAborted).toBe(false);

      act(() =>
        subscriptions[0]!.onEvents({
          next_cursor: `${capture.voice_session_id}:2`,
          has_more: false,
          items: [
            {
              kind: "capture",
              capture: {
                ...capture,
                status: "finalizing",
                updated_at: new Date(
                  Date.parse(capture.updated_at) + 1_000,
                ).toISOString(),
              },
            },
          ],
        }),
      );
      await act(async () => vi.advanceTimersByTimeAsync(0));
      expect(screen.getByLabelText("capture")).toHaveTextContent(
        `finalizing:${capture.id}`,
      );
      expect(resyncAborted).toBe(true);
      expect(getCapture).toHaveBeenCalledTimes(beforeReconnect + 1);

      await act(async () => vi.advanceTimersByTimeAsync(1_500));
      expect(getCapture).toHaveBeenCalledTimes(beforeReconnect + 1);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it("runs a single resync read after SSE goes live on an existing Capture and stays idle afterwards", async () => {
    vi.useFakeTimers();
    const runtime = createTestTeamHubRuntime();
    const accepted = acceptVoice(runtime);
    const subscriptions: VoiceEventSubscription[] = [];
    runtime.voiceEvents = {
      subscribe: vi.fn((input: VoiceEventSubscription) => {
        subscriptions.push(input);
        return Object.assign(vi.fn(), { catchUp: async () => undefined });
      }),
    };
    const start = spyVoiceRoute(
      runtime,
      accepted,
      "POST",
      "/v0/voice-sessions/{voiceSessionId}/captures",
    );
    const readCapture = accepted(
      "GET",
      "/v0/voice-captures/{captureSessionId}",
    );
    let serverFinalizing = false;
    const getCapture = vi.fn(async (request: TestRouteRequest) => {
      const answer = await readCapture(request);
      const current = (
        answer instanceof Response ? await answer.json() : answer
      ) as TeamHubVoiceCapture;
      if (!serverFinalizing) return current;
      return {
        ...current,
        status: "finalizing" as const,
        updated_at: new Date(
          Date.parse(current.updated_at) + 1_000,
        ).toISOString(),
      };
    });
    runtime.server.on(
      "GET",
      "/v0/voice-captures/{captureSessionId}",
      getCapture,
    );
    const view = render(
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter>
          <LiveKitVoiceControlProvider tenantId="tenant-northstar">
            <ListenerState />
          </LiveKitVoiceControlProvider>
        </MemoryRouter>
      </TeamHubRuntimeProvider>,
    );
    try {
      await act(async () => vi.advanceTimersByTimeAsync(0));
      expect(subscriptions).toHaveLength(1);
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
      await act(async () => vi.advanceTimersByTimeAsync(0));
      const capture = (await start.mock.results[0]!
        .value) as TeamHubVoiceCapture;
      expect(screen.getByLabelText("capture")).toHaveTextContent(
        `recording:${capture.id}`,
      );
      const beforeSse = getCapture.mock.calls.length;
      expect(beforeSse).toBe(1);

      serverFinalizing = true;
      act(() => subscriptions[0]!.onMode("sse"));
      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      expect(getCapture).toHaveBeenCalledTimes(beforeSse + 1);
      expect(screen.getByLabelText("capture")).toHaveTextContent(
        `finalizing:${capture.id}`,
      );

      // While SSE remains live, finalizing polling must not issue further GETs.
      await act(async () => vi.advanceTimersByTimeAsync(2_000));
      expect(getCapture).toHaveBeenCalledTimes(beforeSse + 1);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it("resyncs a restored finalizing Capture when SSE went live before restore settled", async () => {
    vi.useFakeTimers();
    const runtime = createTestTeamHubRuntime();
    acceptVoice(runtime);
    const subscriptions: VoiceEventSubscription[] = [];
    runtime.voiceEvents = {
      subscribe: vi.fn((input: VoiceEventSubscription) => {
        subscriptions.push(input);
        return Object.assign(vi.fn(), { catchUp: async () => undefined });
      }),
    };
    let releaseRestore!: (capture: TeamHubVoiceCapture) => void;
    let restoredRoomId = "";
    const activeCaptureRead = vi.fn(
      (request: TestRouteRequest) =>
        new Promise<TeamHubVoiceCapture>((resolve) => {
          restoredRoomId = request.params.roomId!;
          releaseRestore = resolve;
        }),
    );
    runtime.server.on(
      "GET",
      "/v0/rooms/{roomId}/active-voice-capture",
      activeCaptureRead,
    );
    let finalizedSnapshot!: TeamHubVoiceCapture;
    const getCapture = vi.fn(() => finalizedSnapshot);
    runtime.server.on(
      "GET",
      "/v0/voice-captures/{captureSessionId}",
      getCapture,
    );
    const view = render(
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter>
          <LiveKitVoiceControlProvider tenantId="tenant-northstar">
            <ListenerState />
          </LiveKitVoiceControlProvider>
        </MemoryRouter>
      </TeamHubRuntimeProvider>,
    );
    try {
      await act(async () => vi.advanceTimersByTimeAsync(0));
      expect(subscriptions).toHaveLength(1);
      expect(activeCaptureRead).toHaveBeenCalledOnce();
      expect(screen.getByLabelText("capture")).toHaveTextContent("idle:");

      const voiceSessionId = subscriptions[0]!.voiceSessionId;
      const staleFinalizing: TeamHubVoiceCapture = {
        id: "capture_restored",
        room_id: restoredRoomId,
        voice_session_id: voiceSessionId,
        status: "finalizing",
        audio_document_version_id: "audio_restored",
        requested_start_offset_ms: 0,
        gap_count: 0,
        gap_duration_ms: 0,
        created_at: "2026-09-19T00:00:00Z",
        updated_at: "2026-09-19T00:00:01Z",
      };
      finalizedSnapshot = {
        ...staleFinalizing,
        status: "finalized",
        updated_at: "2026-09-19T00:00:02Z",
      };

      // SSE goes live and drops a bootstrap terminal event while captureRef
      // is still undefined because restoreActiveCapture has not settled yet.
      act(() => {
        subscriptions[0]!.onMode("sse");
        subscriptions[0]!.onEvents({
          next_cursor: `${voiceSessionId}:1`,
          has_more: false,
          items: [{ kind: "capture", capture: finalizedSnapshot }],
        });
      });
      expect(getCapture).not.toHaveBeenCalled();

      act(() => releaseRestore(staleFinalizing));
      await act(async () => vi.advanceTimersByTimeAsync(0));

      expect(getCapture).toHaveBeenCalledTimes(1);
      expect(screen.getByLabelText("capture")).toHaveTextContent(
        `completed:${staleFinalizing.id}`,
      );

      await act(async () => vi.advanceTimersByTimeAsync(2_000));
      expect(getCapture).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it("records into a selected general Agent room and refuses to retarget an active Capture", async () => {
    const runtime = createTestTeamHubRuntime();
    const accepted = acceptVoice(runtime);

    const anotherMe = await teamHubData(
      runtime.client.api.GET("/v0/tenants/{tenantId}/another-me", {
        params: { path: { tenantId: "tenant-northstar" } },
      }),
    );
    const originalRoom = await teamHubData(
      runtime.client.api.GET("/v0/rooms/{roomId}", {
        params: { path: { roomId: anotherMe.room_id! } },
      }),
    );
    runtime.server.on("GET", "/v0/rooms/{roomId}", () => ({
      ...originalRoom,
      id: "agent-direct",
      direct_peer: {
        ...originalRoom.direct_peer!,
        id: "general-agent",
        display_name: "General Agent",
        kind: "agent",
      },
    }));
    const createSession = spyVoiceRoute(
      runtime,
      accepted,
      "POST",
      "/v0/rooms/{roomId}/voice-sessions",
    );
    const start = spyVoiceRoute(
      runtime,
      accepted,
      "POST",
      "/v0/voice-sessions/{voiceSessionId}/captures",
    );
    const view = render(
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter>
          <LiveKitVoiceControlProvider tenantId="tenant-northstar">
            <ListenerState />
          </LiveKitVoiceControlProvider>
        </MemoryRouter>
      </TeamHubRuntimeProvider>,
    );
    await waitFor(() => expect(media.publish).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() =>
      expect(screen.getByLabelText("capture")).toHaveTextContent("recording:"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Select Agent" }));
    expect(screen.getByLabelText("target")).toHaveTextContent(
      anotherMe.room_id!,
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() =>
      expect(screen.getByLabelText("capture")).toHaveTextContent("completed:"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Select Agent" }));
    await waitFor(() =>
      expect(screen.getByLabelText("target")).toHaveTextContent("agent-direct"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(createSession.mock.calls.at(-1)?.[0].params.roomId).toBe(
      "agent-direct",
    );
    expect(start.mock.calls.at(-1)?.[0].body).toMatchObject({
      room_id: "agent-direct",
    });
    view.unmount();
    const publications = media.publish.mock.calls.length;
    const restored = render(
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter>
          <LiveKitVoiceControlProvider tenantId="tenant-northstar">
            <ListenerState autoEnable={false} />
          </LiveKitVoiceControlProvider>
        </MemoryRouter>
      </TeamHubRuntimeProvider>,
    );
    await waitFor(() =>
      expect(screen.getByLabelText("target")).toHaveTextContent("agent-direct"),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("capture")).toHaveTextContent("idle:"),
    );
    expect(media.publish).toHaveBeenCalledTimes(publications);
    expect(start).toHaveBeenCalledTimes(2);
    restored.unmount();
  });

  it("releases the microphone after background Stop and reconnects only for an explicit Start", async () => {
    const fixture = createTestTeamHubRuntime();
    const accepted = acceptVoice(fixture);

    let onActivity: (active: boolean) => void = () => undefined;
    const runtime = {
      ...fixture,
      pageActivity: {
        isActive: () => true,
        subscribe: (listener: (active: boolean) => void) => {
          onActivity = listener;
          return () => undefined;
        },
      },
    };
    const start = spyVoiceRoute(
      runtime,
      accepted,
      "POST",
      "/v0/voice-sessions/{voiceSessionId}/captures",
    );
    const view = render(
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter>
          <LiveKitVoiceControlProvider tenantId="tenant-northstar">
            <ListenerState />
          </LiveKitVoiceControlProvider>
        </MemoryRouter>
      </TeamHubRuntimeProvider>,
    );
    await waitFor(() => expect(media.publish).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() =>
      expect(screen.getByLabelText("capture")).toHaveTextContent("recording:"),
    );
    act(() => onActivity(false));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() =>
      expect(screen.getByLabelText("capture")).toHaveTextContent("completed:"),
    );
    expect(media.stop).toHaveBeenCalledOnce();
    expect(media.publish).toHaveBeenCalledOnce();
    expect(screen.getByRole("status")).toHaveTextContent("disabled");
    act(() => onActivity(true));
    expect(media.publish).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Start new" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByLabelText("capture")).toHaveTextContent("recording:"),
    );
    view.unmount();
  });

  it("starts a distinct Capture after a stopped recording fails to materialize", async () => {
    const runtime = createTestTeamHubRuntime();
    const accepted = acceptVoice(runtime);

    const start = spyVoiceRoute(
      runtime,
      accepted,
      "POST",
      "/v0/voice-sessions/{voiceSessionId}/captures",
    );
    const readCapture = accepted(
      "GET",
      "/v0/voice-captures/{captureSessionId}",
    );
    const read = vi.fn(readCapture);
    runtime.server.on("GET", "/v0/voice-captures/{captureSessionId}", read);
    const stopCapture = accepted(
      "POST",
      "/v0/voice-captures/{captureSessionId}/stop",
    );
    runtime.server.on(
      "POST",
      "/v0/voice-captures/{captureSessionId}/stop",
      async (request) => {
        const stopped = (await stopCapture(request)) as TeamHubVoiceCapture;
        read.mockImplementation((readRequest) =>
          readRequest.params.captureSessionId === stopped.id
            ? {
                ...stopped,
                last_failure_code: "materialization_failed",
                status: "failed",
                updated_at: new Date(
                  Date.parse(stopped.updated_at) + 1_000,
                ).toISOString(),
              }
            : readCapture(readRequest),
        );
        return stopped;
      },
    );
    const view = render(
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter>
          <LiveKitVoiceControlProvider tenantId="tenant-northstar">
            <ListenerState />
          </LiveKitVoiceControlProvider>
        </MemoryRouter>
      </TeamHubRuntimeProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("listening"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    const first = (await start.mock.results[0]!.value) as TeamHubVoiceCapture;
    await waitFor(() =>
      expect(screen.getByLabelText("capture")).toHaveTextContent(
        `recording:${first.id}`,
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() =>
      expect(screen.getByLabelText("capture")).toHaveTextContent(
        `failed:${first.id}`,
      ),
    );
    expect(media.stop).toHaveBeenCalledOnce();
    expect(screen.getByRole("status")).toHaveTextContent("disabled");

    fireEvent.click(screen.getByRole("button", { name: "Start new" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    const second = (await start.mock.results[1]!.value) as TeamHubVoiceCapture;
    expect(second.id).not.toBe(first.id);
    await waitFor(() =>
      expect(screen.getByLabelText("capture")).toHaveTextContent(
        `recording:${second.id}`,
      ),
    );
    view.unmount();
  });

  it.each(["disconnected", "mediaDevicesError", "ended", "reconnected"])(
    "releases the publisher after terminal %s and ignores stale connection events",
    async (event) => {
      const runtime = createTestTeamHubRuntime();
      acceptVoice(runtime);

      const release = vi.fn();
      vi.spyOn(
        publisherLease,
        "tryAcquireVoicePublisherLease",
      ).mockResolvedValue(release);
      const view = render(
        <TeamHubRuntimeProvider runtime={runtime}>
          <MemoryRouter>
            <LiveKitVoiceControlProvider tenantId="tenant-northstar">
              <ListenerState />
            </LiveKitVoiceControlProvider>
          </MemoryRouter>
        </TeamHubRuntimeProvider>,
      );
      await waitFor(() =>
        expect(screen.getByRole("status")).toHaveTextContent("listening"),
      );
      const oldDisconnected = media.listeners.get("disconnected")!;
      if (event === "reconnected")
        runtime.server.on("GET", "/v0/voice-sessions/{voiceSessionId}", () =>
          teamHubErrorResponse(404, "NOT_FOUND", "Session closed"),
        );
      act(() => {
        if (event === "ended")
          media.tracks[0]!.dispatchEvent(new Event("ended"));
        else media.listeners.get(event)!();
      });
      await waitFor(() => expect(release).toHaveBeenCalledOnce());
      expect(media.stop).toHaveBeenCalledOnce();
      act(() => oldDisconnected());
      expect(release).toHaveBeenCalledOnce();
      view.unmount();
      expect(media.stop).toHaveBeenCalledOnce();
    },
  );

  it("renders a final that says end recording as ordinary transcript without changing the Capture", async () => {
    const runtime = createTestTeamHubRuntime();
    const accepted = acceptVoice(runtime);

    let feed: TeamHubVoiceTranscriptEventPage = { items: [] };
    runtime.server.on(
      "GET",
      "/v0/voice-sessions/{voiceSessionId}/transcript-events",
      () => feed,
    );
    const start = spyVoiceRoute(
      runtime,
      accepted,
      "POST",
      "/v0/voice-sessions/{voiceSessionId}/captures",
    );
    const stop = spyVoiceRoute(
      runtime,
      accepted,
      "POST",
      "/v0/voice-captures/{captureSessionId}/stop",
    );
    const view = render(
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter>
          <LiveKitVoiceControlProvider tenantId="tenant-northstar">
            <ListenerState />
          </LiveKitVoiceControlProvider>
        </MemoryRouter>
      </TeamHubRuntimeProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("listening"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    const capture = (await start.mock.results[0]!.value) as TeamHubVoiceCapture;
    await waitFor(() =>
      expect(screen.getByLabelText("capture")).toHaveTextContent(
        `recording:${capture.id}`,
      ),
    );
    feed = {
      items: [
        {
          id: "spoken-stop",
          event_id: "spoken-stop",
          voice_session_id: capture.voice_session_id,
          capture_session_id: capture.id,
          kind: "speech",
          lane: "live",
          media_epoch: 0,
          start_offset_ms: 0,
          end_offset_ms: 1000,
          text: "end recording",
          accepted_at: capture.created_at,
          updated_at: capture.created_at,
        },
      ],
    };
    await waitFor(() =>
      expect(screen.getByLabelText("transcript")).toHaveTextContent(
        "end recording",
      ),
    );
    expect(screen.getByLabelText("capture")).toHaveTextContent(
      `recording:${capture.id}`,
    );
    expect(stop).not.toHaveBeenCalled();
    view.unmount();
  });

  it("starts a new Capture with the microphone on after the previous one ended paused", async () => {
    const runtime = createTestTeamHubRuntime();
    const accepted = acceptVoice(runtime);

    const start = spyVoiceRoute(
      runtime,
      accepted,
      "POST",
      "/v0/voice-sessions/{voiceSessionId}/captures",
    );
    const view = render(
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter>
          <LiveKitVoiceControlProvider tenantId="tenant-northstar">
            <ListenerState />
          </LiveKitVoiceControlProvider>
        </MemoryRouter>
      </TeamHubRuntimeProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("listening"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() =>
      expect(screen.getByLabelText("capture")).toHaveTextContent("recording:"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() =>
      expect(screen.getByLabelText("microphone")).toHaveTextContent("muted"),
    );
    expect(media.mute).toHaveBeenCalledOnce();
    // Start on the Capture that is still running keeps its pause.
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(media.unmute).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() =>
      expect(screen.getByLabelText("capture")).toHaveTextContent("completed:"),
    );
    expect(media.unmute).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Start new" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByLabelText("capture")).toHaveTextContent("recording:"),
    );
    expect(screen.getByLabelText("microphone")).toHaveTextContent("on");
    expect(media.unmute).toHaveBeenCalledOnce();
    // The recorder and transcription hear the new Capture from its first moment.
    expect(media.unmute.mock.invocationCallOrder[0]).toBeLessThan(
      start.mock.invocationCallOrder[1]!,
    );
    view.unmount();
  });

  it("ignores a delayed Human Stop acknowledgement after polling finishes it and a new Capture starts", async () => {
    const runtime = createTestTeamHubRuntime();
    const accepted = acceptVoice(runtime);

    const start = spyVoiceRoute(
      runtime,
      accepted,
      "POST",
      "/v0/voice-sessions/{voiceSessionId}/captures",
    );
    const stop = accepted("POST", "/v0/voice-captures/{captureSessionId}/stop");
    let acknowledge: (() => void) | undefined;
    runtime.server.on(
      "POST",
      "/v0/voice-captures/{captureSessionId}/stop",
      async (request) => {
        const stopped = await stop(request);
        return new Promise((resolve) => {
          acknowledge = () => resolve(stopped);
        });
      },
    );
    const view = render(
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter>
          <LiveKitVoiceControlProvider tenantId="tenant-northstar">
            <ListenerState />
          </LiveKitVoiceControlProvider>
        </MemoryRouter>
      </TeamHubRuntimeProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("listening"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() =>
      expect(screen.getByLabelText("capture")).toHaveTextContent("recording:"),
    );
    const first = (await start.mock.results[0]!.value) as TeamHubVoiceCapture;
    runtime.server.on(
      "GET",
      "/v0/voice-captures/{captureSessionId}",
      vi
        .fn(accepted("GET", "/v0/voice-captures/{captureSessionId}"))
        .mockReturnValueOnce({ ...first, status: "finalizing" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(acknowledge).toBeDefined());
    await waitFor(() =>
      expect(screen.getByLabelText("capture")).toHaveTextContent("completed:"),
    );
    expect(media.publish).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Start new" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    const second = (await start.mock.results[1]!.value) as TeamHubVoiceCapture;
    await act(async () => acknowledge!());
    expect(screen.getByLabelText("capture")).toHaveTextContent(
      `recording:${second.id}`,
    );
    expect(media.stop).toHaveBeenCalledOnce();
    expect(
      JSON.parse(
        window.localStorage.getItem("linger.voice.listening.tenant-northstar")!,
      ),
    ).toMatchObject({ captureId: second.id, stopped: false });
    view.unmount();
  });

  it("keeps the microphone and live transcription when its tab loses foreground activity", async () => {
    const fixture = createTestTeamHubRuntime();
    acceptVoice(fixture);

    let onActivity: (active: boolean) => void = () => undefined;
    const runtime = {
      ...fixture,
      pageActivity: {
        isActive: () => true,
        subscribe: (listener: (active: boolean) => void) => {
          onActivity = listener;
          return () => undefined;
        },
      },
    };
    const feed = () =>
      runtime.server.requestsTo(
        "GET",
        "/v0/voice-sessions/{voiceSessionId}/transcript-events",
      ).length;
    const view = render(
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter>
          <LiveKitVoiceControlProvider tenantId="tenant-northstar">
            <ListenerState />
          </LiveKitVoiceControlProvider>
        </MemoryRouter>
      </TeamHubRuntimeProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("listening"),
    );
    await act(async () => onActivity(false));
    expect(media.stop).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("listening");
    const reads = feed();
    await waitFor(() => expect(feed()).toBeGreaterThan(reads));
    view.unmount();
    await waitFor(() => expect(media.stop).toHaveBeenCalledOnce());
  });

  it("keeps a new Capture free of the previous transcript, including delayed history", async () => {
    const runtime = createTestTeamHubRuntime();
    const accepted = acceptVoice(runtime);

    let feed: TeamHubVoiceTranscriptEventPage = { items: [] };
    runtime.server.on(
      "GET",
      "/v0/voice-sessions/{voiceSessionId}/transcript-events",
      () => feed,
    );
    const start = spyVoiceRoute(
      runtime,
      accepted,
      "POST",
      "/v0/voice-sessions/{voiceSessionId}/captures",
    );
    const view = render(
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter>
          <LiveKitVoiceControlProvider tenantId="tenant-northstar">
            <ListenerState />
          </LiveKitVoiceControlProvider>
        </MemoryRouter>
      </TeamHubRuntimeProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("listening"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    const first = (await start.mock.results[0]!.value) as TeamHubVoiceCapture;
    const event = {
      id: "old-final",
      event_id: "old-final",
      voice_session_id: first.voice_session_id,
      capture_session_id: first.id,
      kind: "speech" as const,
      lane: "live" as const,
      media_epoch: 0,
      start_offset_ms: 0,
      end_offset_ms: 1000,
      text: "Previous recording",
      accepted_at: first.created_at,
      updated_at: first.created_at,
    };
    feed = { items: [event] };
    await screen.findByText("Previous recording");
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(media.stop).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("disabled"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start new" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    const second = (await start.mock.results[1]!.value) as TeamHubVoiceCapture;
    feed = {
      items: [
        event,
        {
          ...event,
          id: "new-final",
          event_id: "new-final",
          capture_session_id: second.id,
          text: "This recording",
          accepted_at: second.created_at,
          updated_at: second.created_at,
        },
      ],
    };
    await screen.findByText("This recording");
    expect(screen.getByLabelText("transcript")).not.toHaveTextContent(
      "Previous recording",
    );
    view.unmount();
  });

  it.each([true, false])(
    "cancels late credentials after disconnect (unmount=%s)",
    async (unmount) => {
      const runtime = createTestTeamHubRuntime();
      const accepted = acceptVoice(runtime);

      const issueCredential = accepted(
        "POST",
        "/v0/voice-sessions/{voiceSessionId}/connection-credentials",
      );
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const issue = vi.fn(async (request: TestRouteRequest) => {
        await released;
        return issueCredential(request);
      });
      runtime.server.on(
        "POST",
        "/v0/voice-sessions/{voiceSessionId}/connection-credentials",
        issue,
      );
      const view = render(
        <TeamHubRuntimeProvider runtime={runtime}>
          <MemoryRouter>
            <LiveKitVoiceControlProvider tenantId="tenant-northstar">
              <ListenerState />
            </LiveKitVoiceControlProvider>
          </MemoryRouter>
        </TeamHubRuntimeProvider>,
      );
      await waitFor(() => expect(issue).toHaveBeenCalledOnce());
      if (unmount) view.unmount();
      else fireEvent.click(screen.getByRole("button", { name: "Disable" }));
      await act(async () => release());
      expect(media.publish).not.toHaveBeenCalled();
      if (!unmount)
        expect(screen.getByRole("status")).toHaveTextContent("disabled");
    },
  );

  it("waits for Runtime input readiness on initial connect and reconnect", async () => {
    const runtime = createTestTeamHubRuntime();
    const accepted = acceptVoice(runtime);

    const getSession = accepted("GET", "/v0/voice-sessions/{voiceSessionId}");
    let ready = false;
    runtime.server.on(
      "GET",
      "/v0/voice-sessions/{voiceSessionId}",
      async (request) => {
        const session = (await getSession(request)) as TeamHubVoiceSession;
        return {
          ...session,
          input_ready_generation: ready ? session.credential_generation : 0,
        };
      },
    );
    const view = render(
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter>
          <LiveKitVoiceControlProvider tenantId="tenant-northstar">
            <ListenerState />
          </LiveKitVoiceControlProvider>
        </MemoryRouter>
      </TeamHubRuntimeProvider>,
    );
    await waitFor(() => expect(media.publish).toHaveBeenCalledOnce());
    expect(screen.getByRole("status")).toHaveTextContent("enabling");
    ready = true;
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("listening"),
    );

    ready = false;
    act(() => media.listeners.get("reconnecting")?.());
    expect(screen.getByRole("status")).toHaveTextContent("enabling");
    act(() => media.listeners.get("reconnected")?.());
    expect(screen.getByRole("status")).toHaveTextContent("enabling");
    ready = true;
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("listening"),
    );
    expect(media.publish).toHaveBeenCalledOnce();

    view.unmount();
    await waitFor(() => expect(media.stop).toHaveBeenCalledOnce());
  });
});
