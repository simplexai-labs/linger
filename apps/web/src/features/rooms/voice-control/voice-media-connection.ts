import type {
  LocalAudioTrack,
  LocalTrackPublication,
  Room,
  RoomEvent,
} from "livekit-client";

import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import type {
  TeamHubVoiceConnectionCredential,
  TeamHubVoiceConnectTimings,
} from "@/features/teamhub/teamhub-types";

import {
  openBoundMicrophone,
  retryOnVoiceMediaAbort,
  voiceMicrophoneConstraints,
} from "./microphone-devices";
import { translate } from "@/i18n/language";
import { recordingMessages as m } from "./recording.messages";

/**
 * The LiveKit steps the recording window and Voice Mode share. Each caller
 * decides where its VoiceSession comes from, when it is ready, what an ended
 * track means and how it is released; every step here has its own limit.
 */
type LiveKit = typeof import("livekit-client");

type VoiceConnectStage = Exclude<keyof TeamHubVoiceConnectTimings, "outcome">;

/** Times one join attempt; its report is for diagnosis and never blocks it. */
export interface VoiceConnectClock {
  /** The attempt's VoiceSession is known: created or resumed. */
  session(voiceSessionId: string): void;
  mark(stage: VoiceConnectStage): void;
  report(
    client: Pick<TeamHubClient, "api">,
    outcome: TeamHubVoiceConnectTimings["outcome"],
  ): void;
}

/**
 * Starts timing a join where the user started it. Only the browser sees
 * these steps, and on a slow network they are where the first seconds go.
 */
export function startVoiceConnectClock(): VoiceConnectClock {
  const started = performance.now();
  const stages: Partial<Record<VoiceConnectStage, number>> = {};
  let voiceSessionId: string | undefined;
  let reported = false;
  const mark = (stage: VoiceConnectStage) => {
    stages[stage] ??= Math.min(
      600_000,
      Math.round(performance.now() - started),
    );
  };
  return {
    session(id) {
      voiceSessionId = id;
      mark("session_ms");
    },
    mark,
    report(client, outcome) {
      if (reported || !voiceSessionId) return;
      reported = true;
      void client.api
        .POST("/v0/voice-sessions/{voiceSessionId}/connect-timings", {
          params: { path: { voiceSessionId } },
          body: { outcome, ...stages },
        })
        .catch(() => undefined);
    },
  };
}

/**
 * Opens the bound microphone, or the system default when that device is gone,
 * so it is ready when the Room is. An attempt abandoned meanwhile stops it.
 */
export function openVoiceMicrophone(
  livekit: LiveKit,
  deviceId: string | undefined,
  signal: AbortSignal,
) {
  const opening = retryOnVoiceMediaAbort(
    () =>
      openBoundMicrophone(deviceId, (device) =>
        livekit.createLocalAudioTrack({
          ...voiceMicrophoneConstraints,
          deviceId: device,
        }),
      ),
    signal,
  );
  void opening.then(
    (track) => {
      if (signal.aborted) track.stop();
    },
    () => undefined,
  );
  return bounded(opening, 30_000, signal);
}

/**
 * Connects the session's Room and publishes the microphone. The caller
 * registers its Room events before the connection starts; a failed attempt
 * disconnects the Room and stops the microphone.
 */
export async function publishVoiceMicrophone(input: {
  livekit: LiveKit;
  client: Pick<TeamHubClient, "api">;
  voiceSessionId: string;
  /** The credential the session's creation returned; absent, one is asked. */
  credential?: TeamHubVoiceConnectionCredential;
  clock?: VoiceConnectClock;
  microphone: Promise<LocalAudioTrack>;
  signal: AbortSignal;
  observe(
    room: Room,
    events: typeof RoomEvent,
    credential: TeamHubVoiceConnectionCredential,
  ): void;
  /** The microphone opened and the Room connected; publishing is next. */
  opened?(track: LocalAudioTrack): void | Promise<void>;
  /** The microphone ended: unplugged or its permission revoked. */
  ended(): void;
}): Promise<{
  credential: TeamHubVoiceConnectionCredential;
  room: Room;
  track: LocalAudioTrack;
  publication: LocalTrackPublication;
}> {
  const { livekit, signal } = input;
  let room: Room | undefined;
  let published = false;
  try {
    const credential =
      input.credential ??
      (await bounded(
        teamHubData(
          input.client.api.POST(
            "/v0/voice-sessions/{voiceSessionId}/connection-credentials",
            { params: { path: { voiceSessionId: input.voiceSessionId } } },
          ),
        ),
        5_000,
        signal,
      ));
    input.clock?.mark("credential_ms");
    room = new livekit.Room({
      adaptiveStream: false,
      disconnectOnPageLeave: true,
      dynacast: false,
    });
    input.observe(room, livekit.RoomEvent, credential);
    const [, track] = await Promise.all([
      bounded(
        room
          .connect(credential.endpoint, credential.credential, {
            autoSubscribe: false,
          })
          .then(() => input.clock?.mark("room_connected_ms")),
        15_000,
        signal,
      ),
      input.microphone.then((opened) => {
        input.clock?.mark("microphone_ms");
        return opened;
      }),
    ]);
    signal.throwIfAborted();
    track.mediaStreamTrack.addEventListener("ended", () => {
      if (!signal.aborted) input.ended();
    });
    await input.opened?.(track);
    const publication = await bounded(
      room.localParticipant.publishTrack(track, {
        source: livekit.Track.Source.Microphone,
        dtx: false,
        red: true,
      }),
      10_000,
      signal,
    );
    signal.throwIfAborted();
    input.clock?.mark("published_ms");
    published = true;
    return { credential, room, track, publication };
  } finally {
    if (!published) {
      void input.microphone.then(
        (track) => track.stop(),
        () => undefined,
      );
      if (room) await bounded(room.disconnect(), 3_000).catch(() => undefined);
    }
  }
}

export async function setVoiceMicrophoneMuted(
  track: LocalAudioTrack,
  muted: boolean,
) {
  if (muted) await track.mute();
  else await track.unmute();
}

export async function bounded<T>(
  operation: Promise<T>,
  milliseconds: number,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(translate(m.requestTimedOut))),
          milliseconds,
        );
        abort = () =>
          reject(
            signal?.reason ??
              new DOMException("Voice input closed", "AbortError"),
          );
        signal?.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}
