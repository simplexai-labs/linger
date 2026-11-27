import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import qrcode from "qrcode-generator";
import { useEffect, useEffectEvent, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { FormFeedback } from "@/components/ui/form-feedback";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { Spinner } from "@/components/ui/spinner";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import { teamHubErrorText } from "@/features/teamhub/teamhub-error-text";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { Translate } from "@/i18n/language";
import { useT } from "@/i18n/use-translation";

import {
  approvePairedPhone,
  type PairedPhone,
  pairedPhonesQueryOptions,
  pairedPhonesQueryKey,
  phonePairingCodeQueryOptions,
  removePairedPhone,
} from "./phone-queries";
import { phonesMessages as m } from "./phones-settings.messages";

// The phone gives no sign to this page when it pairs; only the list shows it.
const pairedPollMs = 2_000;
// A scanner needs four light modules around the code.
const quietZoneModules = 4;
const qrSizePx = 240;

/**
 * Shows a one-time pairing code as a QR code. When a phone that was not in
 * `knownPhoneIds` pairs, it waits in the list as pending with a confirmation
 * code; the Human compares it with the phone and approves it here, which is
 * what makes the phone usable. The dialog then reports the phone and closes.
 */
export function PhonePairingDialog({
  knownPhoneIds,
  onClose,
  onPaired,
}: {
  knownPhoneIds: readonly string[];
  onClose: () => void;
  onPaired: (phone: PairedPhone) => void;
}) {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const [attempt, setAttempt] = useState(0);
  const [known] = useState(() => new Set(knownPhoneIds));
  const code = useQuery(phonePairingCodeQueryOptions(client, attempt));
  const phones = useQuery({
    ...pairedPhonesQueryOptions(client),
    refetchInterval: pairedPollMs,
  });
  const newPhone = phones.data?.items.find((phone) => !known.has(phone.id));
  const reportPaired = useEffectEvent((phone: PairedPhone) => onPaired(phone));
  useEffect(() => {
    if (newPhone?.status === "approved") reportPaired(newPhone);
  }, [newPhone]);

  const now = useNow(code.data?.expires_at);
  const remainingSeconds = code.data
    ? Math.max(
        0,
        Math.ceil((new Date(code.data.expires_at).getTime() - now) / 1_000),
      )
    : 0;
  const expired = Boolean(code.data) && remainingSeconds === 0;
  const newCode = () => setAttempt((value) => value + 1);

  if (newPhone?.status === "pending") {
    return (
      <ModalDialog
        closeOnBackdrop={false}
        onClose={onClose}
        size="sm"
        title={t(m.confirmTitle)}
      >
        <PhoneApproval phone={newPhone} />
      </ModalDialog>
    );
  }

  return (
    <ModalDialog
      closeOnBackdrop
      onClose={onClose}
      size="sm"
      title={t(m.pairPhone)}
    >
      <div className="flex flex-col items-center gap-4 px-5 py-5 text-sm">
        {code.isPending ? (
          <p
            aria-label={t(m.creatingCode)}
            className="grid place-items-center text-muted-foreground"
            role="status"
            style={{ height: qrSizePx }}
          >
            <Spinner size={20} />
          </p>
        ) : code.isError ? (
          <div className="flex w-full flex-col items-start gap-3">
            <FormFeedback tone="danger">
              {pairingErrorText(code.error, t)}
            </FormFeedback>
            {isMobileUnavailable(code.error) ? null : (
              <Button onClick={newCode}>{t(m.newCode)}</Button>
            )}
          </div>
        ) : !code.data.relay_url && code.data.lan_urls.length === 0 ? (
          <div className="w-full">
            <FormFeedback tone="danger">{t(m.unreachable)}</FormFeedback>
          </div>
        ) : (
          <>
            {expired ? (
              <div
                className="flex flex-col items-center justify-center gap-3 rounded-lg border border-border text-muted-foreground"
                style={{ height: qrSizePx, width: qrSizePx }}
              >
                <p>{t(m.expired)}</p>
                <Button onClick={newCode} tone="primary">
                  {t(m.newCode)}
                </Button>
              </div>
            ) : (
              <PairingQrCode
                label={t(m.qrLabel)}
                value={code.data.pairing_uri}
              />
            )}
            <div className="flex flex-col items-center gap-1 text-center">
              <p className="text-foreground">
                {t(m.computer, { name: code.data.computer_name })}
              </p>
              {expired ? null : (
                <p className="text-muted-foreground tabular-nums">
                  {t(m.expiresIn, {
                    time: minutesAndSeconds(remainingSeconds),
                  })}
                </p>
              )}
            </div>
            <p className="text-center text-muted-foreground">{t(m.scanHint)}</p>
            {expired ? null : <CopyPairingLink value={code.data.pairing_uri} />}
            {code.data.relay_url ? null : (
              <div className="w-full">
                <FormFeedback tone="info">{t(m.noRelay)}</FormFeedback>
              </div>
            )}
          </>
        )}
      </div>
    </ModalDialog>
  );
}

/**
 * The pending phone's name and confirmation code with Approve and Reject.
 * Rejecting removes it, which also spends the code it used.
 */
function PhoneApproval({ phone }: { phone: PairedPhone }) {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: pairedPhonesQueryKey() });
  const approve = useMutation({
    mutationFn: () => approvePairedPhone(client, phone.id),
    onSettled: refresh,
  });
  const reject = useMutation({
    mutationFn: () => removePairedPhone(client, phone.id),
    onSettled: refresh,
  });
  const busy = approve.isPending || reject.isPending || approve.isSuccess;
  const error = approve.error ?? reject.error;
  return (
    <div className="flex flex-col items-center gap-4 px-5 py-5 text-sm">
      <p className="text-foreground">
        {phone.name} · {phone.platform === "ios" ? t(m.iphone) : t(m.android)}
      </p>
      <p
        aria-label={t(m.confirmCodeLabel)}
        className="font-mono text-3xl tracking-[0.3em] text-foreground tabular-nums"
      >
        {phone.confirmation_code}
      </p>
      <p className="text-center text-muted-foreground">{t(m.confirmHint)}</p>
      {error ? (
        <div className="w-full">
          <FormFeedback tone="danger">
            {pairingErrorText(error, t)}
          </FormFeedback>
        </div>
      ) : null}
      <div className="flex w-full justify-end gap-2">
        <Button
          data-voice-risk="never"
          disabled={busy}
          onClick={() => reject.mutate()}
        >
          {t(m.reject)}
        </Button>
        <Button
          data-voice-risk="confirm"
          disabled={busy}
          onClick={() => approve.mutate()}
          tone="primary"
        >
          {approve.isPending ? t(m.waitingApproval) : t(m.approve)}
        </Button>
      </div>
    </div>
  );
}

/**
 * Copies the pairing link for a phone that cannot scan, such as the iOS
 * Simulator, which opens it as a linger:// link.
 */
function CopyPairingLink({ value }: { value: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => setCopied(true));
      }}
      size="compact"
    >
      {copied ? t(m.linkCopied) : t(m.copyLink)}
    </Button>
  );
}

/** Black on white in every theme, so any phone camera reads it. */
function PairingQrCode({ label, value }: { label: string; value: string }) {
  const { path, size } = useMemo(() => {
    const qr = qrcode(0, "L");
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    let modules = "";
    for (let row = 0; row < count; row += 1)
      for (let column = 0; column < count; column += 1)
        if (qr.isDark(row, column))
          modules += `M${column + quietZoneModules} ${row + quietZoneModules}h1v1h-1z`;
    return { path: modules, size: count + quietZoneModules * 2 };
  }, [value]);
  return (
    <svg
      aria-label={label}
      className="rounded-lg"
      height={qrSizePx}
      role="img"
      shapeRendering="crispEdges"
      viewBox={`0 0 ${size} ${size}`}
      width={qrSizePx}
    >
      <rect className="fill-white" height={size} width={size} />
      <path className="fill-black" d={path} />
    </svg>
  );
}

/** The current time, ticking each second while a code is shown. */
function useNow(expiresAt: string | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);
  return now;
}

function minutesAndSeconds(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function isMobileUnavailable(error: Error) {
  return error instanceof TeamHubError && error.code === "MOBILE_UNAVAILABLE";
}

function pairingErrorText(error: Error, t: Translate) {
  if (isMobileUnavailable(error)) return t(m.mobileUnavailable);
  return error instanceof TeamHubError
    ? teamHubErrorText(error, t)
    : error.message;
}
