import { useState, type FormEvent, type ReactNode } from "react";

import { Alert02Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { FormFeedback } from "@/components/ui/form-feedback";
import { Icon } from "@/components/ui/icon";
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowText,
} from "@/components/ui/settings-group";
import { Spinner } from "@/components/ui/spinner";
import { ChannelCard } from "@/features/settings/channel-card";

import { useT } from "@/i18n/use-translation";

import {
  useDesktopIMessage,
  type DesktopIMessage,
  type DesktopIMessageError,
  type DesktopIMessageStatus,
} from "./desktop-imessage";
import { desktopIMessageMessages } from "./desktop-imessage.messages";

const m = desktopIMessageMessages;
type T = ReturnType<typeof useT>;

const RUNTIME_ERROR = {
  download_failed: m.downloadFailed,
  checksum_mismatch: m.checksumMismatch,
  extract_failed: m.extractFailed,
  executable_missing: m.executableMissing,
} satisfies Record<NonNullable<DesktopIMessageStatus["runtimeError"]>, unknown>;

const BRIDGE_LINE = {
  stopped: m.finishSetup,
  starting: m.connecting,
  running: m.connected,
  signed_out: m.signedOut,
  no_another_me: m.noAnotherMe,
  other_account: m.otherAccount,
  error: m.unreachable,
} satisfies Record<DesktopIMessageStatus["bridge"], unknown>;

const ERROR = {
  invalid_handle: m.invalidHandle,
  too_many_handles: m.tooManyHandles,
  failed: m.failed,
} satisfies Record<DesktopIMessageError, unknown>;

// Chatting with Another Me from Messages; shown only in the macOS desktop app.
export function DesktopIMessageCard() {
  const imessage = useDesktopIMessage();
  if (!imessage?.status) return null;
  return <IMessageCard imessage={imessage} status={imessage.status} />;
}

function iMessageStatusMeta(
  status: DesktopIMessageStatus,
  t: T,
): {
  label: string;
  tone: "danger" | "info" | "neutral" | "success" | "warning";
  detail?: string;
} {
  if (!status.enabled) {
    return { label: t(m.statusOff), tone: "neutral" };
  }
  switch (status.bridge) {
    case "running":
      return { label: t(m.connected), tone: "success" };
    case "starting":
      return { label: t(m.connecting), tone: "info" };
    case "stopped":
      return { label: t(m.finishSetup), tone: "warning" };
    case "error":
      return {
        label: t(m.statusAttention),
        tone: "danger",
        detail: t(BRIDGE_LINE[status.bridge]),
      };
    case "signed_out":
    case "no_another_me":
    case "other_account":
      return {
        label: t(m.statusAttention),
        tone: "warning",
        detail: t(BRIDGE_LINE[status.bridge]),
      };
  }
}

function IMessageCard({
  imessage,
  status,
}: {
  imessage: DesktopIMessage;
  status: DesktopIMessageStatus;
}) {
  const t = useT();
  const statusMeta = iMessageStatusMeta(status, t);
  const notice =
    statusMeta.detail || imessage.error ? (
      <div className="space-y-2">
        {statusMeta.detail ? (
          <FormFeedback tone={statusMeta.tone === "danger" ? "danger" : "info"}>
            {statusMeta.detail}
          </FormFeedback>
        ) : null}
        {imessage.error ? (
          <FormFeedback tone="danger">{t(ERROR[imessage.error])}</FormFeedback>
        ) : null}
      </div>
    ) : undefined;

  return (
    <ChannelCard
      channel="imessage"
      description={t(m.footer)}
      enabled={status.enabled}
      expandLabel={t(m.toggleSettings)}
      hasConfiguration={status.enabled}
      notice={notice}
      onToggle={() => void imessage.set({ enabled: !status.enabled })}
      statusLabel={statusMeta.label}
      statusTone={statusMeta.tone}
      switchDisabled={imessage.pending}
      switchLabel={t(m.useIMessage)}
      title={t(m.label)}
    >
      <div className="flex flex-col gap-4">
        <HandlesEditor handles={status.handles} imessage={imessage} />
        <Checklist imessage={imessage} status={status} />
      </div>
    </ChannelCard>
  );
}

function HandlesEditor({
  handles,
  imessage,
}: {
  handles: readonly string[];
  imessage: DesktopIMessage;
}) {
  const t = useT();
  const [draft, setDraft] = useState("");

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim()) return;
    if (await imessage.set({ handles: [...handles, draft] })) setDraft("");
  }

  return (
    <SettingsGroup footer={t(m.handlesFooter)} label={t(m.handlesLabel)}>
      {handles.map((handle) => (
        <SettingsRow key={handle}>
          <SettingsRowText title={handle} />
          <Button
            data-voice-risk="never"
            disabled={imessage.pending}
            onClick={() =>
              void imessage.set({
                handles: handles.filter((item) => item !== handle),
              })
            }
            size="compact"
            tone="ghost"
          >
            {t(m.remove)}
          </Button>
        </SettingsRow>
      ))}
      <SettingsRow>
        <form
          className="flex flex-1 items-center gap-2"
          onSubmit={(event) => void add(event)}
        >
          <input
            aria-label={t(m.handleInput)}
            className="min-w-0 flex-1 bg-transparent text-[14px] text-foreground placeholder:text-muted-foreground focus-visible:outline-none"
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t(m.handlePlaceholder)}
            value={draft}
          />
          <Button
            disabled={imessage.pending || !draft.trim()}
            size="compact"
            type="submit"
          >
            {t(m.add)}
          </Button>
        </form>
      </SettingsRow>
    </SettingsGroup>
  );
}

function Checklist({
  imessage,
  status,
}: {
  imessage: DesktopIMessage;
  status: DesktopIMessageStatus;
}) {
  const t = useT();
  return (
    <SettingsGroup label={t(m.setup)}>
      <CheckRow
        done={status.runtime === "ready"}
        busy={status.runtime === "installing"}
        title={t(m.component)}
        description={t(runtimeLine(status))}
        action={
          status.runtime === "failed" ? (
            <Button
              onClick={() => imessage.act("retry_install")}
              size="compact"
            >
              {t(m.retry)}
            </Button>
          ) : null
        }
      />
      <CheckRow
        done={status.fullDisk === "granted"}
        title={t(m.fullDisk)}
        description={t(
          status.fullDisk === "granted"
            ? m.allowed
            : status.fullDisk === "messagesNotSetUp"
              ? m.messagesNotSetUp
              : m.fullDiskHint,
        )}
        action={
          status.fullDisk === "granted" ? null : (
            <Button
              onClick={() => imessage.act("open_full_disk_settings")}
              size="compact"
            >
              {t(m.openSettings)}
            </Button>
          )
        }
      />
      <CheckRow
        done={status.messagesAutomation === "granted"}
        title={t(m.controlMessages)}
        description={t(
          status.messagesAutomation === "granted"
            ? m.allowed
            : status.messagesAutomation === "denied"
              ? m.automationDenied
              : m.automationHint,
        )}
        action={automationAction(imessage, status, t)}
      />
      <CheckRow
        done={status.iMessageSignedIn === "yes"}
        title={t(m.signedIn)}
        description={t(
          status.iMessageSignedIn === "yes"
            ? m.signedInYes
            : status.iMessageSignedIn === "no"
              ? m.signedInNo
              : m.signedInUnknown,
        )}
      />
    </SettingsGroup>
  );
}

function runtimeLine(status: DesktopIMessageStatus) {
  switch (status.runtime) {
    case "ready":
      return m.installed;
    case "installing":
      return m.installing;
    case "failed":
      return RUNTIME_ERROR[status.runtimeError ?? "download_failed"];
    case "missing":
      return m.installsWhenOn;
  }
}

function automationAction(
  imessage: DesktopIMessage,
  status: DesktopIMessageStatus,
  t: T,
): ReactNode {
  if (status.messagesAutomation === "granted") return null;
  const denied = status.messagesAutomation === "denied";
  return (
    <Button
      onClick={() =>
        imessage.act(denied ? "open_automation_settings" : "request_automation")
      }
      size="compact"
    >
      {t(denied ? m.openSettings : m.allow)}
    </Button>
  );
}

function CheckRow({
  action,
  busy = false,
  description,
  done,
  title,
}: {
  action?: ReactNode;
  busy?: boolean;
  description: string;
  done: boolean;
  title: string;
}) {
  return (
    <SettingsRow
      icon={
        busy ? (
          <Spinner size={14} />
        ) : (
          <Icon icon={done ? Tick02Icon : Alert02Icon} size={14} />
        )
      }
    >
      <SettingsRowText description={description} title={title} />
      {action}
    </SettingsRow>
  );
}
