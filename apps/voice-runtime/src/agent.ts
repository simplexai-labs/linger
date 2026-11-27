import { defineAgent, log } from "@livekit/agents";
import { TeamHubVoiceRuntimeClient } from "@linger/wire-contracts/teamhub-internal/client";

import type { ASRProvider } from "./asr.js";
import {
  loadConfig,
  sonioxLanguageHints,
  sonioxRealtimeModel,
} from "./config.js";
import { LocalASRProvider } from "./local-asr.js";
import { SonioxASRProvider } from "./soniox.js";
import {
  localAsrFlushTimeoutMs,
  VoiceTrackWorker,
  voicePurposeFromMetadata,
  voiceSpeechFromMetadata,
  voiceTrackFailureCode,
} from "./livekit-worker.js";
import type { ASRRecovery } from "./recovering-asr.js";

export default defineAgent({
  entry: async (ctx) => {
    const config = loadConfig();
    const purpose = voicePurposeFromMetadata(ctx.job.metadata);
    const dictation = purpose === "chat_dictation";
    const speech = voiceSpeechFromMetadata(ctx.job.metadata);
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

    let asr: ASRProvider;
    let flushTimeoutMs: number | undefined;
    if (speech?.provider === "local") {
      const relay =
        speech.computerId && speech.tenantId && speech.ownerActorId
          ? {
              url: config.nodeServicesInternalUrl,
              token: config.nodeServicesInternalToken,
              tenantId: speech.tenantId,
              ownerActorId: speech.ownerActorId,
              computerId: speech.computerId,
            }
          : undefined;
      if (!relay && !config.localAsrUrl) {
        throw new Error(
          "Local voice transcription requires a target Computer or VOICE_LOCAL_ASR_URL",
        );
      }
      asr = new LocalASRProvider({
        mode: dictation ? "chat_dictation" : "hardware_control",
        modelId: speech.modelId,
        language: speech.language,
        useGpu: speech.useGpu,
        keepLoadedSeconds: speech.keepLoadedSeconds,
        relay,
        directUrl: config.localAsrUrl,
      });
      flushTimeoutMs = localAsrFlushTimeoutMs;
    } else {
      if (!config.sonioxApiKey)
        throw new Error("Voice transcription requires SONIOX_API_KEY");
      const languageHints =
        speech?.language && speech.language !== "auto"
          ? [speech.language]
          : sonioxLanguageHints;
      asr = new SonioxASRProvider({
        apiKey: config.sonioxApiKey,
        model: sonioxRealtimeModel,
        languageHints,
        diarization,
        dictation,
        proxy: config.providerProxy,
        onRecovery,
      });
    }
    // The SDK logs rejected shutdown callbacks but otherwise exits the job with 0.
    await new VoiceTrackWorker(client, asr, () => process.exit(1), {
      asrFlushTimeoutMs: flushTimeoutMs,
    }).run(ctx);
  },
});
