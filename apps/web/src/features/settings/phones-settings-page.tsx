import {
  Add01Icon,
  SmartPhone01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { FormFeedback } from "@/components/ui/form-feedback";
import { Icon } from "@/components/ui/icon";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/features/local-computer/computer-row";
import { relativeTime } from "@/features/local-computer/computer-relative-time";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import { commonMessages } from "@/i18n/common.messages";
import { useT, useTranslation } from "@/i18n/use-translation";

import { PhonePairingDialog } from "./phone-pairing-dialog";
import { RelayNodesSection } from "./relay-nodes-section";
import {
  approvePairedPhone,
  type PairedPhone,
  pairedPhonesQueryKey,
  pairedPhonesQueryOptions,
  removePairedPhone,
} from "./phone-queries";
import { phonesMessages as m } from "./phones-settings.messages";
import { SettingsPageHeading } from "./settings-page-heading";
import { settingsMessages } from "./settings.messages";

const toastMs = 4_000;

/** Settings › Phones: pair the Mobile App with this computer and manage phones. */
export function PhonesSettingsPage() {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const phones = useQuery(pairedPhonesQueryOptions(client));
  const [pairing, setPairing] = useState(false);
  const [removing, setRemoving] = useState<PairedPhone>();
  const [pairedName, setPairedName] = useState<string>();

  useEffect(() => {
    if (!pairedName) return undefined;
    const timer = window.setTimeout(() => setPairedName(undefined), toastMs);
    return () => window.clearTimeout(timer);
  }, [pairedName]);

  return (
    <div className="mx-auto flex w-full max-w-(--app-settings-width) flex-col gap-8 pb-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <SettingsPageHeading
          description={t(m.description)}
          title={t(settingsMessages.phones)}
        />
        <Button
          disabled={!phones.data}
          onClick={() => {
            setPairedName(undefined);
            setPairing(true);
          }}
          tone="primary"
        >
          <Icon icon={Add01Icon} size={16} />
          {t(m.pairPhone)}
        </Button>
      </div>

      {phones.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : phones.isError ? (
        <div className="flex flex-col items-start gap-3">
          <FormFeedback tone="danger">{phones.error.message}</FormFeedback>
          <Button onClick={() => void phones.refetch()}>
            {t(commonMessages.retry)}
          </Button>
        </div>
      ) : phones.data.items.length === 0 ? (
        <section className="rounded-2xl border border-border bg-background px-6 py-8 text-center text-sm text-muted-foreground">
          {t(m.empty)}
        </section>
      ) : (
        <ul
          aria-label={t(m.listLabel)}
          className="divide-y divide-border rounded-2xl border border-border bg-background"
        >
          {phones.data.items.map((phone) => (
            <PhoneRow
              key={phone.id}
              onRemove={() => setRemoving(phone)}
              phone={phone}
            />
          ))}
        </ul>
      )}
      {phones.data && phones.data.items.length > 0 ? (
        <p className="text-sm text-muted-foreground">{t(m.keepOpenHint)}</p>
      ) : null}

      {phones.data ? <RelayNodesSection /> : null}

      {pairing && phones.data ? (
        <PhonePairingDialog
          knownPhoneIds={phones.data.items.map((phone) => phone.id)}
          onClose={() => setPairing(false)}
          onPaired={(phone) => {
            setPairing(false);
            setPairedName(phone.name);
            void queryClient.invalidateQueries({
              queryKey: pairedPhonesQueryKey(),
            });
          }}
        />
      ) : null}

      {removing ? (
        <RemovePhoneDialog
          onClose={() => setRemoving(undefined)}
          phone={removing}
        />
      ) : null}

      {pairedName ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
          <p
            className="town-toast-enter flex items-center gap-2 rounded-xl bg-popover px-4 py-2.5 text-sm text-foreground shadow-lg"
            role="status"
          >
            <Icon className="text-app-success" icon={Tick02Icon} size={16} />
            {t(m.paired, { name: pairedName })}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function PhoneRow({
  onRemove,
  phone,
}: {
  onRemove: () => void;
  phone: PairedPhone;
}) {
  const translation = useTranslation();
  const { t } = translation;
  return (
    <li className="flex items-center gap-3 px-6 py-4">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon icon={SmartPhone01Icon} size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm text-foreground">
          <span className="truncate">{phone.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {t(phone.platform === "ios" ? m.iphone : m.android)}
          </span>
        </p>
        {phone.status === "pending" ? (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <StatusDot tone="neutral" />
            {t(m.waitingApproval)}
            <span aria-hidden>·</span>
            <span className="font-mono tabular-nums">
              {phone.confirmation_code}
            </span>
          </p>
        ) : (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <StatusDot tone={phone.connected ? "success" : "neutral"} />
            {phone.connected
              ? t(m.connectedNow)
              : t(m.lastSeen, {
                  time: relativeTime(phone.last_seen_at, translation),
                })}
            <span aria-hidden>·</span>
            <span className="text-xs">
              {t(phone.push_enabled ? m.pushOn : m.pushOff)}
            </span>
          </p>
        )}
      </div>
      {phone.status === "pending" ? <ApprovePhoneButton phone={phone} /> : null}
      <Button
        aria-label={t(m.removePhone, { name: phone.name })}
        data-voice-risk="never"
        onClick={onRemove}
        size="compact"
        tone="danger"
      >
        {t(commonMessages.remove)}
      </Button>
    </li>
  );
}

function ApprovePhoneButton({ phone }: { phone: PairedPhone }) {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const approve = useMutation({
    mutationFn: () => approvePairedPhone(client, phone.id),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: pairedPhonesQueryKey() }),
  });
  return (
    <Button
      data-voice-risk="confirm"
      disabled={approve.isPending}
      onClick={() => approve.mutate()}
      size="compact"
      tone="primary"
    >
      {t(m.approve)}
    </Button>
  );
}

function RemovePhoneDialog({
  onClose,
  phone,
}: {
  onClose: () => void;
  phone: PairedPhone;
}) {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => removePairedPhone(client, phone.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: pairedPhonesQueryKey() });
      onClose();
    },
  });
  return (
    <ModalDialog
      description={t(m.removeDescription)}
      footer={
        <>
          <Button disabled={remove.isPending} onClick={onClose}>
            {t(commonMessages.cancel)}
          </Button>
          <Button
            data-voice-risk="never"
            loading={remove.isPending}
            onClick={() => remove.mutate()}
            tone="danger"
          >
            {t(commonMessages.remove)}
          </Button>
        </>
      }
      onClose={() => {
        if (!remove.isPending) onClose();
      }}
      size="sm"
      title={t(m.removeTitle, { name: phone.name })}
    >
      {remove.isError ? (
        <div className="px-5 py-4">
          <FormFeedback tone="danger">{remove.error.message}</FormFeedback>
        </div>
      ) : null}
    </ModalDialog>
  );
}
