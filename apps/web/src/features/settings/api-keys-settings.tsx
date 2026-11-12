import { Tick02Icon } from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { StatusPill } from "@/components/ui/status-pill";
import { AppLogoTile } from "@/features/apps/app-logo";
import { externalAppsQueryOptions } from "@/features/apps/connected-apps-queries";
import { ComposioKeyForm } from "@/features/apps/provider-key-form";
import { ComposioKeyGuide } from "@/features/apps/provider-key-guide";
import { LazyVoiceKeyDialog } from "@/features/rooms/voice-control/lazy-voice-key-dialog";
import { useVoiceMediaPolicy } from "@/features/rooms/voice-control/use-voice-media-policy";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubVoiceProvider,
  TeamHubVoiceProviderKeyStatus,
} from "@/features/teamhub/teamhub-types";
import { useParams } from "react-router";

/** Composio serves its own mark the same way it serves connector logos. */
const composioLogoUrl = "https://logos.composio.dev/api/composio";

/** Every provider key this server uses, managed in one list in Security. */
export function ApiKeysSettings() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [voiceDialog, setVoiceDialog] = useState<TeamHubVoiceProvider>();
  // Voice keys matter only where this deployment can run voice; the policy
  // is read per Space, so Security outside a Space shows no voice rows.
  const tenantId = useParams().tenantId ?? "";
  const voicePolicy = useVoiceMediaPolicy(tenantId, Boolean(tenantId));
  function open() {
    setNotice(undefined);
    setDialogOpen(true);
  }
  function openVoice(provider: TeamHubVoiceProvider) {
    setNotice(undefined);
    setVoiceDialog(provider);
  }

  return (
    <section className="flex flex-col gap-3">
      <header>
        <h2 className="text-base text-foreground">API keys</h2>
        <p className="text-sm text-muted-foreground">
          Used by everyone on this server. Stored encrypted and never shown
          again.
        </p>
      </header>
      <div className="divide-y divide-border rounded-2xl border border-border bg-background">
        <ComposioKeyRow onOpen={open} />
        {voicePolicy?.voice_available ? (
          <>
            <VoiceKeyRow
              detail="Transcribes meetings, Pocket Notes dictation and Voice Mode dictation."
              environmentVariable="SONIOX_API_KEY"
              onOpen={() => openVoice("soniox")}
              status={voicePolicy.soniox_key}
              title="Soniox"
            />
            <VoiceKeyRow
              detail="Turns Voice Mode into a live conversation with Grok."
              environmentVariable="XAI_API_KEY"
              onOpen={() => openVoice("xai")}
              status={voicePolicy.xai_key}
              title="xAI"
            />
          </>
        ) : null}
      </div>

      {notice ? (
        <p
          className="flex items-center gap-2 text-sm text-app-success"
          role="status"
        >
          <Icon icon={Tick02Icon} size={16} />
          {notice}
        </p>
      ) : null}

      {dialogOpen ? (
        <ModalDialog
          className="app-key-dialog"
          closeOnBackdrop
          description="Connects Gmail, GitHub, Slack, Notion and other apps for everyone here."
          onClose={() => setDialogOpen(false)}
          size="md"
          title={
            <span className="flex items-center gap-2.5">
              <AppLogoTile name="Composio" small url={composioLogoUrl} />
              Composio key
            </span>
          }
        >
          <div className="space-y-4 px-5 py-5 text-sm text-app-body">
            <ComposioKeyGuide />
            <ComposioKeyForm
              onSaved={() => {
                setNotice("Composio key saved");
                setDialogOpen(false);
              }}
            />
          </div>
        </ModalDialog>
      ) : null}

      {voiceDialog ? (
        <LazyVoiceKeyDialog
          onClose={() => setVoiceDialog(undefined)}
          onReady={(provider) => {
            setNotice(`${provider === "soniox" ? "Soniox" : "xAI"} key saved`);
            setVoiceDialog(undefined);
          }}
          policy={voicePolicy}
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
  return source === "environment" ? (
    <StatusPill>Set by your server</StatusPill>
  ) : source === "stored" ? (
    <StatusPill tone="success">Active</StatusPill>
  ) : (
    <StatusPill>Not set</StatusPill>
  );
}

function VoiceKeyRow({
  detail,
  environmentVariable,
  onOpen,
  status,
  title,
}: {
  detail: string;
  environmentVariable: string;
  onOpen: () => void;
  status: TeamHubVoiceProviderKeyStatus | undefined;
  title: string;
}) {
  return (
    <KeyRow
      actions={
        status?.can_save ? (
          <Button
            aria-label={`${status.source === "stored" ? "Replace" : "Add"} ${title} key`}
            onClick={onOpen}
          >
            {status.source === "stored" ? "Replace key" : "Add key"}
          </Button>
        ) : null
      }
      detail={
        status?.source === "environment"
          ? `${detail} Set with ${environmentVariable} on the server.`
          : status?.can_save === false
            ? `${detail} Set ${environmentVariable} on the server, or set TEAMHUB_SECRET_ENCRYPTION_KEY to save the key here.`
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
  const { client } = useTeamHubRuntime();
  const catalog = useQuery(externalAppsQueryOptions(client));
  const key = catalog.data?.provider_key;
  const detail =
    key?.source === "environment"
      ? "Connects Gmail, GitHub, Slack, Notion and other apps. Set with COMPOSIO_API_KEY on the server, in user.env when Linger is installed on this computer."
      : key?.can_save === false
        ? "Connects Gmail, GitHub, Slack, Notion and other apps. When Linger is installed on this computer, set COMPOSIO_API_KEY in user.env, then reopen the Linger app. On a server you run yourself, set it there, or set TEAMHUB_SECRET_ENCRYPTION_KEY to save the key here."
        : "Connects Gmail, GitHub, Slack, Notion and other apps. Use a key with full read and write access.";
  return (
    <KeyRow
      actions={
        key?.can_save ? (
          <Button onClick={onOpen}>
            {key.source === "stored" ? "Replace key" : "Add key"}
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
