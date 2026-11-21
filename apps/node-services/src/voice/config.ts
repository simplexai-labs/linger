import type { Region } from "@linger/service-kit";
import { serviceCredential } from "@linger/service-kit/node";
import { teamHubBaseUrl } from "../teamhub-base-url.js";

export interface VoiceConfig {
  readonly teamHubBaseUrl: string;
  /** Reads provider keys from TeamHub; undefined without LINGER_SECRET_SEED. */
  readonly teamHubCredential: string | undefined;
  /** Authenticates TeamHub's reconcile notifications. */
  readonly managementCredential: string | undefined;
  /**
   * The download region the installer resolved (SIMPLEX_REGION); model
   * packages come from its registry first. Global when unset.
   */
  readonly region: Region;
  /** Local dictation transcribes on this computer instead of Soniox. */
  readonly localAsr: boolean;
  /** The extracted streaming zipformer directory local dictation reads. */
  readonly localAsrModelDir: string;
}

export function readVoiceConfig(environment: NodeJS.ProcessEnv): VoiceConfig {
  const localAsrRaw = environment.VOICE_LOCAL_ASR?.trim() || "off";
  if (localAsrRaw !== "on" && localAsrRaw !== "off")
    throw new Error("VOICE_LOCAL_ASR must be on or off");
  const localAsrModelDir = environment.VOICE_LOCAL_ASR_MODEL_DIR?.trim() || "";
  if (localAsrRaw === "on" && !localAsrModelDir)
    throw new Error("VOICE_LOCAL_ASR=on requires VOICE_LOCAL_ASR_MODEL_DIR");
  return Object.freeze({
    teamHubBaseUrl: teamHubBaseUrl(environment),
    teamHubCredential: serviceCredential("voice-runtime", environment),
    managementCredential: serviceCredential(
      "node-services-internal",
      environment,
    ),
    region: environment.SIMPLEX_REGION === "cn" ? "cn" : "global",
    localAsr: localAsrRaw === "on",
    localAsrModelDir,
  });
}
