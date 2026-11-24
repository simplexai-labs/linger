import {
  Activity01Icon,
  Add01Icon,
  AiChipIcon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  Delete02Icon,
  Folder01Icon,
  InformationCircleIcon,
  Key01Icon,
  LaptopIcon,
  Link01Icon,
  PlayIcon,
  PowerIcon,
  RefreshIcon,
  Search01Icon,
  StopIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { type ReactNode, useState } from "react";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";
import { Icon, type IconSvgElement } from "@/components/ui/icon";
import { ModalDialog } from "@/components/ui/modal-dialog";
import type {
  TeamHubLocalComputerPage,
  TeamHubLocalRuntimeType,
  TeamHubTenantAgent,
} from "@/features/teamhub/teamhub-types";
import { commonMessages } from "@/i18n/common.messages";
import type { Translate } from "@/i18n/language";
import type { Message } from "@/i18n/messages";
import { useT, useTranslation } from "@/i18n/use-translation";
import { cn } from "@/lib/cn";

import {
  agentStatusSummary,
  type AgentAvailability,
} from "./agent-availability";
import { AgentChips } from "./computer-agent-chips";
import { appIcons } from "./computer-app-icons";
import { AppSetupDialog, CommandLine } from "./computer-app-setup-dialog";
import {
  useComputerConnectionStatus,
  type ComputerDisplayStatus,
} from "./computer-connection-status";
import { Hint, HintCard } from "./computer-hint";
import {
  computerCommand,
  computerInstallCommand,
  ComputerPlatformSelector,
  type ComputerPlatform,
} from "./computer-platform";
import {
  appDescriptions,
  appNames,
  appOrder,
  computerReadiness,
  preferredComputerRuntime,
  type ComputerReadiness,
} from "./computer-readiness";
import { relativeTime } from "./computer-relative-time";
import { ComputerRow, ProgressChip, RowMark, StatusDot } from "./computer-row";
import { computersMessages } from "./computers.messages";
import { isUpgradeRecommended } from "./computer-version";
import { useDesktopComputer } from "./desktop-computer";
import { DesktopPreventSleep } from "./desktop-prevent-sleep";
import { localRuntimeMessage } from "./local-runtime-message";

type LocalComputer = TeamHubLocalComputerPage["items"][number];
interface AppSetup {
  app: TeamHubLocalRuntimeType;
  choosable: boolean;
}

export function ComputerDetail({
  activeRuntime,
  agentAvailabilities,
  agents,
  browserConnection,
  cliInstallAvailable = true,
  computer: latestComputer,
  localModelsHref,
  onConnect,
  onOpenAgent,
  onRemove,
}: {
  /** Active runtime from the Computer's current model source when known. */
  activeRuntime?: TeamHubLocalRuntimeType;
  agentAvailabilities: ReadonlyMap<string, AgentAvailability>;
  agents: TeamHubTenantAgent[];
  /** The browser status as a progress chip or an Access row; the page owns its TeamHub reads. */
  browserConnection?: (variant: "chip" | "row") => ReactNode;
  /** Whether the active server ships the standalone CLI daemon (`linger-computer`). */
  cliInstallAvailable?: boolean;
  computer: LocalComputer;
  /** Where this Computer's Local models page is; the page owns the route. */
  localModelsHref?: string;
  onConnect?: () => void;
  onOpenAgent: (actorId: string) => void;
  onRemove?: () => void;
}) {
  const t = useT();
  const [reportedComputer, setReportedComputer] = useState(latestComputer);
  if (
    reportedComputer.computer_id !== latestComputer.computer_id ||
    (latestComputer.status === "online" && reportedComputer !== latestComputer)
  ) {
    setReportedComputer(latestComputer);
  }
  // An offline Computer keeps showing what it last reported.
  const computer =
    latestComputer.status === "offline" &&
    reportedComputer.computer_id === latestComputer.computer_id
      ? {
          ...latestComputer,
          daemon_version: reportedComputer.daemon_version,
          platform: latestComputer.platform ?? reportedComputer.platform,
          recommended_version:
            latestComputer.recommended_version ??
            reportedComputer.recommended_version,
          runtimes: reportedComputer.runtimes,
        }
      : latestComputer;
  const displayStatus = useComputerConnectionStatus(
    computer.computer_id,
    computer.status,
  );
  const preferredRuntime = preferredComputerRuntime(agents, activeRuntime);
  const readiness = computerReadiness(
    computer,
    displayStatus,
    preferredRuntime,
  );
  const [setup, setSetup] = useState<AppSetup | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);
  const desktopComputer = useDesktopComputer();
  const isThisComputer =
    desktopComputer?.status?.computerId === computer.computer_id;
  const online = displayStatus === "online";
  const openSetup = (app: TeamHubLocalRuntimeType, choosable = false) =>
    setSetup({ app, choosable });

  return (
    <div
      aria-label={t(computersMessages.detailsLabel, {
        computer: computer.display_name,
      })}
      className="w-full"
      role="region"
    >
      <ComputerSummary
        browserChip={browserConnection?.("chip")}
        cliInstallAvailable={cliInstallAvailable}
        computer={computer}
        displayStatus={displayStatus}
        onConnect={onConnect}
        onSetUp={openSetup}
        onUpdate={cliInstallAvailable ? () => setUpdateOpen(true) : undefined}
        readiness={readiness}
      />
      <Group
        count={agents.length}
        summary={agentStatusSummary(agentAvailabilities, agents, t)}
        title={t(computersMessages.agents)}
      >
        <AgentChips
          agentAvailabilities={agentAvailabilities}
          agents={agents}
          onOpenAgent={onOpenAgent}
        />
      </Group>
      <Group
        hint={t(computersMessages.aiAppsHint)}
        title={t(computersMessages.aiApps)}
      >
        {appOrder.map((app) => (
          <AppRow
            app={app}
            cliInstallAvailable={cliInstallAvailable}
            computer={computer}
            key={app}
            onSetUp={() => openSetup(app)}
            online={online}
          />
        ))}
      </Group>
      {localModelsHref ? (
        <Group title={t(computersMessages.localModels)}>
          <Link
            className="flex min-h-14 w-full items-center gap-3 rounded-lg py-2 pr-2.5 pl-2 transition-colors duration-150 hover:bg-sidebar-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none"
            to={localModelsHref}
          >
            <RowMark>
              <Icon icon={AiChipIcon} size={20} />
            </RowMark>
            <span className="min-w-0 flex-1 text-left">
              <span className="block truncate text-sm text-foreground">
                {t(computersMessages.manageLocalModels)}
              </span>
              <span className="block truncate text-sm text-muted-foreground">
                {t(computersMessages.manageLocalModelsHint)}
              </span>
            </span>
            <Icon
              className="text-muted-foreground/60"
              icon={ArrowRight01Icon}
              size={16}
            />
          </Link>
        </Group>
      ) : null}
      {isThisComputer ? (
        <DesktopPreventSleep
          renderGroup={(content) => (
            <Group title={t(computersMessages.power)}>{content}</Group>
          )}
        />
      ) : null}
      {displayStatus === "offline" ? null : (
        <Group defaultOpen={false} title={t(computersMessages.access)}>
          {browserConnection?.("row")}
          <WorkspaceRows computer={computer} />
        </Group>
      )}
      <Group
        defaultOpen={false}
        title={t(computersMessages.advanced)}
        trailing={
          cliInstallAvailable &&
          isUpgradeRecommended(computer) &&
          !computer.upgrade_required ? (
            <span className="rounded-md bg-[var(--app-status-warning-surface)] px-1.5 text-xs text-app-warning">
              {t(computersMessages.update)}
            </span>
          ) : null
        }
      >
        <AdvancedRows
          cliInstallAvailable={cliInstallAvailable}
          computer={computer}
          onRemove={onRemove}
          onUpdate={cliInstallAvailable ? () => setUpdateOpen(true) : undefined}
        />
      </Group>
      {setup ? (
        <AppSetupDialog
          app={setup.app}
          choosable={setup.choosable}
          computer={computer}
          key={`${setup.app}-${setup.choosable}`}
          onClose={() => setSetup(null)}
        />
      ) : null}
      {cliInstallAvailable && updateOpen ? (
        <ModalDialog
          footer={
            <Button data-voice-close onClick={() => setUpdateOpen(false)}>
              {t(commonMessages.close)}
            </Button>
          }
          onClose={() => setUpdateOpen(false)}
          size="md"
          title={
            computer.upgrade_required
              ? t(computersMessages.updateRequired)
              : computer.recommended_version
                ? t(computersMessages.updateTo, {
                    version: computer.recommended_version,
                  })
                : t(computersMessages.updateLingerComputer)
          }
        >
          <div className="px-5 py-4 text-sm text-muted-foreground">
            <p>
              {t(computersMessages.updateInstructions, {
                computer: computer.display_name,
              })}
            </p>
            <UpgradeCommand
              key={computer.computer_id}
              platform={computer.platform}
            />
          </div>
        </ModalDialog>
      ) : null}
    </div>
  );
}

function ComputerSummary({
  browserChip,
  cliInstallAvailable,
  computer,
  displayStatus,
  onConnect,
  onSetUp,
  onUpdate,
  readiness,
}: {
  browserChip?: ReactNode;
  cliInstallAvailable: boolean;
  computer: LocalComputer;
  displayStatus: ComputerDisplayStatus;
  onConnect?: () => void;
  onSetUp: (app: TeamHubLocalRuntimeType, choosable?: boolean) => void;
  onUpdate?: () => void;
  readiness: ComputerReadiness;
}) {
  const t = useT();
  const action =
    readiness.kind === "update" ? (
      onUpdate ? (
        <Button onClick={onUpdate} tone="primary">
          {t(computersMessages.update)}
        </Button>
      ) : null
    ) : readiness.kind === "signIn" ? (
      <Button onClick={() => onSetUp(readiness.app)} tone="primary">
        {t(computersMessages.signInToApp, { app: appNames[readiness.app] })}
      </Button>
    ) : readiness.kind === "updateApp" ? (
      <Button onClick={() => onSetUp(readiness.app)} tone="primary">
        {t(computersMessages.updateApp, { app: appNames[readiness.app] })}
      </Button>
    ) : readiness.kind === "check" ? (
      <RuntimeCheckCard
        align="end"
        app={readiness.app}
        cliInstallAvailable={cliInstallAvailable}
        computer={computer}
      >
        <Button tone="primary">{t(computersMessages.checkAgain)}</Button>
      </RuntimeCheckCard>
    ) : readiness.kind === "setUp" ? (
      <Button onClick={() => onSetUp(readiness.app, true)} tone="primary">
        {t(computersMessages.setUpApp, { app: appNames[readiness.app] })}
      </Button>
    ) : null;

  return (
    <section className="rounded-xl px-4 py-3.5 shadow-outline">
      <div className="flex items-center gap-3.5">
        <Hint
          focusable
          placement="bottom"
          text={[
            platformLabel(computer.platform),
            computer.daemon_version
              ? t(computersMessages.appVersion, {
                  version: computer.daemon_version,
                })
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        >
          <span className="flex size-12 shrink-0 items-center justify-center rounded-[20%] bg-muted text-foreground">
            <Icon icon={LaptopIcon} size={24} />
          </span>
        </Hint>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base">{computer.display_name}</h2>
          <p
            className="flex items-center gap-1.5 text-sm text-muted-foreground"
            role="status"
          >
            <SummaryStatus computer={computer} readiness={readiness} />
          </p>
        </div>
        {action}
      </div>
      {readiness.kind === "offline" ? (
        <OfflineSteps
          cliInstallAvailable={cliInstallAvailable}
          computer={computer}
          onConnect={onConnect}
        />
      ) : (
        <div
          className={cn(
            "mt-3.5 ml-[62px] flex flex-wrap items-center gap-y-2",
            displayStatus === "reconnecting" && "opacity-50",
          )}
        >
          {computer.upgrade_required ? (
            <ProgressChip
              hint={t(computersMessages.lingerTooOld)}
              icon={LaptopIcon}
              attentionIcon={RefreshIcon}
              label={t(computersMessages.update)}
              onClick={onUpdate}
              state="attention"
            />
          ) : (
            <ProgressChip
              hint={t(computersMessages.lingerRunning)}
              icon={LaptopIcon}
              label={t(computersMessages.connected)}
              state="done"
            />
          )}
          <span aria-hidden className="w-6 border-t border-border-hover" />
          {readiness.kind === "ready" ? (
            <ProgressChip
              hint={t(computersMessages.agentsUseApp, {
                app: appNames[readiness.app],
              })}
              icon={appIcons[readiness.app]}
              label={appNames[readiness.app]}
              state="done"
            />
          ) : readiness.kind === "signIn" ? (
            <ProgressChip
              hint={t(computersMessages.appSignedOut, {
                app: appNames[readiness.app],
              })}
              icon={appIcons[readiness.app]}
              attentionIcon={Key01Icon}
              label={t(computersMessages.signIn)}
              onClick={() => onSetUp(readiness.app)}
              state="attention"
            />
          ) : readiness.kind === "updateApp" ? (
            <ProgressChip
              attentionIcon={RefreshIcon}
              hint={t(computersMessages.appTooOld, {
                app: appNames[readiness.app],
              })}
              icon={appIcons[readiness.app]}
              label={t(computersMessages.update)}
              onClick={() => onSetUp(readiness.app)}
              state="attention"
            />
          ) : readiness.kind === "check" ? (
            <ProgressChip
              attentionIcon={Search01Icon}
              hint={runtimeMessage(computer, readiness.app, t)}
              icon={appIcons[readiness.app]}
              label={appNames[readiness.app]}
              state="attention"
            />
          ) : (
            <ProgressChip
              attentionIcon={Add01Icon}
              hint={t(computersMessages.needAiApp)}
              icon={appIcons.claude}
              label={appNames.claude}
              onClick={() => onSetUp("claude", true)}
              state="attention"
            />
          )}
          <span
            aria-hidden
            className={cn(
              "w-6 border-t border-border-hover",
              readiness.kind !== "ready" && "border-dashed",
            )}
          />
          {browserChip}
        </div>
      )}
    </section>
  );
}

function SummaryStatus({
  computer,
  readiness,
}: {
  computer: LocalComputer;
  readiness: ComputerReadiness;
}) {
  const translation = useTranslation();
  const { t } = translation;
  if (readiness.kind === "reconnecting")
    return (
      <span className="town-shimmer-text">
        {t(computersMessages.reconnecting)}
      </span>
    );
  if (readiness.kind === "offline")
    return (
      <>
        <StatusDot tone="neutral" />
        {computer.last_seen_at
          ? t(computersMessages.offlineSince, {
              time: relativeTime(computer.last_seen_at, translation),
            })
          : t(computersMessages.offline)}
      </>
    );
  if (readiness.kind === "update")
    return (
      <>
        <StatusDot tone="warning" />
        {t(computersMessages.updateRequired)}
      </>
    );
  if (readiness.kind === "check")
    return (
      <>
        <StatusDot tone="warning" />
        {t(computersMessages.couldNotCheckApp, {
          app: appNames[readiness.app],
        })}
      </>
    );
  if (readiness.kind === "ready")
    return (
      <>
        <StatusDot tone="success" />
        {computer.active_operations
          ? t(computersMessages.readyRunning, {
              count: computer.active_operations,
            })
          : t(computersMessages.ready)}
      </>
    );
  return (
    <>
      <StatusDot tone="warning" />
      {t(computersMessages.oneStepLeft)}
    </>
  );
}

function OfflineSteps({
  cliInstallAvailable,
  computer,
  onConnect,
}: {
  cliInstallAvailable: boolean;
  computer: LocalComputer;
  onConnect?: () => void;
}) {
  const t = useT();
  const step =
    "inline-flex h-8 items-center gap-2 rounded-full bg-card pr-3 pl-1.5 text-xs text-secondary-foreground shadow-outline";
  const bubble =
    "flex size-[22px] items-center justify-center rounded-full bg-muted";
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2.5 rounded-xl bg-muted px-3.5 py-3">
      <Hint focusable placement="bottom" text={t(computersMessages.turnOnHint)}>
        <span className={step}>
          <span className={bubble}>
            <Icon icon={PowerIcon} size={12} />
          </span>
          {t(computersMessages.turnOn)}
        </span>
      </Hint>
      {cliInstallAvailable ? (
        <>
          <Icon
            className="text-muted-foreground/60"
            icon={ArrowRight01Icon}
            size={14}
          />
          <HintCard
            focusable
            content={
              <>
                <span className="block text-sm font-medium text-foreground">
                  {t(computersMessages.stillOffline)}
                </span>
                {t(computersMessages.runInTerminalOn, {
                  computer: computer.display_name,
                })}
                <CommandLine command={`${computerCommand()} daemon start`} />
              </>
            }
          >
            <span className={step}>
              <span className={bubble}>
                <Icon icon={PlayIcon} size={12} />
              </span>
              {t(computersMessages.startApp)}
            </span>
          </HintCard>
        </>
      ) : null}
      {onConnect ? (
        <>
          <Icon
            className="text-muted-foreground/60"
            icon={ArrowRight01Icon}
            size={14}
          />
          <Hint placement="bottom" text={t(computersMessages.reconnectHint)}>
            <button className={step} onClick={onConnect} type="button">
              <span className={bubble}>
                <Icon icon={Link01Icon} size={12} />
              </span>
              {t(computersMessages.reconnect)}
            </button>
          </Hint>
        </>
      ) : null}
    </div>
  );
}

function Group({
  children,
  count,
  defaultOpen = true,
  hint,
  summary,
  title,
  trailing,
}: {
  children: ReactNode;
  count?: number;
  defaultOpen?: boolean;
  hint?: string;
  /** A short tally after the title, such as how many Agents are offline. */
  summary?: string;
  title: string;
  trailing?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section aria-label={title} className="mt-6">
      <div className="flex h-7 items-center gap-1.5 px-1 text-sm text-muted-foreground">
        <button
          aria-expanded={open}
          className="flex items-center gap-1.5 rounded-md transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setOpen((value) => !value)}
          type="button"
        >
          <Icon
            className={cn(
              "transition-transform duration-200 motion-reduce:transition-none",
              !open && "-rotate-90",
            )}
            icon={ArrowDown01Icon}
            size={14}
          />
          {title}
          {count === undefined ? null : (
            <span className="text-xs tabular-nums">{count}</span>
          )}
        </button>
        {summary ? <span className="text-xs">· {summary}</span> : null}
        {hint ? (
          <Hint focusable placement="bottom" text={hint}>
            <span className="inline-flex text-muted-foreground/60">
              <Icon icon={InformationCircleIcon} size={14} />
            </span>
          </Hint>
        ) : null}
        <span className="flex-1" />
        {trailing}
      </div>
      {open ? <div className="mt-1 grid gap-1">{children}</div> : null}
    </section>
  );
}

function MarkDot({ tone }: { tone: "neutral" | "warning" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "absolute -right-0.5 -bottom-0.5 size-3 rounded-full ring-2 ring-background",
        tone === "warning" ? "bg-app-warning" : "bg-muted-foreground/50",
      )}
    />
  );
}

function AppRow({
  app,
  cliInstallAvailable,
  computer,
  onSetUp,
  online,
}: {
  app: TeamHubLocalRuntimeType;
  cliInstallAvailable: boolean;
  computer: LocalComputer;
  onSetUp: () => void;
  online: boolean;
}) {
  const t = useT();
  const runtime = computer.runtimes.find((item) => item.type === app);
  const status = runtime?.status ?? "not_installed";
  const name = appNames[app];
  const hint =
    [name, runtime?.version].filter(Boolean).join(" ") +
    ` · ${t(appDescriptions[app])}`;
  if (status === "not_installed")
    return (
      <ComputerRow
        action={
          online ? (
            <Button onClick={onSetUp} size="compact" tone="secondary">
              {t(computersMessages.add)}
            </Button>
          ) : null
        }
        hint={t(computersMessages.optionalApp, {
          description: t(appDescriptions[app]),
        })}
        // The app's own mark, faded: the plus is the Add button's job.
        mark={
          <RowMark dashed>
            <Icon
              className="text-muted-foreground opacity-60"
              icon={appIcons[app]}
              size={20}
            />
          </RowMark>
        }
        subtitle={t(computersMessages.notInstalled)}
        title={<span className="text-muted-foreground">{name}</span>}
      />
    );
  const subtitle = t((online ? onlineAppStates : offlineAppStates)[status]);
  const action = !online ? null : status === "ready" ? (
    <Icon className="text-app-success" icon={Tick02Icon} size={16} />
  ) : status === "authentication_required" ? (
    <Button onClick={onSetUp} size="compact">
      {t(computersMessages.signIn)}
    </Button>
  ) : status === "incompatible" ? (
    <Button onClick={onSetUp} size="compact">
      {t(computersMessages.update)}
    </Button>
  ) : (
    <RuntimeCheckCard
      app={app}
      cliInstallAvailable={cliInstallAvailable}
      computer={computer}
      focusable
    >
      <span className="inline-flex text-muted-foreground">
        <Icon icon={InformationCircleIcon} size={16} />
      </span>
    </RuntimeCheckCard>
  );
  return (
    <ComputerRow
      action={action}
      dimmed={!online}
      hint={hint}
      mark={
        <>
          <RowMark>
            <Icon icon={appIcons[app]} size={20} />
          </RowMark>
          {online && status !== "ready" ? <MarkDot tone="warning" /> : null}
        </>
      }
      subtitle={subtitle}
      title={name}
    />
  );
}

type InstalledAppStatus = Exclude<
  LocalComputer["runtimes"][number]["status"],
  "not_installed"
>;

const onlineAppStates: Record<InstalledAppStatus, Message<string>> = {
  authentication_required: computersMessages.signedOut,
  error: computersMessages.couldNotCheck,
  incompatible: computersMessages.updateNeeded,
  ready: computersMessages.ready,
  unknown: computersMessages.couldNotCheck,
};

/** What an offline Computer last reported about an app. */
const offlineAppStates: Record<InstalledAppStatus, Message<string>> = {
  authentication_required: computersMessages.lastSeenSignedOut,
  error: computersMessages.lastCheckFailed,
  incompatible: computersMessages.lastSeenOutdated,
  ready: computersMessages.lastSeenReady,
  unknown: computersMessages.notCheckedYet,
};

/** The reason the Computer gave, or a plain "couldn't check" without one. */
function runtimeMessage(
  computer: LocalComputer,
  app: TeamHubLocalRuntimeType,
  t: Translate,
) {
  const runtime = computer.runtimes.find((item) => item.type === app);
  return (
    (runtime && localRuntimeMessage(runtime, app, computer.display_name, t)) ??
    t(computersMessages.couldNotCheckApp, { app: appNames[app] })
  );
}

/** Why an app could not be checked, with the command that checks it again. */
function RuntimeCheckCard({
  align,
  app,
  children,
  cliInstallAvailable,
  computer,
  focusable = false,
}: {
  align?: "start" | "end";
  app: TeamHubLocalRuntimeType;
  children: ReactNode;
  cliInstallAvailable: boolean;
  computer: LocalComputer;
  focusable?: boolean;
}) {
  const t = useT();
  return (
    <HintCard
      align={align}
      focusable={focusable}
      content={
        <>
          <span className="block text-sm font-medium text-foreground">
            {runtimeMessage(computer, app, t)}
          </span>
          {cliInstallAvailable ? (
            <>
              {t(computersMessages.checkAgainOn, {
                computer: computer.display_name,
              })}
              <CommandLine command={`${computerCommand()} runtime check`} />
            </>
          ) : null}
        </>
      }
    >
      {children}
    </HintCard>
  );
}

function WorkspaceRows({ computer }: { computer: LocalComputer }) {
  const t = useT();
  return computer.workspace_grants.map((grant) => (
    <ComputerRow
      hint={t(computersMessages.workspaceHint)}
      key={grant.grant_id}
      mark={
        <RowMark>
          <Icon icon={Folder01Icon} size={20} />
        </RowMark>
      }
      subtitle={
        grant.mode === "read-only"
          ? t(computersMessages.agentsCanView)
          : t(computersMessages.agentsCanEdit)
      }
      title={grant.label}
    />
  ));
}

function AdvancedRows({
  cliInstallAvailable,
  computer,
  onRemove,
  onUpdate,
}: {
  cliInstallAvailable: boolean;
  computer: LocalComputer;
  onRemove?: () => void;
  onUpdate?: () => void;
}) {
  const t = useT();
  const command = computerCommand();
  const tools: [IconSvgElement, Message<string>, string][] = [
    [Activity01Icon, computersMessages.toolStatus, `${command} daemon status`],
    [RefreshIcon, computersMessages.toolRestart, `${command} daemon restart`],
    [Search01Icon, computersMessages.toolRecheck, `${command} runtime check`],
    [Link01Icon, computersMessages.reconnect, `${command} login`],
    [StopIcon, computersMessages.toolStop, `${command} daemon stop`],
  ];
  const row = "flex min-h-11 items-center gap-3 px-2.5";
  const label = "w-28 shrink-0 text-sm text-muted-foreground";
  return (
    <>
      <div className={row}>
        <span className={label}>{t(computersMessages.app)}</span>
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-secondary-foreground">
            {computer.daemon_version ?? t(computersMessages.notReported)}
          </span>
          {onUpdate &&
          (computer.upgrade_required || isUpgradeRecommended(computer)) ? (
            <button
              className="inline-flex items-center gap-1.5 rounded-md bg-[var(--app-status-warning-surface)] px-2 py-0.5 text-xs text-app-warning"
              onClick={onUpdate}
              type="button"
            >
              <Icon icon={RefreshIcon} size={12} />
              {computer.recommended_version
                ? t(computersMessages.versionAvailable, {
                    version: computer.recommended_version,
                  })
                : t(computersMessages.update)}
            </button>
          ) : null}
        </span>
      </div>
      <div className={row}>
        <span className={label}>{t(computersMessages.computerId)}</span>
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
          {computer.computer_id}
        </span>
      </div>
      {cliInstallAvailable ? (
        <div className={cn(row, "items-start py-1.5")}>
          <span className={cn(label, "pt-1.5")}>
            {t(computersMessages.troubleshoot)}
          </span>
          <span className="flex flex-wrap gap-1">
            {tools.map(([icon, name, toolCommand]) => (
              <HintCard
                content={
                  <>
                    <span className="block text-sm font-medium text-foreground">
                      {t(name)}
                    </span>
                    {t(computersMessages.runInTerminalOn, {
                      computer: computer.display_name,
                    })}
                    <CommandLine command={toolCommand} />
                  </>
                }
                key={name.id}
              >
                <Button tone="ghost">
                  <Icon icon={icon} size={14} />
                  {t(name)}
                </Button>
              </HintCard>
            ))}
          </span>
        </div>
      ) : null}
      {onRemove ? (
        <div className={row}>
          <span className={label} />
          <Button
            data-voice-risk="never"
            aria-label={t(commonMessages.remove)}
            className="-ml-3 border-transparent"
            onClick={onRemove}
            tone="danger"
          >
            <Icon icon={Delete02Icon} size={14} />
            {t(computersMessages.removeComputer)}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function UpgradeCommand({ platform }: { platform?: ComputerPlatform }) {
  const t = useT();
  const [selected, setSelected] = useState<ComputerPlatform | "">("");
  const target = selected || platform || "";
  return (
    <>
      <ComputerPlatformSelector value={target} onChange={setSelected} />
      {target ? (
        <>
          {target === "win32" ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {t(computersMessages.runInPowerShellWindows)}
            </p>
          ) : null}
          <CommandLine command={computerInstallCommand(target)} key={target} />
        </>
      ) : null}
    </>
  );
}

function platformLabel(platform?: ComputerPlatform) {
  return platform
    ? { darwin: "macOS", linux: "Linux", win32: "Windows" }[platform]
    : null;
}
