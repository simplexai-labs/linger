import { Cancel01Icon, LinkSquare02Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";

import { Button } from "@/components/ui/button";
import { fieldControlClassName } from "@/components/ui/field";
import { FormFeedback } from "@/components/ui/form-feedback";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { Select, SelectItem } from "@/components/ui/select";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubBrowserConnectionStatus } from "@/features/teamhub/teamhub-types";
import { commonMessages } from "@/i18n/common.messages";
import { RichMessage, useT } from "@/i18n/use-translation";

import { StatusDot } from "../computer-row";
import { computersMessages } from "../computers.messages";
import { localComputersQueryOptions } from "../local-computer-queries";
import {
  browserConnectionQueryKey,
  browserConnectionQueryOptions,
  configureBrowserConnection,
  disconnectBrowserConnection,
} from "./browser-connection-api";
import {
  browserConnectionErrorMessage,
  browserConnectionStateCopy,
  PLAYWRIGHT_EXTENSION_URL,
} from "./browser-connection-copy";

type PendingAction = "configure" | "disconnect" | null;

/**
 * Connects browser tools on one of the user's Local Computers to their own
 * Chrome. The pasted token lives only in this component's input state until
 * it is sent; it never enters a Message, Card, query cache, or storage.
 */
export function BrowserConnectionDialog({
  computerId: lockedComputerId,
  onClose,
  tenantId,
}: {
  /** Connects only this Computer, such as the one a chat card names. */
  computerId?: string;
  onClose: () => void;
  tenantId: string;
}) {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const inventory = useQuery(localComputersQueryOptions(client, tenantId));
  const computers = inventory.data?.items ?? [];
  const [requestedComputerId, setRequestedComputerId] =
    useState(lockedComputerId);
  // A locked Computer never falls back to another one.
  const computer = lockedComputerId
    ? computers.find(({ computer_id }) => computer_id === lockedComputerId)
    : (computers.find(
        ({ computer_id }) => computer_id === requestedComputerId,
      ) ??
      computers.find(({ status }) => status === "online") ??
      computers[0]);
  const online = computer?.status === "online";
  const status = useQuery({
    ...browserConnectionQueryOptions(
      client,
      tenantId,
      computer?.computer_id ?? "",
    ),
    enabled: Boolean(computer && online),
  });
  const [pastedToken, setPastedToken] = useState("");
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState<PendingAction>(null);
  // The error is kept, not its text, so the text follows the language.
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);

  function selectComputer(computerId: string) {
    setRequestedComputerId(computerId);
    setPastedToken("");
    setEditing(false);
    setFailure(null);
  }

  async function run(
    action: Exclude<PendingAction, null>,
    send: () => Promise<TeamHubBrowserConnectionStatus>,
  ) {
    if (!computer) return;
    const computerId = computer.computer_id;
    setPending(action);
    setFailure(null);
    try {
      const next = await send();
      queryClient.setQueryData(
        browserConnectionQueryKey(tenantId, computerId),
        next,
      );
      setEditing(false);
    } catch (error) {
      setFailure({ error });
    } finally {
      setPending(null);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!computer || pending || !pastedToken.trim()) return;
    const token = pastedToken;
    // Clear the field before the request so the token does not stay in state.
    setPastedToken("");
    void run("configure", () =>
      configureBrowserConnection(client, tenantId, computer.computer_id, token),
    );
  }

  function requestClose() {
    if (!pending) onClose();
  }

  const current = status.data;
  const unsupported = current?.state === "unsupported";
  // A damaged saved connection fails the status read; a new paste replaces it.
  const savedConnectionInvalid =
    status.error instanceof TeamHubError &&
    status.error.code === "BROWSER_CONNECTION_INVALID";
  const linked = online && !unsupported && isLinked(current);
  const showForm =
    online &&
    (status.isSuccess || savedConnectionInvalid) &&
    !unsupported &&
    (editing || !linked);
  const failureText = failure
    ? browserConnectionErrorMessage(failure.error, t)
    : null;

  return (
    <ModalDialog
      ariaLabel={t(computersMessages.connectChrome)}
      className="fixed inset-0 z-50 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[480px] overflow-auto rounded-xl border border-border bg-popover p-0 shadow-lg backdrop:bg-[var(--app-overlay)]"
      onClose={requestClose}
    >
      <div className="p-5">
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-lg">{t(computersMessages.connectChrome)}</h2>
            {computer ? (
              <p className="mt-1 text-sm text-muted-foreground">
                <RichMessage
                  message={computersMessages.connectChromeIntro}
                  tags={{
                    name: (text) => (
                      <span className="font-medium text-foreground">
                        {text}
                      </span>
                    ),
                  }}
                  values={{ computer: computer.display_name }}
                />
              </p>
            ) : null}
          </div>
          <Button
            data-voice-close
            aria-label={t(commonMessages.close)}
            disabled={pending !== null}
            onClick={requestClose}
            size="icon"
            tone="ghost"
          >
            <Icon icon={Cancel01Icon} size={16} />
          </Button>
        </header>

        <div className="mt-4 space-y-3">
          {inventory.isPending ? (
            <p className="text-sm text-muted-foreground" role="status">
              {t(computersMessages.loadingComputers)}
            </p>
          ) : inventory.isError ? (
            <FormFeedback tone="danger">
              {t(computersMessages.cannotLoadComputers)}
            </FormFeedback>
          ) : !computer ? (
            <FormFeedback tone="info">
              {lockedComputerId
                ? t(computersMessages.computerNoLongerConnected)
                : t(computersMessages.noLocalComputerYet)}
            </FormFeedback>
          ) : (
            <>
              {/* The subtitle already names the only Computer there is. */}
              {!lockedComputerId && computers.length > 1 ? (
                <Select
                  aria-label={t(computersMessages.computer)}
                  className="ui-field-control w-full text-sm"
                  disabled={pending !== null}
                  onValueChange={selectComputer}
                  value={computer.computer_id}
                >
                  {computers.map((item) => (
                    <SelectItem key={item.computer_id} value={item.computer_id}>
                      {item.status === "online"
                        ? item.display_name
                        : t(computersMessages.computerOfflineOption, {
                            computer: item.display_name,
                          })}
                    </SelectItem>
                  ))}
                </Select>
              ) : null}

              <BrowserConnectionNotice
                current={current}
                error={status.error}
                loading={online && status.isPending}
                online={online}
              />

              {linked && current && !editing ? (
                <LinkedBrowser
                  disconnecting={pending === "disconnect"}
                  disabled={pending !== null}
                  onDisconnect={() =>
                    void run("disconnect", () =>
                      disconnectBrowserConnection(
                        client,
                        tenantId,
                        computer.computer_id,
                      ),
                    )
                  }
                  onReplace={() => {
                    setFailure(null);
                    setEditing(true);
                  }}
                  status={current}
                />
              ) : null}

              {showForm ? (
                <form className="space-y-3" onSubmit={submit}>
                  <div>
                    <div className="ui-field-frame">
                      <input
                        aria-describedby={
                          failureText ? "browser-token-error" : undefined
                        }
                        aria-invalid={failureText ? true : undefined}
                        aria-label={t(computersMessages.extensionToken)}
                        autoCapitalize="off"
                        autoComplete="off"
                        autoCorrect="off"
                        className={fieldControlClassName}
                        data-1p-ignore=""
                        data-lpignore="true"
                        disabled={pending !== null}
                        name="playwright-extension-token"
                        onChange={(event) => {
                          setFailure(null);
                          setPastedToken(event.target.value);
                        }}
                        placeholder={t(
                          computersMessages.pasteTokenFromExtension,
                        )}
                        spellCheck={false}
                        type="password"
                        value={pastedToken}
                      />
                    </div>
                    {failureText ? (
                      <p
                        className="mt-1.5 text-xs text-destructive"
                        id="browser-token-error"
                        role="alert"
                      >
                        {failureText}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex gap-2">
                    {editing ? (
                      <Button
                        className="flex-1"
                        disabled={pending !== null}
                        onClick={() => {
                          setPastedToken("");
                          setFailure(null);
                          setEditing(false);
                        }}
                        size="large"
                      >
                        {t(commonMessages.cancel)}
                      </Button>
                    ) : null}
                    <Button
                      className="flex-1"
                      disabled={pending !== null || !pastedToken.trim()}
                      size="large"
                      tone="primary"
                      type="submit"
                    >
                      {pending === "configure"
                        ? t(computersMessages.connectingUpToMinute)
                        : t(computersMessages.connect)}
                    </Button>
                  </div>
                </form>
              ) : failureText ? (
                <FormFeedback tone="danger">{failureText}</FormFeedback>
              ) : null}
            </>
          )}
        </div>

        {showForm ? (
          <p className="mt-4 border-t border-border pt-3 text-sm text-muted-foreground">
            <RichMessage
              message={computersMessages.noExtensionYet}
              tags={{
                link: (text) => (
                  <a
                    className="inline-flex items-center gap-1 font-medium text-app-link underline-offset-2 hover:underline"
                    href={PLAYWRIGHT_EXTENSION_URL}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {text}
                    <Icon icon={LinkSquare02Icon} size={14} />
                  </a>
                ),
              }}
            />
          </p>
        ) : null}
      </div>
    </ModalDialog>
  );
}

/**
 * What stands in the way of a connection. A Computer that can simply be
 * connected shows nothing: the form below is the whole message.
 */
function BrowserConnectionNotice({
  current,
  error,
  loading,
  online,
}: {
  current: TeamHubBrowserConnectionStatus | undefined;
  error: unknown;
  loading: boolean;
  online: boolean;
}) {
  const t = useT();
  if (!online) {
    return (
      <FormFeedback tone="info">
        {t(computersMessages.browserComputerOffline)}
      </FormFeedback>
    );
  }
  if (loading) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        {t(computersMessages.checkingBrowserStatus)}
      </p>
    );
  }
  if (!current) {
    return (
      <FormFeedback tone="danger">
        {browserConnectionErrorMessage(error, t)}
      </FormFeedback>
    );
  }
  if (current.state === "unsupported") {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        {browserConnectionStateCopy(current.state, t).label}
      </p>
    );
  }
  return null;
}

/** A saved user Chrome connection, healthy or not, with its two actions. */
function LinkedBrowser({
  disabled,
  disconnecting,
  onDisconnect,
  onReplace,
  status,
}: {
  disabled: boolean;
  disconnecting: boolean;
  onDisconnect: () => void;
  onReplace: () => void;
  status: TeamHubBrowserConnectionStatus;
}) {
  const t = useT();
  const copy = browserConnectionStateCopy(status.state, t);
  const healthy = copy.tone === "success";
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 rounded-lg bg-muted py-1.5 pr-1.5 pl-3">
        <span
          className="flex items-center gap-2 text-sm text-foreground"
          role="status"
        >
          <StatusDot tone={copy.tone} />
          {copy.short}
        </span>
        <span className="flex gap-1">
          <Button
            disabled={disabled}
            onClick={onReplace}
            size="compact"
            tone="ghost"
          >
            {t(computersMessages.replaceToken)}
          </Button>
          <Button
            disabled={disabled}
            onClick={onDisconnect}
            size="compact"
            tone="ghost"
          >
            {disconnecting
              ? t(computersMessages.disconnecting)
              : t(computersMessages.disconnect)}
          </Button>
        </span>
      </div>
      {/* A healthy connection needs no explanation; a broken one says what to do. */}
      {healthy ? null : (
        <p className="text-sm text-muted-foreground">{copy.label}</p>
      )}
      {!healthy && status.message ? (
        <p className="text-sm text-muted-foreground">{status.message}</p>
      ) : null}
    </div>
  );
}

// A user Chrome connection exists, even when the Computer reports a problem.
function isLinked(status: TeamHubBrowserConnectionStatus | undefined) {
  return status?.mode === "user_chrome";
}
