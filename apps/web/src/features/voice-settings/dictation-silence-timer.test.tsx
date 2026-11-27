// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { usePocketDictation } from "@/features/rooms/pocket-notes/use-pocket-dictation";
import { smoothVoiceLevel } from "@/features/rooms/chat/voice-mode/voice-media-room";
import type { VoiceModeEvent } from "@/features/rooms/chat/voice-mode/voice-mode-controller";
import type { VoiceModeSession } from "@/features/rooms/chat/voice-mode/voice-mode-session";
import { createVoiceModeSessionEngine } from "@/features/rooms/chat/voice-mode/voice-mode-session-engine";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";

import {
  createDictationSilenceTimer,
  VOICE_SILENCE_ACTIVITY_THRESHOLD,
} from "./dictation-silence-timer";
import {
  DEFAULT_VOICE_SETTINGS,
  voiceSettingsQueryKey,
} from "./voice-settings-queries";

interface DictationConnection {
  close: ReturnType<typeof vi.fn>;
  level?: (level: number) => void;
  receive: (event: VoiceModeEvent) => void;
}

const mocks = vi.hoisted(() => ({
  dictationConnections: [] as DictationConnection[],
  liveClose: vi.fn(async () => undefined),
  liveOpened: undefined as
    | {
        channel?: (connection: unknown) => void;
        level?: (level: number) => void;
        providerReady?: (ready: boolean) => void;
        receive: (event: VoiceModeEvent) => void;
      }
    | undefined,
}));

vi.mock("@/features/rooms/chat/voice-mode/voice-mode-transport", () => ({
  openVoiceMode: async (input: {
    level?: (level: number) => void;
    receive: (event: VoiceModeEvent) => void;
  }) => {
    const connection: DictationConnection = {
      close: vi.fn(async () => undefined),
      level: input.level,
      receive: input.receive,
    };
    mocks.dictationConnections.push(connection);
    return {
      close: connection.close,
      commit: async () => undefined,
      setMuted: async () => undefined,
    };
  },
}));

vi.mock("@/features/rooms/chat/voice-mode/live/voice-live-transport", () => ({
  openVoiceLive: async (input: {
    channel?: (connection: unknown) => void;
    level?: (level: number) => void;
    providerReady?: (ready: boolean) => void;
    receive: (event: VoiceModeEvent) => void;
  }) => {
    mocks.liveOpened = input;
    const connection = {
      active: () => true,
      close: mocks.liveClose,
      commit: async () => undefined,
      send: vi.fn(),
      setMuted: async () => undefined,
      setSoundOff: vi.fn(),
      voiceSessionId: "live-1",
    };
    input.channel?.(connection);
    input.providerReady?.(true);
    return connection;
  },
}));

vi.mock("livekit-client", () => ({}));

const SUB_THRESHOLD_DECAY_TICKS = [0.03, 0.01, 1e-6, 1.5e-323] as const;

/**
 * Advances fake timers in 50 ms meter intervals while emitting sub-threshold
 * float64 decay ticks (matching `observeAudioLevel`'s `smoothVoiceLevel` tail).
 */
function advanceWithDecayingSilence(
  emitLevel: ((level: number) => void) | undefined,
  totalMs: number,
) {
  const stepMs = 50;
  const ticks = Math.ceil(totalMs / stepMs);
  for (let i = 0; i < ticks; i += 1) {
    const value =
      SUB_THRESHOLD_DECAY_TICKS[
        Math.min(i, SUB_THRESHOLD_DECAY_TICKS.length - 1)
      ]!;
    emitLevel?.(value);
    vi.advanceTimersByTime(stepMs);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.dictationConnections.length = 0;
  mocks.liveOpened = undefined;
});

describe("dictation Stop after silence timer", () => {
  it("resets on activity and fires once after configured silence, and does nothing when disabled (0)", () => {
    vi.useFakeTimers();
    const onStop = vi.fn();
    const timer = createDictationSilenceTimer(onStop);

    timer.setTimeoutSeconds(0);
    timer.setActive(true);
    vi.advanceTimersByTime(60_000);
    expect(onStop).not.toHaveBeenCalled();

    timer.setTimeoutSeconds(5);
    vi.advanceTimersByTime(4_000);
    timer.noteActivity();
    vi.advanceTimersByTime(4_000);
    expect(onStop).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);
    expect(onStop).toHaveBeenCalledTimes(1);
    timer.dispose();
  });

  it("auto-stops Pocket Notes dictation after speech even when smoothVoiceLevel emits decaying sub-threshold ticks every 50 ms, keeping the pending words", async () => {
    vi.useFakeTimers();
    const runtime = createTestTeamHubRuntime();
    runtime.server.on("GET", "/v0/tenants/{tenantId}/voice-settings", () => ({
      ...DEFAULT_VOICE_SETTINGS,
      silence_timeout_seconds: 5,
    }));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          {children}
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    );

    // Wired the way the Pocket Note panel wires it: auto-stop takes the same
    // stop path as the Stop button and inserts the words stop returns.
    const insertSpoken = vi.fn();
    const { result, unmount } = renderHook(
      () => {
        const dictation = usePocketDictation({
          onAutoStop: () => {
            void dictation.stop().then(insertSpoken);
          },
          onTurn: vi.fn(),
          roomId: "room-1",
          tenantId: "tenant-1",
        });
        return dictation;
      },
      { wrapper },
    );

    // Flush initial React Query voice-settings fetch before starting.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      result.current.start();
      await Promise.resolve();
    });
    expect(result.current.active).toBe(true);
    expect(mocks.dictationConnections).toHaveLength(1);
    const connection = mocks.dictationConnections[0]!;

    // 4s of silence, then real speech (0.35) resets the 5s countdown.
    await act(async () => {
      vi.advanceTimersByTime(4_000);
      connection.level?.(0.35);
      // Recognized but not yet a finished turn when the user goes quiet.
      connection.receive({
        kind: "speech",
        id: "pending",
        text: "Buy milk",
        endOffsetMs: 900,
      });
      // Decay via smoothVoiceLevel(prev, 0) until below the activity threshold.
      let level = 0.35;
      while (level >= VOICE_SILENCE_ACTIVITY_THRESHOLD) {
        level = smoothVoiceLevel(level, 0);
        connection.level?.(level);
        vi.advanceTimersByTime(50);
      }
      // 4s of decaying sub-threshold ticks must not stop early or reset timer.
      advanceWithDecayingSilence(connection.level, 4_000);
    });
    expect(result.current.active).toBe(true);
    expect(connection.close).not.toHaveBeenCalled();

    // Remaining 1s of sub-threshold ticks (including 1.5e-323) fires auto-stop.
    await act(async () => {
      advanceWithDecayingSilence(connection.level, 1_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(result.current.active).toBe(false);
    expect(insertSpoken).toHaveBeenCalledExactlyOnceWith("Buy milk");
    unmount();
  });

  it("auto-stops Voice Mode dictation after speech with decaying sub-threshold ticks, syncs live QueryClient updates, and never affects Live Voice", async () => {
    vi.useFakeTimers();
    const tenantId = "tenant-northstar";
    const runtime = createTestTeamHubRuntime();
    runtime.server.on("GET", "/v0/tenants/{tenantId}/voice-settings", () => ({
      ...DEFAULT_VOICE_SETTINGS,
      silence_timeout_seconds: 3,
    }));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const target = {
      accountId: "account-1",
      roomId: "room-1",
      roomName: "General",
      tenantId,
    };
    const prefix = { body: "", documentReferences: [], mentions: [] };

    // 1. Voice Mode dictation: speech resets once, then decaying sub-threshold
    //    ticks every 50 ms still allow the 3s silence timeout to fire cleanly.
    let dictationSession: VoiceModeSession | undefined;
    const dictationEngine = createVoiceModeSessionEngine({
      bindings: new Map(),
      deps: () => ({
        hardware: null,
        queryClient,
        runtime,
      }),
      publish: (next) => {
        dictationSession = next;
      },
      publishLevel: vi.fn(),
    });

    dictationEngine.start(target, prefix, { dictation: true, live: false });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(dictationSession?.state.status).toBe("listening");
    const connection = mocks.dictationConnections[0]!;

    await act(async () => {
      vi.advanceTimersByTime(2_000);
      connection.level?.(0.35);
      // Emit sub-threshold decay ticks (0.03, 0.01, 1e-6, 1.5e-323) every 50 ms
      // for 2s — countdown must not expire yet.
      advanceWithDecayingSilence(connection.level, 2_000);
    });
    expect(connection.close).not.toHaveBeenCalled();

    // Transcript events still reset the countdown.
    await act(async () => {
      connection.receive({
        endOffsetMs: 500,
        kind: "partial",
        text: "hello",
      });
      advanceWithDecayingSilence(connection.level, 2_000);
    });
    expect(connection.close).not.toHaveBeenCalled();

    // Remaining 1s of sub-threshold ticks fires auto-stop cleanly.
    await act(async () => {
      advanceWithDecayingSilence(connection.level, 1_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(connection.close).toHaveBeenCalledTimes(1);
    dictationEngine.dispose();

    // 2. Updating voice settings directly in React Query updates an active
    //    dictation session without any separate module-level cache or bus.
    queryClient.setQueryData(voiceSettingsQueryKey(tenantId), {
      ...DEFAULT_VOICE_SETTINGS,
      silence_timeout_seconds: 0,
    });
    let dynamicSession: VoiceModeSession | undefined;
    const dynamicEngine = createVoiceModeSessionEngine({
      bindings: new Map(),
      deps: () => ({
        hardware: null,
        queryClient,
        runtime,
      }),
      publish: (next) => {
        dynamicSession = next;
      },
      publishLevel: vi.fn(),
    });
    dynamicEngine.start(target, prefix, { dictation: true, live: false });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(dynamicSession?.state.status).toBe("listening");
    const dynamicConnection = mocks.dictationConnections[1]!;

    // Updating the shared React Query cache enables the 2s timeout live.
    await act(async () => {
      queryClient.setQueryData(voiceSettingsQueryKey(tenantId), {
        ...DEFAULT_VOICE_SETTINGS,
        silence_timeout_seconds: 2,
      });
      advanceWithDecayingSilence(dynamicConnection.level, 2_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(dynamicConnection.close).toHaveBeenCalledTimes(1);
    dynamicEngine.dispose();

    // 3. Live Voice Mode NEVER auto-stops on silence or decaying meter ticks.
    let liveSession: VoiceModeSession | undefined;
    const liveEngine = createVoiceModeSessionEngine({
      bindings: new Map(),
      deps: () => ({
        hardware: null,
        queryClient,
        runtime,
      }),
      publish: (next) => {
        liveSession = next;
      },
      publishLevel: vi.fn(),
    });

    liveEngine.start(target, prefix, { dictation: true, live: true });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(liveSession?.state.status).toBe("listening");
    expect(liveSession?.live).toBeDefined();

    await act(async () => {
      mocks.liveOpened?.level?.(0.35);
      advanceWithDecayingSilence(mocks.liveOpened?.level, 30_000);
      await Promise.resolve();
    });
    expect(mocks.liveClose).not.toHaveBeenCalled();
    expect(liveSession?.entered).toBe(true);
    liveEngine.dispose();
  });
});
