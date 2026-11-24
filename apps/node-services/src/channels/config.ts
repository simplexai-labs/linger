import { serviceCredential } from "@linger/service-kit/node";

import { teamHubBaseUrl } from "../teamhub-base-url.js";

export interface ChannelsConfig {
  readonly teamHubBaseUrl: string;
  /** Calls TeamHub internal channel routes; undefined without LINGER_SECRET_SEED. */
  readonly teamHubCredential: string | undefined;
  /** Authenticates TeamHub's reconcile, wake, and pairing calls into Node Services. */
  readonly managementCredential: string | undefined;
}

export function readChannelsConfig(
  environment: NodeJS.ProcessEnv,
): ChannelsConfig {
  return Object.freeze({
    teamHubBaseUrl: teamHubBaseUrl(environment),
    teamHubCredential: serviceCredential("teamhub-internal", environment),
    managementCredential: serviceCredential(
      "node-services-internal",
      environment,
    ),
  });
}
