import { serviceCredential } from "@linger/service-kit/node";
import { teamHubBaseUrl } from "../teamhub-base-url.js";

export interface VoiceConfig {
  readonly teamHubBaseUrl: string;
  /** Reads provider keys from TeamHub; undefined without LINGER_SECRET_SEED. */
  readonly teamHubCredential: string | undefined;
  /** Authenticates TeamHub's reconcile notifications. */
  readonly managementCredential: string | undefined;
}

export function readVoiceConfig(environment: NodeJS.ProcessEnv): VoiceConfig {
  return Object.freeze({
    teamHubBaseUrl: teamHubBaseUrl(environment),
    teamHubCredential: serviceCredential("voice-runtime", environment),
    managementCredential: serviceCredential(
      "node-services-internal",
      environment,
    ),
  });
}
