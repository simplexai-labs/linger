import { QueryClientContext } from "@tanstack/react-query";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { useOptionalTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubActorRef,
  TeamHubVoiceLiveTurnMarker,
} from "@/features/teamhub/teamhub-types";
import { useOptionalVoiceControl } from "@/features/rooms/voice-control/voice-control-context";
import {
  closeRecordingWindow,
  isRecordingWindowOpen,
} from "@/features/rooms/voice-control/recording-window-store";
import type { VoiceLiveLine } from "./live/voice-live-arbiter";
import type { VoiceModeState } from "./voice-mode-controller";
import type { VoiceModePresentation } from "./voice-mode-presentation";
import type { VoiceTurnPrefix } from "./voice-mode-room-sender";
import type { VoiceModeSessionEngine } from "./voice-mode-session-engine";

export interface VoiceModeSessionTarget {
  accountId: string;
  roomId: string;
  roomName: string;
  tenantId: string;
  recipient?: TeamHubActorRef;
}

/**
 * Sends one prepared turn once. A live turn the live model answers carries
 * its marker; anything else is an ordinary Message that wakes the Agent.
 * `onQueued` runs as soon as the turn shows in the Room's outbox, before the
 * server accepts it, so the words it replaces can go in the same moment.
 */
export type VoiceModeTurnSend = (
  voiceLiveTurn?: TeamHubVoiceLiveTurnMarker,
  onQueued?: () => void,
) => Promise<void>;

/** What a mounted Room composer offers the session for its own turns. */
export interface VoiceModeRoomBinding {
  onChange: (presentation: VoiceModePresentation) => void;
  prepareSend: (text: string, eventId: string) => VoiceModeTurnSend;
}

/** Which Voice Mode the server allows for the current Human. */
export interface VoiceModeModes {
  dictation: boolean;
  live: boolean;
}

/** Present while the live model answers by voice. */
export interface VoiceModeLivePresentation {
  /** The reply's speaker is silenced; the microphone is unaffected. */
  soundOff: boolean;
  /** This call's exchanges in the order they were said. */
  transcript: readonly VoiceLiveLine[];
  /**
   * The live model is still connecting or reconnecting. The call may already
   * be listening: speech waits for the model and is answered once it opens.
   */
  waking: boolean;
}

export interface VoiceModeSession {
  closing: boolean;
  entered: boolean;
  live?: VoiceModeLivePresentation;
  muted: boolean;
  prefix: VoiceTurnPrefix;
  sourceId: string;
  startedAt: string;
  state: VoiceModeState;
  target: VoiceModeSessionTarget;
}

interface VoiceModeSessionApi {
  session: VoiceModeSession | undefined;
  /** The live microphone level, kept out of `session` so it rerenders only meters. */
  level: VoiceModeLevelStore;
  bind: (roomId: string, binding: VoiceModeRoomBinding) => () => void;
  exit: () => void;
  retry: () => void;
  setMuted: (muted: boolean) => Promise<void>;
  setSoundOff: (soundOff: boolean) => void;
  /** Loads Voice Mode's code before the Human clicks, so starting is quick. */
  prepare: () => void;
  start: (
    target: VoiceModeSessionTarget,
    prefix: VoiceTurnPrefix,
    modes?: VoiceModeModes,
    openWindow?: () => void | Promise<unknown>,
  ) => Promise<void>;
  startMeeting: (startRecording: () => Promise<void>) => Promise<void>;
}

interface VoiceModeLevelStore {
  get: () => number;
  subscribe: (listener: () => void) => () => void;
}

function createLevelStore() {
  let level = 0;
  const listeners = new Set<() => void>();
  return {
    get: () => level,
    publish(next: number) {
      if (next === level) return;
      level = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const VoiceModeSessionContext = createContext<VoiceModeSessionApi | undefined>(
  undefined,
);

/**
 * Holds the one Voice Mode session above the Room routes, so dictation keeps
 * running while the Human moves between Rooms. Turns always go to the Room the
 * session started in. The session engine loads on the first start, keeping
 * this provider small in the app shell's initial bundle.
 */
export function VoiceModeSessionProvider({
  children,
}: {
  children: ReactNode;
}) {
  const runtime = useOptionalTeamHubRuntime();
  const hardware = useOptionalVoiceControl();
  const queryClient = useContext(QueryClientContext);
  const deps = useRef({ hardware, queryClient, runtime });
  useLayoutEffect(() => {
    deps.current = { hardware, queryClient, runtime };
  });
  const [session, setSession] = useState<VoiceModeSession>();
  const bindings = useRef(new Map<string, VoiceModeRoomBinding>());
  const engine = useRef<VoiceModeSessionEngine>(undefined);
  const mounted = useRef(false);
  const [levelStore] = useState(createLevelStore);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      engine.current?.dispose();
    };
  }, []);
  const api = useMemo(() => {
    // One shared load, so quick repeated starts still create one engine.
    let loading: Promise<VoiceModeSessionEngine> | undefined;
    let transition: Promise<void> | undefined;
    const switchMode = (start: () => Promise<void>) => {
      const operation = transition ? transition.then(start, start) : start();
      transition = operation;
      const clear = () => {
        if (transition === operation) transition = undefined;
      };
      void operation.then(clear, clear);
      return operation;
    };
    const load = () =>
      (loading ??= import("./voice-mode-session-engine").then(
        ({ createVoiceModeSessionEngine }) =>
          (engine.current = createVoiceModeSessionEngine({
            bindings: bindings.current,
            deps: () => ({
              ...deps.current,
              queryClient: deps.current.queryClient ?? undefined,
            }),
            publish: setSession,
            publishLevel: levelStore.publish,
          })),
      ));
    return {
      bind(roomId: string, binding: VoiceModeRoomBinding) {
        bindings.current.set(roomId, binding);
        engine.current?.resume(roomId, binding);
        return () => {
          if (bindings.current.get(roomId) === binding)
            bindings.current.delete(roomId);
        };
      },
      exit: () => {
        void engine.current?.exit();
      },
      retry: () => engine.current?.retry(),
      setMuted: async (muted: boolean) => engine.current?.setMuted(muted),
      setSoundOff: (soundOff: boolean) => engine.current?.setSoundOff(soundOff),
      prepare() {
        void load().catch(() => undefined);
        void import("livekit-client").catch(() => undefined);
      },
      start(
        target: VoiceModeSessionTarget,
        prefix: VoiceTurnPrefix,
        modes?: VoiceModeModes,
        openWindow?: () => void | Promise<unknown>,
      ) {
        return switchMode(async () => {
          const control = deps.current.hardware;
          const status = control?.captureState.status;
          if (
            control &&
            control.listenerStatus !== "standby" &&
            (isRecordingWindowOpen() ||
              status === "starting" ||
              status === "recording" ||
              status === "finalizing")
          ) {
            const stop = control.leavePage
              ? control.leavePage()
              : control.stopCapture();
            closeRecordingWindow();
            await stop;
            if (!mounted.current) return;
            const { closeVoicePip } = await import("./voice-pip");
            if (!mounted.current) return;
            closeVoicePip("recording");
          }
          if (!mounted.current) return;
          const floated = openWindow?.();
          const loaded = await load();
          if (mounted.current) loaded.start(target, prefix, modes);
          await floated;
        });
      },
      startMeeting(startRecording: () => Promise<void>) {
        return switchMode(async () => {
          const stopped = engine.current?.exit({ switchingToMeeting: true });
          if (stopped) await stopped;
          if (mounted.current) await startRecording();
        });
      },
      level: { get: levelStore.get, subscribe: levelStore.subscribe },
    };
  }, [levelStore]);
  const value = useMemo(() => ({ ...api, session }), [api, session]);
  return (
    <VoiceModeSessionContext.Provider value={value}>
      {children}
    </VoiceModeSessionContext.Provider>
  );
}

export function useOptionalVoiceModeSession() {
  return useContext(VoiceModeSessionContext);
}

const silentLevel: VoiceModeLevelStore = {
  get: () => 0,
  subscribe: () => () => undefined,
};

/** The live microphone level; only the components that draw it rerender. */
export function useVoiceModeLevel() {
  const store = useContext(VoiceModeSessionContext)?.level ?? silentLevel;
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
