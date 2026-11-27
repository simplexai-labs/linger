import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  RemoteAudioTrack,
  Room,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
  type RemoteParticipant,
  type RemoteTrackPublication,
} from "@livekit/rtc-node";
import {
  bridgeSampleRate,
  liveTopic,
  type BridgeMedia,
  type ConnectBridgeMedia,
} from "./bridge.js";

/** The Live worker publishes its reply under this track name. */
const liveReplyTrackName = "linger-live-reply";
/** Reply audio reaches the phone in 20 ms messages. */
const replyFrameMs = 20;

/**
 * Joins the VoiceSession's Room with the phone's grant and publishes the
 * microphone as a browser does: source microphone, no DTX, RED on. For Live
 * it subscribes only to the Runtime's reply track.
 */
export async function connectLiveKitMedia(
  input: Parameters<ConnectBridgeMedia>[0],
): Promise<BridgeMedia> {
  const publisher = `publisher-${input.voiceSessionId}`;
  const live = input.purpose === "chat_live";
  const room = new Room();
  const readers = new Set<AudioStream>();
  let closed = false;
  const fromRuntime = (participant: RemoteParticipant | undefined) =>
    participant !== undefined && participant.identity !== publisher;
  const subscribe = (
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => {
    if (publication.name === liveReplyTrackName && fromRuntime(participant))
      publication.setSubscribed(true);
  };
  const readReply = async (track: RemoteAudioTrack) => {
    const stream = new AudioStream(track, {
      sampleRate: bridgeSampleRate,
      numChannels: 1,
      frameSizeMs: replyFrameMs,
    });
    readers.add(stream);
    try {
      for await (const frame of stream) {
        if (closed) break;
        input.handlers.replyAudio(frame.data);
      }
    } finally {
      readers.delete(stream);
    }
  };
  if (live) {
    room.on(RoomEvent.TrackPublished, subscribe);
    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (
        track instanceof RemoteAudioTrack &&
        publication.name === liveReplyTrackName &&
        fromRuntime(participant)
      )
        void readReply(track).catch(() => undefined);
    });
    room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
      if (topic !== liveTopic || !fromRuntime(participant)) return;
      let event: unknown;
      try {
        event = JSON.parse(new TextDecoder().decode(payload));
      } catch {
        return;
      }
      input.handlers.liveEvent(event);
    });
  }
  room.on(RoomEvent.Disconnected, () => {
    if (!closed) input.handlers.disconnected();
  });
  const source = new AudioSource(bridgeSampleRate, 1);
  const track = LocalAudioTrack.createAudioTrack("microphone", source);
  try {
    await room.connect(input.url, input.credential, {
      autoSubscribe: false,
      dynacast: false,
    });
    const local = room.localParticipant;
    if (!local) throw new Error("LiveKit participant is unavailable");
    const publication = await local.publishTrack(
      track,
      new TrackPublishOptions({
        source: TrackSource.SOURCE_MICROPHONE,
        dtx: false,
        red: true,
      }),
    );
    if (live)
      for (const participant of room.remoteParticipants.values())
        for (const remote of participant.trackPublications.values())
          subscribe(remote, participant);
    const media: BridgeMedia = {
      trackSid: publication.sid ?? "",
      get queuedMs() {
        return source.queuedDuration;
      },
      async capture(samples) {
        await source.captureFrame(
          new AudioFrame(samples, bridgeSampleRate, 1, samples.length),
        );
      },
      async publishLive(payload) {
        await local.publishData(
          new TextEncoder().encode(JSON.stringify(payload)),
          { reliable: true, topic: liveTopic },
        );
      },
      async close() {
        if (closed) return;
        closed = true;
        for (const reader of readers) await reader.cancel().catch(() => {});
        if (publication.sid)
          await local.unpublishTrack(publication.sid).catch(() => {});
        await track.close().catch(() => {});
        await source.close().catch(() => {});
        await room.disconnect();
      },
    };
    return media;
  } catch (error) {
    closed = true;
    await room.disconnect().catch(() => {});
    await source.close().catch(() => {});
    throw error;
  }
}
