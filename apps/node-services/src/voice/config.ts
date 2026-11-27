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
  /**
   * Whether a deployment without a Soniox key downloads and runs the local
   * speech model for dictation (VOICE_LOCAL_ASR, on unless "0").
   */
  readonly localAsr: boolean;
}

export function readVoiceConfig(environment: NodeJS.ProcessEnv): VoiceConfig {
  return Object.freeze({
    teamHubBaseUrl: teamHubBaseUrl(environment),
    teamHubCredential: serviceCredential("voice-runtime", environment),
    managementCredential: serviceCredential(
      "node-services-internal",
      environment,
    ),
    region: environment.SIMPLEX_REGION === "cn" ? "cn" : "global",
    localAsr: environment.VOICE_LOCAL_ASR?.trim() !== "0",
  });
}
