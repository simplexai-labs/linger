import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { ProviderKeyForm } from "@/features/apps/provider-key-form";
import { ProviderKeyGuide } from "@/features/apps/provider-key-guide";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubVoiceMediaPolicy,
  TeamHubVoiceProvider,
  TeamHubVoiceProviderKeyStatus,
} from "@/features/teamhub/teamhub-types";

import { publishVoiceMediaPolicy } from "./use-voice-media-policy";

const providerDetails: Record<
  TeamHubVoiceProvider,
  {
    environmentVariable: string;
    href: string;
    name: string;
    purpose: string;
    steps: string[];
  }
> = {
  soniox: {
    environmentVariable: "SONIOX_API_KEY",
    href: "https://console.soniox.com/",
    name: "Soniox",
    purpose:
      "Transcribes meetings, Pocket Notes dictation and Voice Mode dictation.",
    steps: [
      "Open the Soniox Console and sign in or create an account.",
      "Create an API key.",
      "Copy the key, paste it below, and select Save key.",
    ],
  },
  xai: {
    environmentVariable: "XAI_API_KEY",
    href: "https://console.x.ai/",
    name: "xAI",
    purpose: "Turns Voice Mode into a live conversation with Grok.",
    steps: [
      "Open the xAI Console and sign in or create an account.",
      "Create an API key.",
      "Copy the key, paste it below, and select Save key.",
    ],
  },
};

function voiceProviderKeyStatus(
  policy: TeamHubVoiceMediaPolicy | undefined,
  provider: TeamHubVoiceProvider,
): TeamHubVoiceProviderKeyStatus | undefined {
  return provider === "soniox" ? policy?.soniox_key : policy?.xai_key;
}

/** Whether `policy` reports the voice that `provider`'s key turns on. */
function voiceReady(
  policy: TeamHubVoiceMediaPolicy,
  provider: TeamHubVoiceProvider,
) {
  return provider === "soniox"
    ? policy.voice_media_supported
    : policy.live_supported === true;
}

function describeSaveError(error: Error, provider: TeamHubVoiceProvider) {
  const { environmentVariable, name } = providerDetails[provider];
  switch (error instanceof TeamHubError ? error.code : undefined) {
    case "INVALID_REQUEST":
      return "Enter a valid API key.";
    case "VOICE_KEY_REJECTED":
      return `${name} rejected this key. Check it and try again.`;
    case "VOICE_KEY_FROM_ENVIRONMENT":
      return `This server sets the ${name} key with ${environmentVariable}, so it cannot be changed here.`;
    case "VOICE_KEY_STORAGE_UNAVAILABLE":
      return "This server cannot store keys. Whoever runs it must set TEAMHUB_SECRET_ENCRYPTION_KEY.";
    case "VOICE_PROVIDER_UNAVAILABLE":
      return `Could not reach ${name} to check the key. Try again in a moment.`;
    case "VOICE_MEDIA_OFF":
      return "Voice is turned off on this server.";
    default:
      return "Could not save the key. Try again.";
  }
}

/**
 * Takes the Soniox or xAI key a voice action needs, then reads this Space's
 * voice policy once and hands it to `onReady` when it reports that voice, so
 * the caller can continue the action that was clicked.
 */
export function VoiceKeyDialog({
  onClose,
  onReady,
  policy,
  providers,
  tenantId,
}: {
  onClose: () => void;
  onReady: (
    provider: TeamHubVoiceProvider,
    policy: TeamHubVoiceMediaPolicy,
  ) => void;
  /** The policy the caller holds, read only for each key's status. */
  policy: TeamHubVoiceMediaPolicy | undefined;
  providers: readonly TeamHubVoiceProvider[];
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  const [provider, setProvider] = useState(providers[0] ?? "soniox");
  // Set when the key is saved but the fresh policy did not turn voice on.
  const [turnOnFailed, setTurnOnFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);

  async function turnOn() {
    const next = await teamHubData(
      client.api.GET("/v0/tenants/{tenantId}/voice-media-policy", {
        params: { path: { tenantId } },
      }),
    ).catch(() => undefined);
    if (next && voiceReady(next, provider)) {
      setTurnOnFailed(false);
      publishVoiceMediaPolicy(tenantId, next);
      onReady(provider, next);
      return;
    }
    setTurnOnFailed(true);
  }

  const details = providerDetails[provider];
  const status = voiceProviderKeyStatus(policy, provider);
  return (
    <ModalDialog
      closeOnBackdrop
      description={
        providers.length > 1
          ? "Voice needs a Soniox or xAI key. Keys are used by everyone on this server."
          : details.purpose
      }
      onClose={onClose}
      size="md"
      title={providers.length > 1 ? "Turn on voice" : `${details.name} key`}
    >
      <div className="space-y-4 px-5 py-5 text-sm text-app-body">
        {turnOnFailed ? (
          <>
            <p role="alert">
              The key is saved, but voice could not be turned on. Try again.
            </p>
            <Button
              loading={retrying}
              onClick={() => {
                setRetrying(true);
                void turnOn().finally(() => setRetrying(false));
              }}
              tone="primary"
            >
              Try again
            </Button>
          </>
        ) : (
          <>
            {providers.length > 1 ? (
              <div
                aria-label="Voice provider"
                className="flex gap-2"
                role="group"
              >
                {providers.map((option) => (
                  <Button
                    aria-pressed={option === provider}
                    key={option}
                    onClick={() => setProvider(option)}
                    tone={option === provider ? "primary" : "secondary"}
                  >
                    {providerDetails[option].name}
                  </Button>
                ))}
              </div>
            ) : null}
            {providers.length > 1 ? (
              <p className="text-muted-foreground">{details.purpose}</p>
            ) : null}
            {status?.can_save === false ? (
              <p>
                This server cannot save a {details.name} key here. Whoever runs
                it must set{" "}
                <code className="font-mono">{details.environmentVariable}</code>
                , or set{" "}
                <code className="font-mono">TEAMHUB_SECRET_ENCRYPTION_KEY</code>{" "}
                so keys can be saved here.
              </p>
            ) : (
              <>
                <ProviderKeyGuide
                  href={details.href}
                  steps={
                    <ol className="list-decimal space-y-1.5 pl-5">
                      {details.steps.map((step) => (
                        <li key={step}>{step}</li>
                      ))}
                    </ol>
                  }
                />
                <ProviderKeyForm
                  describeError={(error) => describeSaveError(error, provider)}
                  hint="Stored encrypted and never shown again."
                  key={provider}
                  label={`${details.name} API key`}
                  save={async (apiKey) => {
                    await teamHubData(
                      client.api.PUT("/v0/voice-provider-keys/{provider}", {
                        body: { api_key: apiKey },
                        params: { path: { provider } },
                      }),
                    );
                    // The Save button stays pending through this read.
                    await turnOn();
                  }}
                />
              </>
            )}
          </>
        )}
      </div>
    </ModalDialog>
  );
}
