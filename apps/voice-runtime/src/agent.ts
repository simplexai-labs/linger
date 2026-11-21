import { defineAgent, log } from "@livekit/agents";
import { TeamHubVoiceRuntimeClient } from "@linger/wire-contracts/teamhub-internal/client";

import {
  loadConfig,
  sonioxLanguageHints,
  sonioxRealtimeModel,
} from "./config.js";
import type { ASRProvider } from "./asr.js";
import { LocalASRProvider } from "./local-asr.js";
import { SonioxASRProvider } from "./soniox.js";
import {
  VoiceTrackWorker,
  voiceTrackFailureCode,
  voicePurposeFromMetadata,
} from "./livekit-worker.js";
import type { ASRRecovery } from "./recovering-asr.js";

export default defineAgent({
  entry: async (ctx) => {
    const config = loadConfig();
    const localModelDir = config.localAsrModelDir;
    if (!localModelDir && !config.sonioxApiKey)
      throw new Error(
        "Voice transcription requires SONIOX_API_KEY or VOICE_LOCAL_ASR_MODEL_DIR",
      );
    const dictation =
      voicePurposeFromMetadata(ctx.job.metadata) === "chat_dictation";
    // Recording always diarizes speakers; dictation has one speaker.
    const diarization = !dictation;
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
    const asr: ASRProvider = localModelDir
      ? new LocalASRProvider({ modelDir: localModelDir })
      : new SonioxASRProvider({
          apiKey: config.sonioxApiKey,
          model: sonioxRealtimeModel,
          languageHints: sonioxLanguageHints,
          diarization,
          dictation,
          onRecovery,
        });
    if (localModelDir && !dictation)
      log().warn(
        {},
        "Local transcription has no speaker diarization, so this recording's transcript is not labeled by speaker",
      );
    // The SDK logs rejected shutdown callbacks but otherwise exits the job with 0.
    await new VoiceTrackWorker(client, asr, () => process.exit(1)).run(ctx);
  },
});
