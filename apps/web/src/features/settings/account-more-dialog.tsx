import {
  ArrowLeft01Icon,
  Attachment01Icon,
  BotIcon,
  Cancel01Icon,
  Copy01Icon,
  Link01Icon,
  Loading03Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { AppLogo } from "@/features/apps/app-logo";
import { writeClipboardText } from "@/lib/clipboard";
import { connectionAuthorizationError } from "@/features/apps/authorization-error";
import {
  activeExternalConnections,
  canResumePendingExternalConnection,
  connectLinkOpen,
  externalConnectionNeedsAttention,
  usableConnectUrl,
  accountIdentityText,
} from "@/features/apps/connection-state";
import {
  externalAppsQueryOptions,
  externalConnectionQueryOptions,
  externalConnectionsQueryKey,
  externalConnectionsQueryOptions,
} from "@/features/apps/connected-apps-queries";
import { openOAuthUrl } from "@/features/apps/oauth-popup";
import { ProviderSelectionPicker } from "./provider-selection-picker";
import {
  personalProfileGenerationsQueryKey,
  personalProfileQueryKey,
} from "./personal-profile-queries";
import { accountProfileQueryKey } from "./account-profile-queries";
import { type TeamHubClient } from "@/features/teamhub/teamhub-client";
import type {
  TeamHubExternalApp,
  TeamHubExternalAppKey,
  TeamHubExternalConnection,
  TeamHubPersonalProfileSourceSelection,
  TeamHubPersonalProfileGenerationSourceInput,
} from "@/features/teamhub/teamhub-types";
import { commonMessages } from "@/i18n/common.messages";
import { translate } from "@/i18n/language";
import type { Message } from "@/i18n/messages";
import { useT } from "@/i18n/use-translation";
import { accountSettingsMessages } from "./account-settings.messages";
import {
  PROFILE_FILE_ACCEPT,
  PROFILE_FILE_MAX_COUNT,
  uploadProfileInputFiles,
  type UploadedProfileFile,
} from "./profile-file-ingest";
import {
  profileSourcePolicy,
  profileSourceSubmitLabel,
  providerDisplayName,
} from "./profile-source-policy";

type SourcePane = "accounts" | "files" | "ai";

const SOURCE_PANES: {
  id: SourcePane;
  icon: ReactNode;
  label: Message<string>;
}[] = [
  {
    id: "accounts",
    icon: <Icon icon={Link01Icon} size={16} />,
    label: accountSettingsMessages.accounts,
  },
  {
    id: "files",
    icon: <Icon icon={Attachment01Icon} size={16} />,
    label: accountSettingsMessages.files,
  },
  {
    id: "ai",
    icon: <Icon icon={BotIcon} size={16} />,
    label: accountSettingsMessages.anotherAI,
  },
];

const SOURCE_PRIVACY_COPY: Record<SourcePane, Message<string>> = {
  accounts: accountSettingsMessages.privacyAccounts,
  ai: accountSettingsMessages.privacyAI,
  files: accountSettingsMessages.privacyFiles,
};

function collectManualSources({
  externalAISummary,
  pane,
  uploadedFiles,
}: {
  externalAISummary: string;
  pane: SourcePane;
  uploadedFiles: UploadedProfileFile[];
}):
  | { error: string }
  | { sources: TeamHubPersonalProfileGenerationSourceInput[] } {
  if (pane === "ai") {
    const summary = externalAISummary.trim();
    return summary
      ? { sources: [{ kind: "external_ai_summary", summary }] }
      : { error: translate(accountSettingsMessages.pasteSummaryFirst) };
  }
  if (uploadedFiles.length === 0) {
    return { error: translate(accountSettingsMessages.addFileFirst) };
  }
  return {
    sources: uploadedFiles.slice(0, PROFILE_FILE_MAX_COUNT).map((file) => ({
      kind: "input_version" as const,
      input_version_id: file.inputVersionId,
    })),
  };
}

function useExternalAISummary(onError: (message: string) => void) {
  const [summary, setSummary] = useState("");
  const [promptCopied, setPromptCopied] = useState(false);

  return {
    copyPrompt: () => {
      // The prompt is copied in the language it is shown in.
      void writeClipboardText(
        translate(accountSettingsMessages.externalAIPrompt),
      )
        .then(() => setPromptCopied(true))
        .catch(() =>
          onError(translate(accountSettingsMessages.copyUnavailable)),
        );
    },
    promptCopied,
    setSummary: (value: string) => {
      onError("");
      setSummary(value);
    },
    summary,
  };
}

interface AccountMoreDialogProps {
  client: TeamHubClient;
  onClose: () => void;
  /** Profile app key to start on open. */
  startWith?: string;
  tenantId: string;
}

export function AccountMoreDialog({
  client,
  onClose,
  startWith,
  tenantId,
}: AccountMoreDialogProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const apps = useQuery(externalAppsQueryOptions(client));
  const connections = useQuery(externalConnectionsQueryOptions(client));
  const [blockedConnectUrl, setBlockedConnectUrl] = useState("");
  const [flowConnectionId, setFlowConnectionId] = useState("");
  const [selectionConnection, setSelectionConnection] =
    useState<TeamHubExternalConnection | null>(null);
  const [selections, setSelections] = useState<
    TeamHubPersonalProfileSourceSelection[]
  >([]);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedProfileFile[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [pane, setPane] = useState<SourcePane>("accounts");
  const [error, setError] = useState("");
  const externalAI = useExternalAISummary(setError);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const automaticallyAddedConnectionId = useRef("");
  const startedWith = useRef(false);
  const createConnection = useMutation({
    mutationFn: (appKey: TeamHubExternalAppKey) =>
      client.createExternalConnection(appKey),
    onError: (connectError) => {
      setError(connectError.message);
    },
    onSuccess: async (connection) => {
      if (connection.connect_url && !openOAuthUrl(connection.connect_url)) {
        setBlockedConnectUrl(connection.connect_url);
      }
      setFlowConnectionId(connection.id);
      await queryClient.invalidateQueries({
        queryKey: externalConnectionsQueryKey(),
      });
    },
  });
  const generate = useMutation({
    mutationFn: (sources: TeamHubPersonalProfileGenerationSourceInput[]) =>
      client.createPersonalProfileGeneration(tenantId, { sources }),
    onError: (generateError: Error) => setError(generateError.message),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: personalProfileQueryKey(tenantId),
        }),
        queryClient.invalidateQueries({
          queryKey: accountProfileQueryKey(tenantId),
        }),
        queryClient.invalidateQueries({
          queryKey: personalProfileGenerationsQueryKey(tenantId),
        }),
        queryClient.invalidateQueries({
          queryKey: externalConnectionsQueryKey(),
        }),
      ]);
      onClose();
    },
  });

  const { mutate: generateSources } = generate;
  // TeamHub lists only Connections that are not revoked.
  const visibleConnections = connections.data?.connections ?? [];
  const flowConnection = visibleConnections.find(
    (connection) => connection.id === flowConnectionId,
  );
  const pendingAuthError = flowConnection
    ? connectionAuthorizationError(flowConnection)
    : undefined;
  const pickerConnection =
    flowConnection &&
    !pendingAuthError &&
    flowConnection.status === "active" &&
    profileSourcePolicy(flowConnection.provider).selection !== "fixed"
      ? flowConnection
      : selectionConnection;
  const displayError = pendingAuthError || error;

  useEffect(() => {
    if (!flowConnection || pendingAuthError) return;
    if (flowConnection.status !== "active") return;
    if (profileSourcePolicy(flowConnection.provider).selection !== "fixed") {
      return;
    }
    if (automaticallyAddedConnectionId.current === flowConnection.id) return;
    automaticallyAddedConnectionId.current = flowConnection.id;
    generateSources(connectionSources(flowConnection, []));
  }, [flowConnection, generateSources, pendingAuthError]);

  // Starting an app connects it only when its row would offer Add or Choose;
  // a pending or expired connection stays on its row's Continue or Open Apps.
  // Desktop loopback callbacks are single-use, so a stale pending connection
  // does not block starting a fresh authorization.
  useEffect(() => {
    if (!startWith || startedWith.current) return;
    if (!apps.data || !connections.data) return;
    startedWith.current = true;
    const app = apps.data.apps.find((item) => item.key === startWith);
    const own = connections.data.connections.filter(
      (connection) => connection.provider === startWith,
    );
    if (
      app?.availability !== "available" ||
      activeExternalConnections(own).length ||
      own.some(
        (connection) =>
          (connection.status === "pending" &&
            canResumePendingExternalConnection(connection.provider)) ||
          externalConnectionNeedsAttention(connection),
      )
    ) {
      return;
    }
    createConnection.mutate(app.key);
  }, [apps.data, connections.data, createConnection, startWith]);

  function generateManualSources() {
    const result = collectManualSources({
      externalAISummary: externalAI.summary,
      pane,
      uploadedFiles,
    });
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setError("");
    generate.mutate(result.sources);
  }

  const profileApps = (apps.data?.apps ?? []).filter(
    (app) =>
      app.capabilities.includes("personal_wiki_import") &&
      profileSourcePolicy(app.key).selection !== "unsupported",
  );
  const busy = createConnection.isPending || generate.isPending;

  return (
    <ModalDialog
      ariaLabel={t(accountSettingsMessages.addProfileSources)}
      className="overflow-hidden"
      onClose={onClose}
      size="lg"
    >
      <AccountMoreHeader onClose={onClose} />
      <div className="flex min-h-0 max-h-[min(520px,calc(100vh-12rem))] flex-col sm:flex-row">
        <AccountMorePaneNav pane={pane} onPaneChange={setPane} />
        <div className="workspace-scrollbar min-h-0 min-w-0 flex-1 overflow-y-auto p-5">
          {pane === "accounts" ? (
            <AccountMoreAccountsPane
              appsPending={apps.isPending || connections.isPending}
              busy={busy}
              client={client}
              pickerConnection={pickerConnection}
              profileApps={profileApps}
              selections={selections}
              tenantId={tenantId}
              waiting={flowConnection?.status === "pending"}
              visibleConnections={visibleConnections}
              onBackSelection={() => {
                setFlowConnectionId("");
                setSelectionConnection(null);
                setSelections([]);
              }}
              onConnect={(appKey) => {
                setError("");
                setBlockedConnectUrl("");
                createConnection.mutate(appKey);
              }}
              onContinueAuthorization={(connection, connectUrl) => {
                setFlowConnectionId(connection.id);
                setBlockedConnectUrl("");
                if (!openOAuthUrl(connectUrl)) {
                  setBlockedConnectUrl(connectUrl);
                }
              }}
              onGenerate={(connection, selected) => {
                setError("");
                setFlowConnectionId("");
                generate.mutate(connectionSources(connection, selected));
              }}
              onSelectionsChange={setSelections}
              onUse={(connection) => {
                setError("");
                setFlowConnectionId("");
                if (
                  profileSourcePolicy(connection.provider).selection !== "fixed"
                ) {
                  setSelectionConnection(connection);
                  setSelections([]);
                  return;
                }
                generate.mutate(connectionSources(connection, []));
              }}
            />
          ) : null}
          {pane === "files" ? (
            <AccountMoreFilesPane
              fileInputRef={fileInputRef}
              uploadedFiles={uploadedFiles}
              uploadingFiles={uploadingFiles}
              onChoose={() => fileInputRef.current?.click()}
              onRemove={(inputVersionId) =>
                setUploadedFiles((current) =>
                  current.filter(
                    (item) => item.inputVersionId !== inputVersionId,
                  ),
                )
              }
              onSelect={(selected) => {
                setError("");
                setUploadingFiles(true);
                void uploadProfileInputFiles(client, tenantId, selected)
                  .then((uploaded) => {
                    setUploadedFiles((current) => [...current, ...uploaded]);
                  })
                  .catch((uploadError: unknown) => {
                    setError(
                      uploadError instanceof Error
                        ? uploadError.message
                        : translate(accountSettingsMessages.fileUploadFailed),
                    );
                  })
                  .finally(() => setUploadingFiles(false));
              }}
            />
          ) : null}
          {pane === "ai" ? (
            <AccountMoreExternalAIPane
              promptCopied={externalAI.promptCopied}
              summary={externalAI.summary}
              onCopyPrompt={externalAI.copyPrompt}
              onSummaryChange={externalAI.setSummary}
            />
          ) : null}
        </div>
      </div>
      <AccountMoreFooter
        blockedConnectUrl={blockedConnectUrl}
        busy={busy}
        generatePending={generate.isPending}
        addDisabled={pane === "ai" && !externalAI.summary.trim()}
        privacyCopy={t(SOURCE_PRIVACY_COPY[pane])}
        showAddButton={pane !== "accounts" || uploadedFiles.length > 0}
        uploadingFiles={uploadingFiles}
        onAdd={() => void generateManualSources()}
        onClose={onClose}
        onContinueInBrowser={() => {
          if (!openOAuthUrl(blockedConnectUrl)) return;
          setBlockedConnectUrl("");
        }}
      />
      {displayError ? (
        <p className="px-5 py-3 text-sm text-app-danger" role="alert">
          {displayError}
        </p>
      ) : null}
    </ModalDialog>
  );
}

function AccountMoreHeader({ onClose }: { onClose: () => void }) {
  const t = useT();
  return (
    <div className="flex items-start justify-between gap-4 px-5 py-4">
      <h2 className="text-base font-semibold">
        {t(accountSettingsMessages.addToProfile)}
      </h2>
      <Button
        data-voice-close
        aria-label={t(commonMessages.close)}
        onClick={onClose}
        size="compactIcon"
        tone="ghost"
      >
        <Icon icon={Cancel01Icon} size={16} />
      </Button>
    </div>
  );
}

function AccountMorePaneNav({
  onPaneChange,
  pane,
}: {
  onPaneChange: (pane: SourcePane) => void;
  pane: SourcePane;
}) {
  const t = useT();
  return (
    <nav
      aria-label={t(accountSettingsMessages.profileSources)}
      className="grid shrink-0 grid-cols-2 gap-1 border-border bg-sidebar p-2 sm:flex sm:w-[168px] sm:flex-col sm:border-r"
    >
      {SOURCE_PANES.map((item) => (
        <button
          aria-current={pane === item.id ? "page" : undefined}
          className={`workspace-nav-row flex h-8 min-w-0 items-center gap-2 whitespace-nowrap rounded-full px-3 text-left text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            pane === item.id
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          }`}
          key={item.id}
          onClick={() => onPaneChange(item.id)}
          type="button"
        >
          {item.icon}
          {t(item.label)}
        </button>
      ))}
    </nav>
  );
}

function AccountMoreAccountsPane({
  appsPending,
  busy,
  client,
  onBackSelection,
  onConnect,
  onContinueAuthorization,
  onGenerate,
  onSelectionsChange,
  onUse,
  pickerConnection,
  profileApps,
  selections,
  tenantId,
  visibleConnections,
  waiting,
}: {
  appsPending: boolean;
  busy: boolean;
  client: TeamHubClient;
  onBackSelection: () => void;
  onConnect: (appKey: TeamHubExternalAppKey) => void;
  onContinueAuthorization: (
    connection: TeamHubExternalConnection,
    connectUrl: string,
  ) => void;
  onGenerate: (
    connection: TeamHubExternalConnection,
    selected: TeamHubPersonalProfileSourceSelection[],
  ) => void;
  onSelectionsChange: (
    selections: TeamHubPersonalProfileSourceSelection[],
  ) => void;
  onUse: (connection: TeamHubExternalConnection) => void;
  pickerConnection: TeamHubExternalConnection | null;
  profileApps: TeamHubExternalApp[];
  selections: TeamHubPersonalProfileSourceSelection[];
  tenantId: string;
  visibleConnections: TeamHubExternalConnection[];
  waiting: boolean;
}) {
  const t = useT();
  if (pickerConnection) {
    return (
      <AccountMoreSelectionStep
        busy={busy}
        client={client}
        connection={pickerConnection}
        selections={selections}
        onBack={onBackSelection}
        onGenerate={onGenerate}
        onSelectionsChange={onSelectionsChange}
      />
    );
  }

  return (
    <section>
      <ColumnHeading
        icon={<Icon icon={Link01Icon} size={14} />}
        title={t(accountSettingsMessages.accounts)}
      />
      <div className="mt-3">
        {appsPending ? (
          <p className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
            <Spinner size={15} />
            {t(accountSettingsMessages.loadingAccounts)}
          </p>
        ) : profileApps.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">
            {t(accountSettingsMessages.profileAppsUnavailable)}
          </p>
        ) : (
          profileApps.map((app) => (
            <AppConnectRow
              app={app}
              busy={busy}
              client={client}
              connections={visibleConnections.filter(
                (connection) => connection.provider === app.key,
              )}
              key={app.key}
              onConnect={() => onConnect(app.key)}
              onContinueAuthorization={onContinueAuthorization}
              onUse={onUse}
              tenantId={tenantId}
            />
          ))
        )}
      </div>
      {waiting ? (
        <p
          className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"
          role="status"
        >
          <Icon icon={Loading03Icon} className="animate-spin" size={14} />
          <span className="town-shimmer-text">
            {t(accountSettingsMessages.waitingForAuthorization)}
          </span>
        </p>
      ) : null}
    </section>
  );
}

function AccountMoreSelectionStep({
  onBack,
  busy,
  client,
  connection,
  onGenerate,
  onSelectionsChange,
  selections,
}: {
  busy: boolean;
  client: TeamHubClient;
  connection: TeamHubExternalConnection;
  onBack: () => void;
  onGenerate: (
    connection: TeamHubExternalConnection,
    selected: TeamHubPersonalProfileSourceSelection[],
  ) => void;
  onSelectionsChange: (
    selections: TeamHubPersonalProfileSourceSelection[],
  ) => void;
  selections: TeamHubPersonalProfileSourceSelection[];
}) {
  const t = useT();
  const policy = profileSourcePolicy(connection.provider);
  const submitLabel = profileSourceSubmitLabel(
    connection.provider,
    selections.length,
    t,
  );
  return (
    <section>
      <Button
        aria-label={t(accountSettingsMessages.backToAccounts)}
        className="mb-4"
        onClick={onBack}
        size="compact"
        tone="ghost"
      >
        <Icon icon={ArrowLeft01Icon} size={14} />
        {t(accountSettingsMessages.accounts)}
      </Button>
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-foreground">
          {t(accountSettingsMessages.chooseProviderContent, {
            provider: providerDisplayName(connection.provider),
          })}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {accountIdentityText(
            connection.provider,
            connection.identity_label,
          ) ?? t(accountSettingsMessages.connectedAccount)}
        </p>
      </div>
      <ProviderSelectionPicker
        client={client}
        connectionId={connection.id}
        onChange={onSelectionsChange}
        provider={
          connection.provider as
            | "discord"
            | "github"
            | "google_calendar"
            | "notion"
            | "slack"
        }
        selections={selections}
      />
      <Button
        className="mt-4"
        disabled={
          busy || (policy.selection === "required" && selections.length === 0)
        }
        onClick={() => onGenerate(connection, selections)}
        size="compact"
        tone="primary"
      >
        {submitLabel}
      </Button>
    </section>
  );
}

function AccountMoreFilesPane({
  fileInputRef,
  onChoose,
  onRemove,
  onSelect,
  uploadedFiles,
  uploadingFiles,
}: {
  fileInputRef: RefObject<HTMLInputElement | null>;
  onChoose: () => void;
  onRemove: (inputVersionId: string) => void;
  onSelect: (files: File[]) => void;
  uploadedFiles: UploadedProfileFile[];
  uploadingFiles: boolean;
}) {
  const t = useT();
  return (
    <section>
      <ColumnHeading
        icon={<Icon icon={Attachment01Icon} size={14} />}
        title={t(accountSettingsMessages.files)}
      />
      <p className="mt-2 text-xs leading-5 text-muted-foreground">
        {t(accountSettingsMessages.filesHint)}
      </p>
      <input
        accept={PROFILE_FILE_ACCEPT}
        aria-label={t(accountSettingsMessages.profileFiles)}
        className="hidden"
        multiple
        onChange={(event) => {
          const selected = Array.from(event.target.files ?? []).slice(
            0,
            PROFILE_FILE_MAX_COUNT - uploadedFiles.length,
          );
          event.target.value = "";
          onSelect(selected);
        }}
        ref={fileInputRef}
        type="file"
      />
      <Button
        className="mt-3"
        disabled={
          uploadingFiles || uploadedFiles.length >= PROFILE_FILE_MAX_COUNT
        }
        onClick={onChoose}
        size="compact"
      >
        {uploadingFiles ? (
          <Icon icon={Loading03Icon} className="animate-spin" size={14} />
        ) : null}
        {t(accountSettingsMessages.chooseFiles)}
      </Button>
      <ul className="mt-3 space-y-1.5">
        {uploadedFiles.map((file) => (
          <li
            className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm"
            key={file.inputVersionId}
          >
            <span className="truncate">{file.name}</span>
            <Button
              data-voice-risk="never"
              aria-label={t(accountSettingsMessages.removeFile, {
                name: file.name,
              })}
              onClick={() => onRemove(file.inputVersionId)}
              size="compactIcon"
              tone="ghost"
            >
              <Icon icon={Cancel01Icon} size={14} />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AccountMoreExternalAIPane({
  onCopyPrompt,
  onSummaryChange,
  promptCopied,
  summary,
}: {
  onCopyPrompt: () => void;
  onSummaryChange: (value: string) => void;
  promptCopied: boolean;
  summary: string;
}) {
  const t = useT();
  const copyLabel = t(
    promptCopied
      ? accountSettingsMessages.promptCopied
      : accountSettingsMessages.copyPrompt,
  );
  return (
    <section>
      <ColumnHeading
        icon={<Icon icon={BotIcon} size={14} />}
        title={t(accountSettingsMessages.anotherAI)}
      />
      <div className="mt-3">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span
            className="text-sm font-medium text-foreground"
            id="external-ai-prompt-label"
          >
            {t(accountSettingsMessages.promptToUse)}
          </span>
          <Button
            aria-label={copyLabel}
            onClick={onCopyPrompt}
            size="compactIcon"
            title={copyLabel}
            tone="ghost"
          >
            {promptCopied ? (
              <Icon icon={Tick02Icon} size={14} />
            ) : (
              <Icon icon={Copy01Icon} size={14} />
            )}
          </Button>
        </div>
        {/* Read only and copied whole, so it shows as text that grows with
            its lines rather than a field that scrolls inside. */}
        <p
          aria-labelledby="external-ai-prompt-label"
          className="ui-field-control w-full bg-app-surface-soft py-2 text-sm whitespace-pre-wrap text-foreground select-text"
          id="external-ai-prompt"
        >
          {t(accountSettingsMessages.externalAIPrompt)}
        </p>
      </div>
      <label className="mt-4 block">
        <span className="mb-1.5 block text-sm font-medium text-foreground">
          {t(accountSettingsMessages.aiSummary)}
        </span>
        <textarea
          className="ui-field-control min-h-32 w-full resize-y py-2"
          maxLength={65_536}
          onChange={(event) => onSummaryChange(event.target.value)}
          placeholder={t(accountSettingsMessages.aiSummaryPlaceholder)}
          value={summary}
        />
      </label>
    </section>
  );
}

function AccountMoreFooter({
  addDisabled,
  blockedConnectUrl,
  busy,
  generatePending,
  onAdd,
  onClose,
  onContinueInBrowser,
  privacyCopy,
  showAddButton,
  uploadingFiles,
}: {
  addDisabled: boolean;
  blockedConnectUrl: string;
  busy: boolean;
  generatePending: boolean;
  onAdd: () => void;
  onClose: () => void;
  onContinueInBrowser: () => void;
  privacyCopy: string;
  showAddButton: boolean;
  uploadingFiles: boolean;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-3 px-5 py-4">
      <p className="text-xs text-muted-foreground">{privacyCopy}</p>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {blockedConnectUrl ? (
          <Button onClick={onContinueInBrowser} size="compact" tone="primary">
            {t(accountSettingsMessages.continueInBrowser)}
          </Button>
        ) : null}
        <Button disabled={busy} onClick={onClose} size="compact">
          {t(commonMessages.cancel)}
        </Button>
        {showAddButton ? (
          <Button
            disabled={busy || uploadingFiles || addDisabled}
            onClick={onAdd}
            size="compact"
            tone="primary"
          >
            {generatePending ? (
              <Icon icon={Loading03Icon} className="animate-spin" size={14} />
            ) : null}
            {t(accountSettingsMessages.add)}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function AppConnectRow({
  app,
  busy,
  client,
  connections,
  onConnect,
  onContinueAuthorization,
  onUse,
  tenantId,
}: {
  app: TeamHubExternalApp;
  busy: boolean;
  client: TeamHubClient;
  connections: TeamHubExternalConnection[];
  onConnect: () => void;
  onContinueAuthorization: (
    connection: TeamHubExternalConnection,
    connectUrl: string,
  ) => void;
  onUse: (connection: TeamHubExternalConnection) => void;
  tenantId: string;
}) {
  const t = useT();
  const active = activeExternalConnections(connections);
  const needsAttention = connections.some(externalConnectionNeedsAttention);
  // A pending authorization whose Connect Link expired is over; connect again.
  // Desktop loopback callbacks are single-use, so never resume an older link.
  const pendingConnection = canResumePendingExternalConnection(app.key)
    ? connections.find(
        (connection) =>
          connection.status === "pending" && connectLinkOpen(connection),
      )
    : undefined;
  const authorizationPending = Boolean(pendingConnection);
  const pendingDetail = useQuery({
    ...externalConnectionQueryOptions(client, pendingConnection?.id ?? ""),
    enabled: Boolean(pendingConnection),
  });
  const pendingConnectUrl = usableConnectUrl(pendingDetail.data);
  const unavailable = app.availability !== "available";
  const configurable = profileSourcePolicy(app.key).selection !== "fixed";
  const singleActive = active.length === 1 ? active[0] : undefined;
  const actionLabel = t(
    configurable
      ? accountSettingsMessages.chooseApp
      : accountSettingsMessages.addApp,
    { app: app.display_name },
  );
  const actionText = t(
    configurable ? accountSettingsMessages.choose : accountSettingsMessages.add,
  );
  return (
    <div className="py-2">
      <div className="flex min-h-10 items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center">
          <AppLogo name={app.display_name} url={app.logo_url} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{app.display_name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {singleActive
              ? t(accountSettingsMessages.connectedAs, {
                  account:
                    accountIdentityText(
                      singleActive.provider,
                      singleActive.identity_label,
                    ) ?? t(accountSettingsMessages.unnamedAccount),
                })
              : active.length
                ? t(accountSettingsMessages.connectedAccountsCount, {
                    count: active.length,
                  })
                : t(
                    unavailable
                      ? accountSettingsMessages.unavailable
                      : needsAttention
                        ? accountSettingsMessages.connectionNeedsAttention
                        : authorizationPending
                          ? accountSettingsMessages.authorizationInProgress
                          : accountSettingsMessages.notConnected,
                  )}
          </p>
        </div>
        {singleActive ? (
          <Button
            aria-label={actionLabel}
            disabled={busy}
            onClick={() => onUse(singleActive)}
            size="compact"
          >
            {actionText}
          </Button>
        ) : active.length === 0 && pendingConnection ? (
          pendingConnectUrl ? (
            <Button
              aria-label={t(accountSettingsMessages.continueAppAuthorization, {
                app: app.display_name,
              })}
              disabled={busy}
              onClick={() =>
                onContinueAuthorization(pendingConnection, pendingConnectUrl)
              }
              size="compact"
            >
              {t(accountSettingsMessages.continue)}
            </Button>
          ) : (
            <Link
              className="text-xs font-medium text-app-link hover:underline"
              to={`/t/${tenantId}/apps?app=${app.key}`}
            >
              {t(accountSettingsMessages.openApps)}
            </Link>
          )
        ) : active.length === 0 && needsAttention ? (
          <Link
            className="text-xs font-medium text-app-link hover:underline"
            to={`/t/${tenantId}/apps?app=${app.key}`}
          >
            {t(accountSettingsMessages.openApps)}
          </Link>
        ) : active.length === 0 ? (
          <Button
            aria-label={actionLabel}
            disabled={busy || unavailable}
            onClick={onConnect}
            size="compact"
          >
            {actionText}
          </Button>
        ) : null}
      </div>
      {active.length > 1 ? (
        <div className="mt-1 ml-12">
          {active.map((connection) => {
            const identity =
              accountIdentityText(
                connection.provider,
                connection.identity_label,
              ) ?? t(accountSettingsMessages.connectedAccount);
            return (
              <div className="py-1.5" key={connection.id}>
                <div className="flex min-h-10 items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-xs text-muted-foreground">
                    {identity}
                  </span>
                  <Button
                    aria-label={t(
                      configurable
                        ? accountSettingsMessages.chooseAppFromAccount
                        : accountSettingsMessages.addAppFromAccount,
                      { app: app.display_name, account: identity },
                    )}
                    disabled={busy}
                    onClick={() => onUse(connection)}
                    size="compact"
                  >
                    {actionText}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
      {active.length && needsAttention ? (
        // An account that needs reconnecting stays visible beside an active one.
        <div className="mt-1 ml-12">
          {connections
            .filter(externalConnectionNeedsAttention)
            .map((connection) => (
              <div
                className="flex min-h-10 items-center justify-between gap-3 py-1.5"
                key={connection.id}
              >
                <span className="min-w-0 truncate text-xs text-muted-foreground">
                  {t(accountSettingsMessages.needsAttentionAccount, {
                    account:
                      accountIdentityText(
                        connection.provider,
                        connection.identity_label,
                      ) ?? t(accountSettingsMessages.unnamedAccount),
                  })}
                </span>
                <Link
                  className="text-xs font-medium text-app-link hover:underline"
                  to={`/t/${tenantId}/apps?app=${app.key}`}
                >
                  {t(accountSettingsMessages.openApps)}
                </Link>
              </div>
            ))}
        </div>
      ) : null}
    </div>
  );
}

function ColumnHeading({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <h3 className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.06em] text-muted-foreground">
      {icon}
      {title}
    </h3>
  );
}

function connectionSources(
  connection: TeamHubExternalConnection,
  selected: TeamHubPersonalProfileSourceSelection[],
): TeamHubPersonalProfileGenerationSourceInput[] {
  return [
    {
      kind: "connection",
      connection_id: connection.id,
      ...(selected.length ? { selections: selected } : {}),
    },
  ];
}
