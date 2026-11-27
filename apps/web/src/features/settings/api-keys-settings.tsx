import { Tick02Icon } from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { Button, buttonClassName } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { StatusPill } from "@/components/ui/status-pill";
import { AppLogoTile } from "@/features/apps/app-logo";
import { externalAppsQueryOptions } from "@/features/apps/connected-apps-queries";
import { ComposioKeyDialog } from "@/features/apps/provider-key-form";
import { voiceKeyMessages } from "@/features/rooms/voice-control/voice-key.messages";
import { LazyVoiceKeyDialog } from "@/features/rooms/voice-control/lazy-voice-key-dialog";
import { useVoiceMediaPolicy } from "@/features/rooms/voice-control/use-voice-media-policy";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubVoiceProvider,
  TeamHubVoiceProviderKeyStatus,
} from "@/features/teamhub/teamhub-types";
import { voiceSettingsMessages } from "@/features/voice-settings/voice-settings.messages";
import { useT } from "@/i18n/use-translation";
import { Link, useParams } from "react-router";

import { accountSettingsMessages } from "./account-settings.messages";

/** Composio serves its own mark the same way it serves connector logos. */
const composioLogoUrl = "https://logos.composio.dev/api/composio";

/** Every provider key this server uses, managed in one list in Security. */
export function ApiKeysSettings() {
  const t = useT();
  const [dialogOpen, setDialogOpen] = useState(false);
  // The provider whose key was just saved, named in the notice below.
  const [savedProvider, setSavedProvider] = useState<string>();
  const [voiceDialog, setVoiceDialog] = useState<TeamHubVoiceProvider>();
  // Voice keys matter only where this deployment can run voice; the policy
  // is read per Space, so Security outside a Space shows no voice rows.
  const tenantId = useParams().tenantId ?? "";
  const voicePolicy = useVoiceMediaPolicy(tenantId, Boolean(tenantId));
  function open() {
    setSavedProvider(undefined);
    setDialogOpen(true);
  }
  function openVoice(provider: TeamHubVoiceProvider) {
    setSavedProvider(undefined);
    setVoiceDialog(provider);
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base text-foreground">
        {t(accountSettingsMessages.apiKeys)}
      </h2>
      <div className="rounded-2xl border border-border bg-background">
        <ComposioKeyRow onOpen={open} />
        {voicePolicy?.voice_available ? (
          <>
            <VoiceKeyRow
              detail={t(voiceKeyMessages.sonioxPurpose)}
              environmentVariable="SONIOX_API_KEY"
              extraAction={
                tenantId ? (
                  <Link
                    className={buttonClassName({ tone: "ghost" })}
                    to={`/t/${tenantId}/settings/voice?tab=cloud`}
                  >
                    {t(voiceSettingsMessages.voiceSettingsLink)}
                  </Link>
                ) : null
              }
              onOpen={() => openVoice("soniox")}
              status={voicePolicy.soniox_key}
              title="Soniox"
            />
            <VoiceKeyRow
              detail={t(voiceKeyMessages.xaiPurpose)}
              environmentVariable="XAI_API_KEY"
              onOpen={() => openVoice("xai")}
              status={voicePolicy.xai_key}
              title="xAI"
            />
          </>
        ) : null}
      </div>

      {savedProvider ? (
        <p
          className="flex items-center gap-2 text-sm text-app-success"
          role="status"
        >
          <Icon icon={Tick02Icon} size={16} />
          {t(accountSettingsMessages.providerKeySaved, {
            provider: savedProvider,
          })}
        </p>
      ) : null}

      {dialogOpen ? (
        <ComposioKeyDialog
          onClose={() => setDialogOpen(false)}
          onSaved={() => {
            setSavedProvider("Composio");
            setDialogOpen(false);
          }}
          title={
            <span className="flex items-center gap-2.5">
              <AppLogoTile name="Composio" small url={composioLogoUrl} />
              {t(accountSettingsMessages.providerKey, { provider: "Composio" })}
            </span>
          }
        />
      ) : null}

      {voiceDialog ? (
        <LazyVoiceKeyDialog
          onClose={() => setVoiceDialog(undefined)}
          onReady={(provider) => {
            setSavedProvider(provider === "soniox" ? "Soniox" : "xAI");
            setVoiceDialog(undefined);
          }}
          policy={voicePolicy}
          preferCloud
          providers={[voiceDialog]}
          tenantId={tenantId}
        />
      ) : null}
    </section>
  );
}

/** Where a server key comes from: its environment, a saved key, or nowhere. */
function KeySourcePill({
  source,
}: {
  source: TeamHubVoiceProviderKeyStatus["source"];
}) {
  const t = useT();
  return source === "environment" ? (
    <StatusPill>{t(accountSettingsMessages.keySetByServer)}</StatusPill>
  ) : source === "stored" ? (
    <StatusPill tone="success">
      {t(accountSettingsMessages.keyActive)}
    </StatusPill>
  ) : (
    <StatusPill>{t(accountSettingsMessages.keyNotSet)}</StatusPill>
  );
}

function VoiceKeyRow({
  detail,
  environmentVariable,
  extraAction,
  onOpen,
  status,
  title,
}: {
  detail: string;
  environmentVariable: string;
  extraAction?: ReactNode;
  onOpen: () => void;
  status: TeamHubVoiceProviderKeyStatus | undefined;
  title: string;
}) {
  const t = useT();
  const hasActions = Boolean(status?.can_save || extraAction);
  return (
    <KeyRow
      actions={
        hasActions ? (
          <>
            {extraAction}
            {status?.can_save ? (
              <Button
                aria-label={t(
                  status.source === "stored"
                    ? accountSettingsMessages.replaceProviderKey
                    : accountSettingsMessages.addProviderKey,
                  { provider: title },
                )}
                onClick={onOpen}
              >
                {status.source === "stored"
                  ? t(accountSettingsMessages.replaceKey)
                  : t(accountSettingsMessages.addKey)}
              </Button>
            ) : null}
          </>
        ) : null
      }
      detail={
        status?.source === "environment"
          ? t(accountSettingsMessages.voiceKeyFromEnvironment, {
              detail,
              variable: environmentVariable,
            })
          : status?.can_save === false
            ? t(accountSettingsMessages.voiceKeyCannotSave, {
                detail,
                variable: environmentVariable,
              })
            : detail
      }
      logo={<AppLogoTile name={title} />}
      pill={status ? <KeySourcePill source={status.source} /> : null}
      title={title}
    />
  );
}

function KeyRow({
  actions,
  detail,
  logo,
  pill,
  title,
}: {
  actions?: ReactNode;
  detail: string;
  logo: ReactNode;
  pill?: ReactNode;
  title: string;
}) {
  return (
    <div className="flex flex-col gap-3 px-6 py-4 sm:flex-row sm:items-center">
      {logo}
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm text-foreground">
          {title}
          {pill}
        </p>
        <p className="text-sm text-muted-foreground">{detail}</p>
      </div>
      {actions ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
    </div>
  );
}

function ComposioKeyRow({ onOpen }: { onOpen: () => void }) {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const catalog = useQuery(externalAppsQueryOptions(client));
  const key = catalog.data?.provider_key;
  const detail = t(
    key?.source === "environment"
      ? accountSettingsMessages.composioDetailFromEnvironment
      : key?.can_save === false
        ? accountSettingsMessages.composioDetailCannotSave
        : accountSettingsMessages.composioDetail,
  );
  return (
    <KeyRow
      actions={
        key?.can_save ? (
          <Button onClick={onOpen}>
            {key.source === "stored"
              ? t(accountSettingsMessages.replaceKey)
              : t(accountSettingsMessages.addKey)}
          </Button>
        ) : null
      }
      detail={detail}
      logo={<AppLogoTile name="Composio" url={composioLogoUrl} />}
      pill={key ? <KeySourcePill source={key.source} /> : null}
      title="Composio"
    />
  );
}
