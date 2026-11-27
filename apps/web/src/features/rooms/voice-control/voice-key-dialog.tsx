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
import { commonMessages } from "@/i18n/common.messages";
import type { Translate } from "@/i18n/language";
import type { Message } from "@/i18n/messages";
import { RichMessage, useT } from "@/i18n/use-translation";

import { publishVoiceMediaPolicy } from "./use-voice-media-policy";
import { voiceKeyMessages as m } from "./voice-key.messages";
import {
  VOICE_KEY_STORAGE_VARIABLE as STORAGE_VARIABLE,
  VoiceLocalModelPage,
} from "./voice-local-model-page";

/** A page of the dialog: a provider's key, or the local speech model. */
export type VoiceDialogPage = TeamHubVoiceProvider | "local";

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
  onReady: (page: VoiceDialogPage, policy: TeamHubVoiceMediaPolicy) => void;
  /** The policy the caller holds, read only for each key's status. */
  policy: TeamHubVoiceMediaPolicy | undefined;
  providers: readonly VoiceDialogPage[];
  tenantId: string;
}) {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const keyProviders = providers.filter(
    (option): option is TeamHubVoiceProvider => option !== "local",
  );
  const [provider, setProvider] = useState<TeamHubVoiceProvider>(
    keyProviders[0] ?? "soniox",
  );
  const [local, setLocal] = useState(providers[0] === "local");
  // Set when the key is saved but the fresh policy did not turn voice on.
  const [turnOnFailed, setTurnOnFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);

  async function turnOn() {
    const page: VoiceDialogPage = local ? "local" : provider;
    const next = await teamHubData(
      client.api.GET("/v0/tenants/{tenantId}/voice-media-policy", {
        params: { path: { tenantId } },
      }),
    ).catch(() => undefined);
    if (
      next &&
      (page === "local"
        ? next.local_dictation_supported === true
        : voiceReady(next, page))
    ) {
      setTurnOnFailed(false);
      publishVoiceMediaPolicy(tenantId, next);
      onReady(page, next);
      return;
    }
    setTurnOnFailed(true);
  }

  const details = providerDetails[provider];
  const status = voiceProviderKeyStatus(policy, provider);
  return (
    <ModalDialog
      closeOnBackdrop
      onClose={onClose}
      size="md"
      title={
        providers.length > 1
          ? t(m.turnOnVoice)
          : local
            ? t(m.localTitle)
            : t(m.title, { provider: details.name })
      }
    >
      <div className="space-y-4 px-5 py-5 text-sm text-app-body">
        {turnOnFailed ? (
          <>
            <p role="alert">{t(local ? m.localSavedButOff : m.savedButOff)}</p>
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
          </>
        ) : (
          <>
            {providers.length > 1 ? (
              <div
                aria-label={t(m.voiceProvider)}
                className="flex gap-2"
                role="group"
              >
                {providers.map((option) => {
                  const pressed =
                    option === "local" ? local : !local && option === provider;
                  return (
                    <Button
                      aria-pressed={pressed}
                      key={option}
                      onClick={() => {
                        setLocal(option === "local");
                        if (option !== "local") setProvider(option);
                      }}
                      tone={pressed ? "primary" : "secondary"}
                    >
                      {option === "local"
                        ? t(m.localModel)
                        : providerDetails[option].name}
                    </Button>
                  );
                })}
              </div>
            ) : null}
            {local ? <VoiceLocalModelPage onSaved={turnOn} /> : null}
            {!local && providers.length > 1 ? (
              <p className="text-muted-foreground">{t(details.purpose)}</p>
            ) : null}
            {local ? null : status?.can_save === false ? (
              <p>
                <RichMessage
                  message={m.cannotSaveHere}
                  tags={{
                    code: (text) => <code className="font-mono">{text}</code>,
                  }}
                  values={{
                    provider: details.name,
                    storageVariable: STORAGE_VARIABLE,
                    variable: details.environmentVariable,
                  }}
                />
              </p>
            ) : (
              <>
                <ProviderKeyGuide
                  href={details.href}
                  steps={
                    <ol className="list-decimal space-y-1.5 pl-5">
                      <li>{t(m.stepOpen, { provider: details.name })}</li>
                      <li>{t(m.stepCreate)}</li>
                      <li>{t(m.stepPaste)}</li>
                    </ol>
                  }
                />
                <ProviderKeyForm
                  describeError={(error) =>
                    describeSaveError(error, provider, t)
                  }
                  key={provider}
                  label={t(m.apiKey, { provider: details.name })}
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
              </>
            )}
          </>
        )}
      </div>
    </ModalDialog>
  );
}
