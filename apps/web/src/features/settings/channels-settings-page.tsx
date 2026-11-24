import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { components } from "@linger/wire-contracts/teamhub-public/types";

import { Button } from "@/components/ui/button";
import { FormFeedback } from "@/components/ui/form-feedback";
import { ModalDialog } from "@/components/ui/modal-dialog";
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowText,
} from "@/components/ui/settings-group";
import { Spinner } from "@/components/ui/spinner";
import { DesktopIMessageCard } from "@/features/local-computer/desktop-imessage-card";
import { teamHubData, teamHubDone } from "@/features/teamhub/teamhub-api";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import { useT } from "@/i18n/use-translation";

import { ChannelCard } from "./channel-card";
import { channelsMessages } from "./channels.messages";
import { encodeQrMatrix } from "./qr-code";
import { SettingsPageHeading } from "./settings-page-heading";

type IMChannelBinding = components["schemas"]["IMChannelBinding"];
type IMChannelListResponse = components["schemas"]["IMChannelListResponse"];
type IMChannelPairingSession = components["schemas"]["IMChannelPairingSession"];

const CHANNELS_QUERY_KEY = ["teamhub", "im-channels"] as const;
const PAIRING_POLL_INTERVAL_MS = 1_500;

function statusMeta(
  binding: IMChannelBinding | undefined,
  t: ReturnType<typeof useT>,
): {
  label: string;
  tone: "danger" | "info" | "neutral" | "success" | "warning";
} {
  if (!binding) {
    return { label: t(channelsMessages.statusNotConnected), tone: "neutral" };
  }
  if (!binding.enabled) {
    return { label: t(channelsMessages.statusDisconnected), tone: "neutral" };
  }
  switch (binding.runtime_status) {
    case "connected":
      return { label: t(channelsMessages.statusConnected), tone: "success" };
    case "starting":
      return { label: t(channelsMessages.statusStarting), tone: "info" };
    case "cooldown":
      return { label: t(channelsMessages.statusCooldown), tone: "warning" };
    case "conflict":
      return { label: t(channelsMessages.statusConflict), tone: "danger" };
    case "auth_expired":
      return { label: t(channelsMessages.statusAuthExpired), tone: "danger" };
    case "disconnected":
      return { label: t(channelsMessages.statusDisconnected), tone: "neutral" };
    case "error":
      return { label: t(channelsMessages.statusError), tone: "danger" };
  }
}

function bindingErrorHint(
  binding: IMChannelBinding | undefined,
  t: ReturnType<typeof useT>,
): string | undefined {
  if (!binding || !binding.enabled) return undefined;
  switch (binding.runtime_error_code) {
    case "WECHAT_SESSION_COOLDOWN":
      return t(channelsMessages.errorCooldown);
    case "WECHAT_CONFLICT":
      return t(channelsMessages.errorConflict);
    case "NO_ANOTHER_ME":
      return t(channelsMessages.errorNoAnotherMe);
    default:
      return binding.runtime_status === "error" ||
        binding.runtime_status === "auth_expired"
        ? t(channelsMessages.errorGeneric)
        : undefined;
  }
}

function QrCodeGraphic({ value, label }: { value: string; label: string }) {
  const matrix = useMemo(() => encodeQrMatrix(value), [value]);
  const pathData = useMemo(() => {
    if (!matrix) return "";
    const parts: string[] = [];
    for (let r = 0; r < matrix.size; r += 1) {
      for (let c = 0; c < matrix.size; c += 1) {
        if (matrix.modules[r * matrix.size + c]) {
          parts.push(`M${String(c)},${String(r)}h1v1h-1z`);
        }
      }
    }
    return parts.join("");
  }, [matrix]);

  if (!matrix) return null;
  const pad = 4;
  const viewBox = `${String(-pad)} ${String(-pad)} ${String(matrix.size + pad * 2)} ${String(matrix.size + pad * 2)}`;

  return (
    <svg
      aria-label={label}
      className="h-52 w-52 rounded-xl border border-border bg-white p-2"
      role="img"
      shapeRendering="crispEdges"
      viewBox={viewBox}
    >
      <rect
        fill="#ffffff"
        height={matrix.size + pad * 2}
        width={matrix.size + pad * 2}
        x={-pad}
        y={-pad}
      />
      <path d={pathData} fill="#111111" />
    </svg>
  );
}

function WeChatPairingDialog({
  onClose,
  onConnected,
}: {
  onClose: () => void;
  onConnected: () => void;
}) {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const [session, setSession] = useState<IMChannelPairingSession | undefined>();
  const [starting, setStarting] = useState(true);
  const [error, setError] = useState(false);
  const [verifyCode, setVerifyCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // Start (or restart) a WeChat QR pairing session when the dialog opens or refreshes.
  useEffect(() => {
    let active = true;
    setStarting(true);
    setError(false);
    setSession(undefined);
    setVerifyCode("");
    void teamHubData(
      client.api.POST("/v0/channels/{provider}/pairings", {
        params: { path: { provider: "wechat" } },
        body: { force: attempt > 0 },
      }),
    )
      .then((next) => {
        if (!active) return;
        setSession(next);
        setStarting(false);
      })
      .catch(() => {
        if (!active) return;
        setError(true);
        setStarting(false);
      });
    return () => {
      active = false;
    };
  }, [attempt, client.api]);

  const pairingId = session?.pairing_id;
  const pairingStatus = session?.status;
  const shouldPoll =
    Boolean(pairingId) &&
    (pairingStatus === "waiting_scan" || pairingStatus === "scanned");

  // Poll TeamHub for scan confirmation while waiting on the user's phone.
  useEffect(() => {
    if (!shouldPoll || !pairingId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const next = await teamHubData(
          client.api.GET("/v0/channels/pairings/{pairingId}", {
            params: { path: { pairingId } },
          }),
        );
        if (!active) return;
        setSession(next);
        if (
          next.status === "confirmed" ||
          next.status === "already_connected"
        ) {
          onConnected();
          return;
        }
        if (next.status === "waiting_scan" || next.status === "scanned") {
          timer = setTimeout(() => void poll(), PAIRING_POLL_INTERVAL_MS);
        }
      } catch {
        if (!active) return;
        timer = setTimeout(() => void poll(), PAIRING_POLL_INTERVAL_MS * 2);
      }
    };

    timer = setTimeout(() => void poll(), PAIRING_POLL_INTERVAL_MS);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [client.api, onConnected, pairingId, shouldPoll]);

  async function handleSubmitVerifyCode(event: FormEvent) {
    event.preventDefault();
    const trimmed = verifyCode.trim();
    if (!trimmed || !pairingId || verifying) return;
    setVerifying(true);
    setError(false);
    try {
      const next = await teamHubData(
        client.api.POST("/v0/channels/pairings/{pairingId}/verify-code", {
          params: { path: { pairingId } },
          body: { verify_code: trimmed },
        }),
      );
      setSession(next);
      setVerifyCode("");
      if (next.status === "confirmed" || next.status === "already_connected") {
        onConnected();
      }
    } catch {
      setError(true);
    } finally {
      setVerifying(false);
    }
  }

  function handleCopyLink() {
    if (!session?.qr_code_url || !navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(session.qr_code_url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    });
  }

  const showRefresh =
    error ||
    pairingStatus === "expired" ||
    pairingStatus === "failed" ||
    pairingStatus === "verify_code_blocked";

  return (
    <ModalDialog
      description={t(channelsMessages.pairingDescription)}
      footer={
        <>
          {showRefresh ? (
            <Button onClick={() => setAttempt((n) => n + 1)} tone="secondary">
              {t(channelsMessages.pairingRefresh)}
            </Button>
          ) : null}
          <Button data-voice-close="" onClick={onClose} tone="ghost">
            {t(channelsMessages.close)}
          </Button>
        </>
      }
      onClose={onClose}
      size="sm"
      title={t(channelsMessages.pairingTitle)}
    >
      <div className="flex flex-col items-center gap-4 py-2 text-center">
        {starting ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Spinner />
            <span>{t(channelsMessages.pairingStarting)}</span>
          </div>
        ) : null}

        {!starting && session?.qr_code_url && pairingStatus !== "confirmed" ? (
          <>
            <QrCodeGraphic
              label={t(channelsMessages.qrAlt)}
              value={session.qr_code_url}
            />
            <Button
              onClick={handleCopyLink}
              size="compact"
              tone="ghost"
              type="button"
            >
              {copied
                ? t(channelsMessages.pairingLinkCopied)
                : t(channelsMessages.pairingCopyLink)}
            </Button>
          </>
        ) : null}

        {pairingStatus === "waiting_scan" ? (
          <p className="text-sm text-muted-foreground">
            {t(channelsMessages.pairingWaitingScan)}
          </p>
        ) : null}

        {pairingStatus === "scanned" ? (
          <p className="text-sm text-foreground">
            {t(channelsMessages.pairingScanned)}
          </p>
        ) : null}

        {pairingStatus === "need_verify_code" ? (
          <form
            className="flex w-full max-w-xs flex-col gap-2"
            onSubmit={(event) => {
              void handleSubmitVerifyCode(event);
            }}
          >
            <label
              className="text-sm text-foreground"
              htmlFor="wechat-verify-code"
            >
              {t(channelsMessages.pairingNeedVerifyCode)}
            </label>
            <div className="flex gap-2">
              <input
                autoComplete="one-time-code"
                className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground"
                id="wechat-verify-code"
                onChange={(e) => setVerifyCode(e.target.value)}
                placeholder={t(channelsMessages.pairingVerifyPlaceholder)}
                value={verifyCode}
              />
              <Button disabled={verifying || !verifyCode.trim()} type="submit">
                {verifying
                  ? t(channelsMessages.pairingVerifySubmitting)
                  : t(channelsMessages.pairingVerifySubmit)}
              </Button>
            </div>
          </form>
        ) : null}

        {pairingStatus === "verify_code_blocked" ? (
          <p className="text-sm text-app-danger" role="alert">
            {t(channelsMessages.pairingVerifyBlocked)}
          </p>
        ) : null}

        {pairingStatus === "expired" ? (
          <p className="text-sm text-muted-foreground">
            {t(channelsMessages.pairingExpired)}
          </p>
        ) : null}

        {pairingStatus === "confirmed" ? (
          <p className="text-sm text-foreground">
            {t(channelsMessages.pairingConfirmed)}
          </p>
        ) : null}

        {pairingStatus === "already_connected" ? (
          <p className="text-sm text-foreground">
            {t(channelsMessages.pairingAlreadyConnected)}
          </p>
        ) : null}

        {error || pairingStatus === "failed" ? (
          <p className="text-sm text-app-danger" role="alert">
            {t(channelsMessages.pairingFailed)}
          </p>
        ) : null}
      </div>
    </ModalDialog>
  );
}

/** Settings › Channels: connects Another Me to network IM channels such as WeChat. */
export function ChannelsSettingsPage() {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const [pairingOpen, setPairingOpen] = useState(false);
  const [actionError, setActionError] = useState(false);

  const channelsQuery = useQuery<IMChannelListResponse>({
    queryFn: () => teamHubData(client.api.GET("/v0/channels")),
    queryKey: CHANNELS_QUERY_KEY,
    retry: false,
  });

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      teamHubData(
        client.api.PATCH("/v0/channels/{provider}", {
          params: { path: { provider: "wechat" } },
          body: { enabled },
        }),
      ),
    onMutate: () => setActionError(false),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY });
    },
    onError: () => setActionError(true),
  });

  const disconnectMutation = useMutation({
    mutationFn: () =>
      teamHubDone(
        client.api.DELETE("/v0/channels/{provider}", {
          params: { path: { provider: "wechat" } },
        }),
      ),
    onMutate: () => setActionError(false),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY });
    },
    onError: () => setActionError(true),
  });

  const data = channelsQuery.data;
  const wechatBinding = data?.bindings.find((b) => b.provider === "wechat");
  const wechatStatus = statusMeta(wechatBinding, t);
  const wechatError = bindingErrorHint(wechatBinding, t);
  const busy = toggleMutation.isPending || disconnectMutation.isPending;

  const wechatNotice =
    wechatError || actionError ? (
      <div className="space-y-2">
        {wechatError ? (
          <FormFeedback tone="danger">{wechatError}</FormFeedback>
        ) : null}
        {actionError ? (
          <FormFeedback tone="danger">
            {t(channelsMessages.actionFailed)}
          </FormFeedback>
        ) : null}
      </div>
    ) : undefined;

  return (
    <div className="mx-auto flex w-full max-w-(--app-settings-width) flex-col gap-6 pb-4">
      <SettingsPageHeading
        description={t(channelsMessages.description)}
        title={t(channelsMessages.title)}
      />

      {channelsQuery.isError ? (
        <FormFeedback tone="danger">
          {t(channelsMessages.loadFailed)}
        </FormFeedback>
      ) : null}

      {data && !data.available ? (
        <p className="rounded-2xl bg-card px-5 py-4 text-sm text-muted-foreground shadow-outline">
          {t(channelsMessages.unavailable)}
        </p>
      ) : null}

      <div className="flex flex-col gap-4">
        <ChannelCard
          channel="wechat"
          description={t(channelsMessages.wechatDescription)}
          enabled={Boolean(wechatBinding?.enabled)}
          expandLabel={t(channelsMessages.toggleWeChatSettings)}
          hasConfiguration={Boolean(wechatBinding)}
          notice={wechatNotice}
          onToggle={() => {
            if (!wechatBinding) {
              setPairingOpen(true);
              return;
            }
            toggleMutation.mutate(!wechatBinding.enabled);
          }}
          statusLabel={wechatStatus.label}
          statusTone={wechatStatus.tone}
          switchDisabled={
            wechatBinding ? busy : !data?.available || channelsQuery.isPending
          }
          switchLabel={t(channelsMessages.useWeChat)}
          title={t(channelsMessages.wechatName)}
        >
          {wechatBinding ? (
            <SettingsGroup label={t(channelsMessages.accountSection)}>
              <SettingsRow>
                <SettingsRowText
                  description={
                    wechatBinding.remote_user_id
                      ? t(channelsMessages.accountLabel, {
                          id: wechatBinding.remote_user_id,
                        })
                      : undefined
                  }
                  title={t(channelsMessages.wechatName)}
                />
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    disabled={!data?.available || busy}
                    onClick={() => setPairingOpen(true)}
                    size="compact"
                    tone="secondary"
                  >
                    {t(channelsMessages.reconnectWeChat)}
                  </Button>
                  <Button
                    data-voice-risk="never"
                    disabled={busy}
                    onClick={() => disconnectMutation.mutate()}
                    size="compact"
                    tone="ghost"
                  >
                    {disconnectMutation.isPending
                      ? t(channelsMessages.disconnecting)
                      : t(channelsMessages.disconnect)}
                  </Button>
                </div>
              </SettingsRow>
            </SettingsGroup>
          ) : null}
        </ChannelCard>

        <DesktopIMessageCard />
      </div>

      <section className="rounded-2xl border border-dashed border-border bg-background/50 px-5 py-4">
        <h2 className="text-sm font-medium text-foreground">
          {t(channelsMessages.upcomingTitle)}
        </h2>
        <p className="mt-1 text-xs leading-[18px] text-muted-foreground">
          {t(channelsMessages.upcomingDescription)}
        </p>
      </section>

      {pairingOpen ? (
        <WeChatPairingDialog
          onClose={() => setPairingOpen(false)}
          onConnected={() => {
            void queryClient.invalidateQueries({
              queryKey: CHANNELS_QUERY_KEY,
            });
          }}
        />
      ) : null}
    </div>
  );
}
