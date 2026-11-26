// The device side of voice, kept thin: microphone capture as 20 ms frames
// of 24 kHz mono PCM (optionally also written to files), Live reply playback,
// the audio session, permission and the Android recording notification.
// Everything else in src/voice runs without it.
import { Alert, Linking, Platform } from "react-native";
import {
  AudioContext,
  AudioManager,
  AudioRecorder,
  FileDirectory,
  FileFormat,
  FilePreset,
  RecordingNotificationManager,
  type AudioEventSubscription,
  type SystemOptions,
} from "react-native-audio-api";

import { t } from "../i18n/language";
import {
  BRIDGE_SAMPLE_RATE,
  FRAME_SAMPLES,
  FrameChunker,
  float32ToInt16,
  int16BytesToFloat32,
  resample,
  rms,
} from "./pcm";
import { voiceAudioMessages as m } from "./audio.messages";

/** What the microphone is for; it decides echo cancellation and routing. */
export type AudioUse = "dictate" | "live" | "record";

/** Recording files rotate at this size so each one uploads on its own. */
const ROTATE_BYTES = 8 * 1024 * 1024;

/** Android outputs a headset or earpiece the Human chose to wear. */
const PERSONAL_OUTPUTS = new Set([
  "Wired Headset",
  "Wired Headphones",
  "Bluetooth SCO",
  "Bluetooth A2DP",
  "Bluetooth LE Headset",
  "USB Headset",
]);

function systemOptions(use: AudioUse): SystemOptions {
  if (use === "live")
    return {
      // voiceChat turns on Apple's echo cancellation for the reply voice.
      ios: {
        category: "playAndRecord",
        mode: "voiceChat",
        options: ["defaultToSpeaker", "allowBluetoothHFP"],
      },
      android: { mode: "inCommunication", communicationDevice: "speaker" },
    };
  return {
    // mixWithOthers lets a recording resume in the background after a call.
    ios: {
      category: "playAndRecord",
      mode: "default",
      options:
        use === "record"
          ? ["mixWithOthers", "defaultToSpeaker", "allowBluetoothHFP"]
          : ["defaultToSpeaker", "allowBluetoothHFP"],
    },
  };
}

/**
 * Asks for the microphone at first use, after saying why; a refusal points
 * to Settings. Resolves true when the app may record.
 */
export async function ensureMicrophonePermission(): Promise<boolean> {
  let status = await AudioManager.checkRecordingPermissions();
  if (status === "Granted") return true;
  if (status === "Undetermined") {
    const proceed = await new Promise<boolean>((resolve) =>
      Alert.alert(
        t(m.permissionTitle),
        t(m.permissionBody),
        [
          {
            text: t(m.notNow),
            style: "cancel",
            onPress: () => resolve(false),
          },
          { text: t(m.continue), onPress: () => resolve(true) },
        ],
        { cancelable: true, onDismiss: () => resolve(false) },
      ),
    );
    if (!proceed) return false;
    status = await AudioManager.requestRecordingPermissions();
    if (status === "Granted") return true;
  }
  Alert.alert(t(m.deniedTitle), t(m.deniedBody), [
    { text: t(m.cancel), style: "cancel" },
    { text: t(m.openSettings), onPress: () => void Linking.openSettings() },
  ]);
  return false;
}

export interface MicrophoneOptions {
  readonly use: AudioUse;
  /** One 20 ms frame of 24 kHz mono PCM, and a shorter last one on stop. */
  onFrame(frame: Int16Array): void;
  onLevel?(level: number): void;
  /** A phone call or another app took the audio session, or gave it back. */
  onInterruption?(state: "began" | "ended"): void;
  /** Also writes the capture as M4A files under this documents subdirectory. */
  readonly file?: { readonly directory: string; readonly name: string };
}

export interface Microphone {
  /** Muted capture sends silence, so the timeline stays continuous. */
  setMuted(muted: boolean): void;
  /** Stops capture after its last frame and returns the files it wrote. */
  stop(): Promise<string[]>;
}

let inUse = false;

export class MicrophoneBusy extends Error {
  constructor() {
    super("The microphone is already in use by another voice feature.");
    this.name = "MicrophoneBusy";
  }
}

/** Opens the audio session and starts capture. One feature at a time. */
export async function openMicrophone(
  options: MicrophoneOptions,
): Promise<Microphone> {
  if (inUse) throw new MicrophoneBusy();
  inUse = true;
  const subscriptions: AudioEventSubscription[] = [];
  let recorder: AudioRecorder | undefined;
  try {
    AudioManager.setSystemOptions(systemOptions(options.use));
    AudioManager.observeAudioInterruptions(true);
    await AudioManager.setAudioSessionActivity(true);
    recorder =
      options.use === "live"
        ? new AudioRecorder({
            androidInputPreset: "voiceCommunication",
            iosVoiceProcessing: true,
          })
        : new AudioRecorder();
    const active = recorder;
    if (options.file)
      active.enableFileOutput({
        format: FileFormat.M4A,
        preset: FilePreset.Low,
        channelCount: 1,
        directory: FileDirectory.Document,
        subDirectory: options.file.directory,
        fileName: options.file.name,
        rotateIntervalBytes: ROTATE_BYTES,
      });
    const chunker = new FrameChunker();
    let muted = false;
    // The level drives React state; a frame every 20 ms would re-render the
    // screen at 50 Hz, so the loudest frame of each 100 ms is reported.
    let peak = 0;
    let reportedAt = 0;
    const ready = active.onAudioReady(
      {
        sampleRate: BRIDGE_SAMPLE_RATE,
        bufferLength: FRAME_SAMPLES,
        channelCount: 1,
      },
      (event) => {
        const channel = event.buffer
          .getChannelData(0)
          .subarray(0, event.numFrames);
        const samples = float32ToInt16(
          resample(channel, event.buffer.sampleRate, BRIDGE_SAMPLE_RATE),
        );
        if (muted) samples.fill(0);
        peak = Math.max(peak, muted ? 0 : rms(samples));
        const now = Date.now();
        if (now - reportedAt >= 100) {
          options.onLevel?.(peak);
          peak = 0;
          reportedAt = now;
        }
        for (const frame of chunker.push(samples)) options.onFrame(frame);
      },
    );
    if (ready.status === "error") throw new Error(ready.message);
    subscriptions.push(
      AudioManager.addSystemEventListener("interruption", (event) => {
        if (event.type === "ended") {
          void AudioManager.setAudioSessionActivity(true)
            .then(() => (active.isPaused() ? active.resume() : undefined))
            .catch(() => undefined);
        }
        options.onInterruption?.(event.type);
      }),
    );
    if (options.use === "live" && Platform.OS === "android")
      subscriptions.push(
        AudioManager.addSystemEventListener("routeChange", () => {
          void routeLiveReply();
        }),
      );
    const started = await active.start();
    if (started.status === "error") throw new Error(started.message);
    if (options.use === "live" && Platform.OS === "android")
      void routeLiveReply();
    let stopping: Promise<string[]> | undefined;
    return {
      setMuted(next) {
        muted = next;
      },
      stop() {
        stopping ??= (async () => {
          let files: string[] = [];
          try {
            const stopped = await active.stop();
            if (stopped.status === "success") files = stopped.paths;
          } finally {
            active.clearOnAudioReady();
            const rest = chunker.flush();
            if (rest) options.onFrame(muted ? rest.fill(0) : rest);
            for (const subscription of subscriptions) subscription.remove();
            await AudioManager.setAudioSessionActivity(false).catch(
              () => undefined,
            );
            inUse = false;
          }
          return files;
        })();
        return stopping;
      },
    };
  } catch (error) {
    for (const subscription of subscriptions) subscription.remove();
    recorder?.clearOnAudioReady();
    await recorder?.stop().catch(() => undefined);
    await AudioManager.setAudioSessionActivity(false).catch(() => undefined);
    inUse = false;
    throw error;
  }
}

/**
 * Android's communication mode plays on the earpiece unless told otherwise:
 * the reply goes to the loudspeaker, or to a headset when one is connected.
 */
async function routeLiveReply(): Promise<void> {
  try {
    const devices = await AudioManager.getDevicesInfo();
    const personal = devices.availableOutputs.some((device) =>
      PERSONAL_OUTPUTS.has(device.category),
    );
    await AudioManager.setCommunicationDevice(
      personal ? "systemDefault" : "speaker",
    );
  } catch {
    // The route stays as it was.
  }
}

export interface Speaker {
  /** Queues one downlink message of s16le mono 24 kHz PCM. */
  play(pcm: Uint8Array): void;
  /** Drops everything queued, for an interrupted reply. */
  clear(): void;
  close(): Promise<void>;
}

/** Plays Live reply audio through the voice-communication output. */
export async function openSpeaker(
  onLevel?: (level: number) => void,
): Promise<Speaker> {
  const context = new AudioContext({
    sampleRate: BRIDGE_SAMPLE_RATE,
    androidOutputProfile: "voiceCommunication",
  });
  const queue = context.createBufferQueueSource();
  queue.connect(context.destination);
  queue.start();
  await context.resume();
  let closed = false;
  return {
    play(pcm) {
      if (closed || pcm.byteLength < 2) return;
      const samples = int16BytesToFloat32(pcm);
      const buffer = context.createBuffer(
        1,
        samples.length,
        BRIDGE_SAMPLE_RATE,
      );
      buffer.copyToChannel(samples, 0);
      queue.enqueueBuffer(buffer);
      onLevel?.(rms(samples));
    },
    clear() {
      if (!closed) queue.clearBuffers();
      onLevel?.(0);
    },
    async close() {
      if (closed) return;
      closed = true;
      queue.clearBuffers();
      queue.stop();
      await context.close().catch(() => undefined);
    },
  };
}

/**
 * Android keeps a recording alive with the screen locked through a
 * microphone foreground service, started by this notification while the
 * app is in the foreground. iOS uses the background audio mode instead.
 */
export async function showRecordingNotification(): Promise<void> {
  if (Platform.OS !== "android") return;
  await RecordingNotificationManager.show({
    title: t(m.notificationTitle),
    contentText: t(m.notificationBody),
  }).catch(() => undefined);
}

export async function hideRecordingNotification(): Promise<void> {
  if (Platform.OS !== "android") return;
  await RecordingNotificationManager.hide().catch(() => undefined);
}
