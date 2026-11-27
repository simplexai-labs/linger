import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { connectorMessages } from "@/features/apps/connectors.messages";
import {
  ProviderKeyForm,
  ProviderKeyLink,
} from "@/features/apps/provider-key-form";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubVoiceMediaPolicy,
  TeamHubVoiceProvider,
  TeamHubVoiceProviderKeyStatus,
} from "@/features/teamhub/teamhub-types";
import { commonMessages } from "@/i18n/common.messages";
import type { Translate } from "@/i18n/language";
import type { Message } from "@/i18n/messages";
import { RichMessage, useT } from "@/i18n/use-translation";
import { cn } from "@/lib/cn";

import { publishVoiceMediaPolicy } from "./use-voice-media-policy";
import { voiceKeyMessages as m } from "./voice-key.messages";

// Where TeamHub keeps saved keys; a server without it can only read keys
// from its environment.
const STORAGE_VARIABLE = "TEAMHUB_SECRET_ENCRYPTION_KEY";

const CODE_TAGS = {
  code: (text: string) => <code className="font-mono">{text}</code>,
};

const providerDetails: Record<
  TeamHubVoiceProvider,
  {
    environmentVariable: string;
    href: string;
    name: string;
    purpose: Message<string>;
  }
> = {
  soniox: {
    environmentVariable: "SONIOX_API_KEY",
    href: "https://console.soniox.com/",
    name: "Soniox",
    purpose: m.sonioxPurpose,
  },
  xai: {
    environmentVariable: "XAI_API_KEY",
    href: "https://console.x.ai/",
    name: "xAI",
    purpose: m.xaiPurpose,
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

function describeSaveError(
  error: Error,
  provider: TeamHubVoiceProvider,
  t: Translate,
) {
  const { environmentVariable, name } = providerDetails[provider];
  switch (error instanceof TeamHubError ? error.code : undefined) {
    case "INVALID_REQUEST":
      return t(m.invalidKey);
    case "VOICE_KEY_REJECTED":
      return t(m.keyRejected, { provider: name });
    case "VOICE_KEY_NO_BALANCE":
      return t(m.noBalance, { provider: name });
    case "VOICE_KEY_NO_REALTIME_PERMISSION":
      return t(m.noRealtimePermission, { provider: name });
    case "VOICE_KEY_FROM_ENVIRONMENT":
      return t(m.keyFromEnvironment, {
        provider: name,
        variable: environmentVariable,
      });
    case "VOICE_KEY_STORAGE_UNAVAILABLE":
      return t(m.storageUnavailable, { storageVariable: STORAGE_VARIABLE });
    case "VOICE_PROVIDER_UNAVAILABLE":
      return t(m.providerUnreachable, { provider: name });
    case "VOICE_MEDIA_OFF":
      return t(m.voiceOff);
    default:
      return t(m.saveFailed);
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
  const t = useT();
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
  const canSaveForm =
    !turnOnFailed &&
    status?.source !== "environment" &&
    status?.can_save !== false;

  return (
    <ModalDialog
      className="app-key-dialog"
      closeOnBackdrop
      description={
        providers.length === 1 &&
        status?.source === "stored" &&
        status.can_save !== false
          ? t(connectorMessages.keyReplaceHint)
          : undefined
      }
      onClose={onClose}
      size="md"
      title={
        providers.length > 1
          ? t(m.turnOnVoice)
          : t(m.title, { provider: details.name })
      }
    >
      <div
        className={cn(
          "space-y-4 px-5 pt-2 text-sm text-app-body",
          canSaveForm ? "pb-4" : "pb-5",
        )}
      >
        {turnOnFailed ? (
          <>
            <p role="alert">{t(m.savedButOff)}</p>
            <div className="flex items-center justify-end gap-2">
              <Button disabled={retrying} onClick={onClose} tone="secondary">
                {t(commonMessages.cancel)}
              </Button>
              <Button
                loading={retrying}
                onClick={() => {
                  setRetrying(true);
                  void turnOn().finally(() => setRetrying(false));
                }}
                tone="primary"
              >
                {t(commonMessages.tryAgain)}
              </Button>
            </div>
          </>
        ) : (
          <>
            {providers.length > 1 ? (
              <div
                aria-label={t(m.voiceProvider)}
                className="inline-flex rounded-lg bg-muted p-0.5"
                role="group"
              >
                {providers.map((option) => (
                  <button
                    aria-pressed={option === provider}
                    className={cn(
                      "rounded-md px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      option === provider
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    key={option}
                    onClick={() => setProvider(option)}
                    type="button"
                  >
                    {providerDetails[option].name}
                  </button>
                ))}
              </div>
            ) : null}
            {status?.source === "environment" ? (
              <p className="text-muted-foreground">
                <RichMessage
                  message={m.keyFromEnvironmentNotice}
                  tags={CODE_TAGS}
                  values={{
                    provider: details.name,
                    variable: details.environmentVariable,
                  }}
                />
              </p>
            ) : status?.can_save === false ? (
              <p className="text-muted-foreground">
                <RichMessage
                  message={m.cannotSaveHere}
                  tags={CODE_TAGS}
                  values={{
                    provider: details.name,
                    storageVariable: STORAGE_VARIABLE,
                    variable: details.environmentVariable,
                  }}
                />
              </p>
            ) : (
              <ProviderKeyForm
                describeError={(error) => describeSaveError(error, provider, t)}
                helper={t(details.purpose)}
                key={provider}
                label={t(m.apiKey, { provider: details.name })}
                labelAction={<ProviderKeyLink href={details.href} />}
                onCancel={onClose}
                // TeamHub answers the save once the voice workers are up.
                pendingLabel={t(m.turningOn)}
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
            )}
          </>
        )}
      </div>
    </ModalDialog>
  );
}
