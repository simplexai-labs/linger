import { defineAgent, log } from "@livekit/agents";
import { TeamHubVoiceRuntimeClient } from "@linger/wire-contracts/teamhub-internal/client";

import type { ASRProvider } from "./asr.js";
import {
  loadConfig,
  localAsrConfig,
  sonioxLanguageHints,
  sonioxRealtimeModel,
} from "./config.js";
import { SonioxASRProvider } from "./soniox.js";
import { SenseVoiceASRProvider } from "./sensevoice.js";
import { loadSenseVoiceRecognizer } from "./sensevoice-recognizer.js";
import {
  VoiceTrackWorker,
  voiceSessionFromRoom,
  voiceTrackFailureCode,
  voicePurposeFromMetadata,
} from "./livekit-worker.js";
import type { ASRRecovery } from "./recovering-asr.js";

// TeamHub gives a rewrite nine seconds on the model; this adds the round trip
// and still ends a dictation turn inside its twelve-second drain.
const polishTimeoutMs = 10_500;

export default defineAgent({
  // The local model takes a second or two to load; an idle process does it
  // before the first session needs it.
  prewarm: () => {
    const local = localAsrConfig();
    if (!local) return;
    // A failed preload is retried by the session that needs the model.
    return loadSenseVoiceRecognizer(local).then(
      () => undefined,
      () => undefined,
    );
  },
  entry: async (ctx) => {
    const config = loadConfig();
    const dictation =
      voicePurposeFromMetadata(ctx.job.metadata) === "chat_dictation";
    const client = new TeamHubVoiceRuntimeClient(config.teamhubBaseUrl, () =>
      Promise.resolve(config.teamhubToken),
    );
    const onRecovery = ({ cause, replayMs, elapsedMs }: ASRRecovery) => {
      log().warn(
        {
          failureCode: voiceTrackFailureCode(cause),
          replayMs,
          elapsedMs,
          roomName: ctx.job.room?.name,
        },
        "Voice Runtime ASR replay submitted after reconnect",
      );
    };
    let asr: ASRProvider;
    if (config.sonioxApiKey) {
      asr = new SonioxASRProvider({
        apiKey: config.sonioxApiKey,
        model: sonioxRealtimeModel,
        languageHints: sonioxLanguageHints,
        // Recording always diarizes speakers; dictation has one speaker.
        diarization: !dictation,
        dictation,
        proxy: config.providerProxy,
        onRecovery,
      });
    } else if (dictation && config.localAsr) {
      const local = config.localAsr;
      const roomName = ctx.job.room?.name;
      const voiceSessionId = roomName
        ? voiceSessionFromRoom(roomName)
        : undefined;
      asr = new SenseVoiceASRProvider({
        recognizer: () => loadSenseVoiceRecognizer(local),
        // The owner's connected CLI rewrites each segment; a slow or failed
        // rewrite keeps the recognized text.
        polish: voiceSessionId
          ? (text, signal) =>
              client.polishDictation(
                voiceSessionId,
                text,
                AbortSignal.any([signal, AbortSignal.timeout(polishTimeoutMs)]),
              )
          : undefined,
      });
    } else {
      // The local model has no speaker labels, so recording needs Soniox.
      throw new Error("Voice transcription requires SONIOX_API_KEY");
    }
    // The SDK logs rejected shutdown callbacks but otherwise exits the job with 0.
    await new VoiceTrackWorker(client, asr, () => process.exit(1)).run(ctx);
  },
});
