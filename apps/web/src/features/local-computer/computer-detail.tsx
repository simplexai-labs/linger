import {
  Activity01Icon,
  Add01Icon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Delete02Icon,
  InformationCircleIcon,
  Key01Icon,
  LaptopIcon,
  Link01Icon,
  PlayIcon,
  PowerIcon,
  RefreshIcon,
  Search01Icon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
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
  availabilityOf,
  type AgentAvailability,
} from "./agent-availability";
import { AgentChips, agentNeedsAttention } from "./computer-agent-chips";
import { AppBrandIcon, ComputerDeviceIcon } from "./computer-app-brand-icon";
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
  appStatus,
  appSupported,
  computerReadiness,
  preferredComputerRuntime,
  type ComputerReadiness,
} from "./computer-readiness";
import { relativeTime } from "./computer-relative-time";
import { ComputerRow, ProgressChip, RowMark, StatusDot } from "./computer-row";
import { CopyValueButton } from "./computer-setup-instructions";
import { isUpgradeRecommended } from "./computer-version";
import { computersMessages } from "./computers.messages";
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

  const agentSummary = agentStatusSummary(agentAvailabilities, agents, t);
  const hasAgentAttention = agents.some((agent) =>
    agentNeedsAttention(availabilityOf(agentAvailabilities, agent, t)),
  );
  const activeReadyApp = readiness.kind === "ready" ? readiness.app : undefined;
  const folderCount = computer.workspace_grants.length;
  const showUpdatePill =
    cliInstallAvailable &&
    isUpgradeRecommended(computer) &&
    !computer.upgrade_required;

  return (
    <div
      aria-label={t(computersMessages.detailsLabel, {
        computer: computer.display_name,
      })}
      className="w-full space-y-6"
      role="region"
    >
      <ComputerSummary
        browserChip={browserConnection?.("chip")}
        cliInstallAvailable={cliInstallAvailable}
        computer={computer}
        displayStatus={displayStatus}
        isThisComputer={isThisComputer}
        onConnect={onConnect}
        onSetUp={openSetup}
        onUpdate={cliInstallAvailable ? () => setUpdateOpen(true) : undefined}
        readiness={readiness}
      />

      <HorizontalRailSection
        itemCount={agents.length}
        meta={
          <span className="text-xs font-normal tabular-nums text-muted-foreground/80">
            {agents.length}
          </span>
        }
        title={t(computersMessages.agents)}
        trailing={
          agentSummary ? (
            <span
              className={cn(
                "inline-flex items-center gap-1.5 text-xs",
                hasAgentAttention
                  ? "font-medium text-app-warning"
                  : "text-muted-foreground",
              )}
            >
              <StatusDot tone={hasAgentAttention ? "warning" : "neutral"} />
              {agentSummary}
            </span>
          ) : null
        }
      >
        <AgentChips
          agentAvailabilities={agentAvailabilities}
          agents={agents}
          onOpenAgent={onOpenAgent}
        />
      </HorizontalRailSection>

      <HorizontalRailSection
        hint={t(computersMessages.aiAppsHint)}
        itemCount={appOrder.length}
        title={t(computersMessages.aiApps)}
      >
        <HarnessRailItems
          activeReadyApp={activeReadyApp}
          cliInstallAvailable={cliInstallAvailable}
          computer={computer}
          onSetUp={(app) => openSetup(app)}
          online={online}
        />
      </HorizontalRailSection>

      {localModelsHref ? (
        <Section title={t(computersMessages.systemSection)}>
          <div className="overflow-hidden rounded-2xl bg-card shadow-outline">
            <Link
              className="group/row flex min-h-14 w-full items-center gap-4 px-4 py-3 transition-colors duration-150 hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none"
              to={localModelsHref}
            >
              <span className="min-w-0 flex-1 text-left">
                <span className="block truncate text-sm font-medium text-foreground">
                  {t(computersMessages.manageLocalModels)}
                </span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  {t(computersMessages.manageLocalModelsHint)}
                </span>
              </span>
              <Icon
                className="shrink-0 text-muted-foreground/45 transition-transform duration-150 group-hover/row:translate-x-0.5 group-hover/row:text-muted-foreground motion-reduce:transition-none"
                icon={ArrowRight01Icon}
                size={15}
              />
            </Link>
            {isThisComputer ? (
              <DesktopPreventSleep
                renderGroup={(content) => (
                  <div className="border-t border-border/60">{content}</div>
                )}
              />
            ) : null}
          </div>
        </Section>
      ) : isThisComputer ? (
        <DesktopPreventSleep
          renderGroup={(content) => (
            <Section title={t(computersMessages.systemSection)}>
              <div className="overflow-hidden rounded-2xl bg-card shadow-outline">
                {content}
              </div>
            </Section>
          )}
        />
      ) : null}

      <div className="divide-y divide-border/60 rounded-2xl bg-card shadow-outline">
        {displayStatus === "offline" ? null : (
          <DisclosureItem
            meta={
              <span className="text-xs text-muted-foreground">
                {folderCount > 0
                  ? t(computersMessages.foldersCount, { count: folderCount })
                  : t(computersMessages.accessDescription)}
              </span>
            }
            position="first"
            title={t(computersMessages.access)}
          >
            <div className="divide-y divide-border/60">
              {browserConnection?.("row")}
              <WorkspaceRows computer={computer} />
            </div>
          </DisclosureItem>
        )}

        <DisclosureItem
          meta={
            showUpdatePill ? (
              <span className="rounded-full bg-[var(--app-status-warning-surface)] px-2 py-0.5 text-xs font-medium text-app-warning">
                {t(computersMessages.update)}
              </span>
            ) : null
          }
          position={displayStatus === "offline" ? "only" : "last"}
          title={t(computersMessages.advanced)}
        >
          <AdvancedRows
            cliInstallAvailable={cliInstallAvailable}
            computer={computer}
            onRemove={onRemove}
            onUpdate={
              cliInstallAvailable ? () => setUpdateOpen(true) : undefined
            }
          />
        </DisclosureItem>
      </div>

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

function Section({
  children,
  hint,
  meta,
  title,
  trailing,
}: {
  children: ReactNode;
  hint?: string;
  meta?: ReactNode;
  title: string;
  trailing?: ReactNode;
}) {
  return (
    <section aria-label={title}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
          {meta}
          {hint ? (
            <Hint
              align="start"
              className="rounded-full"
              focusable
              placement="top"
              text={hint}
            >
              <span className="inline-flex text-muted-foreground/55 transition-colors hover:text-muted-foreground">
                <Icon icon={InformationCircleIcon} size={13} />
              </span>
            </Hint>
          ) : null}
        </div>
        {trailing ? <div className="shrink-0">{trailing}</div> : null}
      </div>
      {children}
    </section>
  );
}

const railScrollStepPx = 240;

/**
 * A single-row horizontal shelf with smooth trackpad scrolling, soft edge
 * fade only where items overflow, and quiet header scroll buttons for mouse users.
 */
function HorizontalRailSection({
  children,
  hint,
  itemCount,
  meta,
  title,
  trailing,
}: {
  children: ReactNode;
  hint?: string;
  itemCount: number;
  meta?: ReactNode;
  title: string;
  trailing?: ReactNode;
}) {
  const t = useT();
  const trackRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const sync = () => {
      const left = track.scrollLeft > 2;
      const right =
        track.scrollLeft + track.clientWidth < track.scrollWidth - 2;
      setEdges((current) =>
        current.left === left && current.right === right
          ? current
          : { left, right },
      );
    };
    sync();
    track.addEventListener("scroll", sync, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(sync);
    observer?.observe(track);
    return () => {
      track.removeEventListener("scroll", sync);
      observer?.disconnect();
    };
  }, [itemCount]);

  const overflowing = edges.left || edges.right;
  const maskImage =
    edges.left && edges.right
      ? "linear-gradient(to right, transparent, black 20px, black calc(100% - 20px), transparent)"
      : edges.right
        ? "linear-gradient(to right, black calc(100% - 28px), transparent)"
        : edges.left
          ? "linear-gradient(to right, transparent, black 28px)"
          : undefined;
  const maskStyle: CSSProperties | undefined = maskImage
    ? { WebkitMaskImage: maskImage, maskImage }
    : undefined;

  function scroll(direction: -1 | 1) {
    trackRef.current?.scrollBy({
      behavior: "smooth",
      left: direction * railScrollStepPx,
    });
  }

  return (
    <Section
      hint={hint}
      meta={meta}
      title={title}
      trailing={
        trailing || overflowing ? (
          <div className="flex items-center gap-2">
            {trailing}
            {overflowing ? (
              <div className="flex items-center gap-0.5">
                <button
                  aria-label={t(computersMessages.scrollLeft)}
                  className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-30"
                  disabled={!edges.left}
                  onClick={() => scroll(-1)}
                  type="button"
                >
                  <Icon icon={ArrowLeft01Icon} size={13} />
                </button>
                <button
                  aria-label={t(computersMessages.scrollRight)}
                  className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-30"
                  disabled={!edges.right}
                  onClick={() => scroll(1)}
                  type="button"
                >
                  <Icon icon={ArrowRight01Icon} size={13} />
                </button>
              </div>
            ) : null}
          </div>
        ) : null
      }
    >
      <div
        className="-mx-0.5 flex items-stretch gap-2.5 overflow-x-auto scroll-smooth px-0.5 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        ref={trackRef}
        style={maskStyle}
      >
        {children}
      </div>
    </Section>
  );
}

function DisclosureItem({
  children,
  defaultOpen = false,
  meta,
  position,
  title,
}: {
  children: ReactNode;
  defaultOpen?: boolean;
  meta?: ReactNode;
  position: "first" | "last" | "only";
  title: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const roundedClass =
    position === "only"
      ? open
        ? "rounded-t-2xl"
        : "rounded-2xl"
      : position === "first"
        ? "rounded-t-2xl"
        : open
          ? ""
          : "rounded-b-2xl";
  return (
    <section aria-label={title}>
      <button
        aria-expanded={open}
        aria-label={title}
        className={cn(
          "flex h-12 w-full items-center gap-3 px-4 text-left transition-colors duration-150 hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none",
          roundedClass,
        )}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {title}
        </span>
        {meta ? <span className="shrink-0">{meta}</span> : null}
        <Icon
          className={cn(
            "shrink-0 text-muted-foreground/55 transition-transform duration-200 motion-reduce:transition-none",
            open && "rotate-180",
          )}
          icon={ArrowDown01Icon}
          size={14}
        />
      </button>
      {open ? (
        <div className="border-t border-border/60">{children}</div>
      ) : null}
    </section>
  );
}

function ComputerSummary({
  browserChip,
  cliInstallAvailable,
  computer,
  displayStatus,
  isThisComputer,
  onConnect,
  onSetUp,
  onUpdate,
  readiness,
}: {
  browserChip?: ReactNode;
  cliInstallAvailable: boolean;
  computer: LocalComputer;
  displayStatus: ComputerDisplayStatus;
  isThisComputer: boolean;
  onConnect?: () => void;
  onSetUp: (app: TeamHubLocalRuntimeType, choosable?: boolean) => void;
  onUpdate?: () => void;
  readiness: ComputerReadiness;
}) {
  const t = useT();
  const metadata = [
    platformLabel(computer.platform),
    computer.daemon_version
      ? t(computersMessages.appVersion, { version: computer.daemon_version })
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const statusTone =
    readiness.kind === "ready"
      ? "success"
      : readiness.kind === "offline" || readiness.kind === "reconnecting"
        ? "neutral"
        : "warning";

  const action =
    readiness.kind === "update" ? (
      onUpdate ? (
        <Button onClick={onUpdate} size="compact" tone="primary">
          {t(computersMessages.update)}
        </Button>
      ) : null
    ) : readiness.kind === "signIn" ? (
      <Button
        onClick={() => onSetUp(readiness.app)}
        size="compact"
        tone="primary"
      >
        {t(computersMessages.signInToApp, { app: appNames[readiness.app] })}
      </Button>
    ) : readiness.kind === "updateApp" ? (
      <Button
        onClick={() => onSetUp(readiness.app)}
        size="compact"
        tone="primary"
      >
        {t(computersMessages.updateApp, { app: appNames[readiness.app] })}
      </Button>
    ) : readiness.kind === "check" ? (
      <RuntimeCheckCard
        align="end"
        app={readiness.app}
        cliInstallAvailable={cliInstallAvailable}
        computer={computer}
      >
        <Button size="compact" tone="primary">
          {t(computersMessages.checkAgain)}
        </Button>
      </RuntimeCheckCard>
    ) : readiness.kind === "setUp" ? (
      <Button
        onClick={() => onSetUp(readiness.app, true)}
        size="compact"
        tone="primary"
      >
        {t(computersMessages.setUpApp, { app: appNames[readiness.app] })}
      </Button>
    ) : null;

  return (
    <section className="rounded-2xl bg-card shadow-sm">
      <div className="flex flex-wrap items-center gap-3.5 px-4 py-4">
        <ComputerDeviceIcon
          online={readiness.kind !== "offline"}
          platform={computer.platform}
          size={44}
        />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-[15px] font-medium text-foreground">
              {computer.display_name}
            </h2>
            {isThisComputer ? (
              <span className="rounded-md bg-muted/75 px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground">
                {t(computersMessages.thisComputer)}
              </span>
            ) : null}
          </div>
          {metadata ? (
            <p className="mt-0.5 truncate text-xs tabular-nums text-muted-foreground">
              {metadata}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <SummaryStatus
            computer={computer}
            readiness={readiness}
            statusTone={statusTone}
          />
          {action}
        </div>
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
            "flex flex-wrap items-center gap-2 px-4 pt-0 pb-3.5 sm:pl-[74px]",
            displayStatus === "reconnecting" && "opacity-55",
          )}
        >
          {computer.upgrade_required ? (
            <ProgressChip
              attentionIcon={RefreshIcon}
              hint={t(computersMessages.lingerTooOld)}
              icon={LaptopIcon}
              label={t(computersMessages.update)}
              onClick={onUpdate}
              state="attention"
            />
          ) : (
            <ProgressChip
              accent="success"
              hint={t(computersMessages.lingerRunning)}
              label={t(computersMessages.connected)}
              leading={<StatusDot tone="success" />}
              state="done"
            />
          )}

          {readiness.kind === "ready" ? (
            <ProgressChip
              hint={t(computersMessages.agentsUseApp, {
                app: appNames[readiness.app],
              })}
              label={appNames[readiness.app]}
              leading={<AppBrandIcon active app={readiness.app} size={14} />}
              state="done"
            />
          ) : readiness.kind === "signIn" ? (
            <ProgressChip
              attentionIcon={Key01Icon}
              hint={t(computersMessages.appSignedOut, {
                app: appNames[readiness.app],
              })}
              label={t(computersMessages.signIn)}
              leading={
                <AppBrandIcon active={false} app={readiness.app} size={14} />
              }
              onClick={() => onSetUp(readiness.app)}
              state="attention"
            />
          ) : readiness.kind === "updateApp" ? (
            <ProgressChip
              attentionIcon={RefreshIcon}
              hint={t(computersMessages.appTooOld, {
                app: appNames[readiness.app],
              })}
              label={t(computersMessages.update)}
              leading={
                <AppBrandIcon active={false} app={readiness.app} size={14} />
              }
              onClick={() => onSetUp(readiness.app)}
              state="attention"
            />
          ) : readiness.kind === "check" ? (
            <ProgressChip
              attentionIcon={Search01Icon}
              hint={runtimeMessage(computer, readiness.app, t)}
              label={appNames[readiness.app]}
              leading={
                <AppBrandIcon active={false} app={readiness.app} size={14} />
              }
              onClick={() => onSetUp(readiness.app)}
              state="attention"
            />
          ) : (
            <ProgressChip
              attentionIcon={Add01Icon}
              hint={t(computersMessages.needAiApp)}
              label={appNames.claude}
              leading={<AppBrandIcon active={false} app="claude" size={14} />}
              onClick={() => onSetUp("claude", true)}
              state="attention"
            />
          )}

          {browserChip}
        </div>
      )}
    </section>
  );
}

function SummaryStatus({
  computer,
  readiness,
  statusTone,
}: {
  computer: LocalComputer;
  readiness: ComputerReadiness;
  statusTone: "neutral" | "success" | "warning";
}) {
  const translation = useTranslation();
  const { t } = translation;
  let content: ReactNode = null;
  if (readiness.kind === "reconnecting") {
    content = (
      <span className="town-shimmer-text">
        {t(computersMessages.reconnecting)}
      </span>
    );
  } else if (readiness.kind === "offline") {
    content = (
      <>
        <StatusDot tone="neutral" />
        {computer.last_seen_at
          ? t(computersMessages.offlineSince, {
              time: relativeTime(computer.last_seen_at, translation),
            })
          : t(computersMessages.offline)}
      </>
    );
  } else if (readiness.kind === "update") {
    content = (
      <>
        <StatusDot tone="warning" />
        {t(computersMessages.updateRequired)}
      </>
    );
  } else if (readiness.kind === "check") {
    content = (
      <>
        <StatusDot tone="warning" />
        {t(computersMessages.couldNotCheckApp, {
          app: appNames[readiness.app],
        })}
      </>
    );
  } else if (readiness.kind === "ready") {
    content = (
      <>
        <StatusDot tone="success" />
        {computer.active_operations
          ? t(computersMessages.readyRunning, {
              count: computer.active_operations,
            })
          : t(computersMessages.ready)}
      </>
    );
  }
  if (!content) return null;
  return (
    <span
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium",
        statusTone === "success"
          ? "bg-[var(--app-status-success-surface)] text-app-success"
          : statusTone === "warning"
            ? "bg-[var(--app-status-warning-surface)] text-app-warning"
            : "bg-muted text-muted-foreground",
      )}
      role="status"
    >
      {content}
    </span>
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
  const stepClass =
    "inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-card pr-2.5 pl-1.5 text-xs text-foreground transition-colors duration-150 hover:border-border-hover";
  const bubbleClass =
    "flex size-4 items-center justify-center rounded-full bg-muted text-muted-foreground";
  return (
    <div className="rounded-b-xl border-t border-border/70 bg-muted/25 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Hint
          align="start"
          focusable
          placement="top"
          text={t(computersMessages.turnOnHint)}
        >
          <span className={stepClass}>
            <span className={bubbleClass}>
              <Icon icon={PowerIcon} size={10} />
            </span>
            {t(computersMessages.turnOn)}
          </span>
        </Hint>
        {cliInstallAvailable ? (
          <>
            <Icon
              className="text-muted-foreground/45"
              icon={ArrowRight01Icon}
              size={12}
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
              <span className={stepClass}>
                <span className={bubbleClass}>
                  <Icon icon={PlayIcon} size={10} />
                </span>
                {t(computersMessages.startApp)}
              </span>
            </HintCard>
          </>
        ) : null}
        {onConnect ? (
          <>
            <Icon
              className="text-muted-foreground/45"
              icon={ArrowRight01Icon}
              size={12}
            />
            <Hint
              align="start"
              placement="top"
              text={t(computersMessages.reconnectHint)}
            >
              <button className={stepClass} onClick={onConnect} type="button">
                <span className={bubbleClass}>
                  <Icon icon={Link01Icon} size={10} />
                </span>
                {t(computersMessages.reconnect)}
              </button>
            </Hint>
          </>
        ) : null}
      </div>
    </div>
  );
}

function HarnessRailItems({
  activeReadyApp,
  cliInstallAvailable,
  computer,
  onSetUp,
  online,
}: {
  activeReadyApp?: TeamHubLocalRuntimeType;
  cliInstallAvailable: boolean;
  computer: LocalComputer;
  onSetUp: (app: TeamHubLocalRuntimeType) => void;
  online: boolean;
}) {
  const ordered = [...appOrder].sort((left, right) => {
    const rank = (app: TeamHubLocalRuntimeType) => {
      if (!appSupported(computer, app)) return 4;
      const status = appStatus(computer, app);
      if (status === "not_installed") return 3;
      if (app === activeReadyApp) return 0;
      return status === "ready" ? 2 : 1;
    };
    return rank(left) - rank(right);
  });

  return (
    <>
      {ordered.map((app) => (
        <HarnessTile
          active={app === activeReadyApp}
          app={app}
          cliInstallAvailable={cliInstallAvailable}
          computer={computer}
          key={app}
          onSetUp={() => onSetUp(app)}
          online={online}
        />
      ))}
    </>
  );
}

function HarnessTile({
  active,
  app,
  cliInstallAvailable,
  computer,
  onSetUp,
  online,
}: {
  active: boolean;
  app: TeamHubLocalRuntimeType;
  cliInstallAvailable: boolean;
  computer: LocalComputer;
  onSetUp: () => void;
  online: boolean;
}) {
  const t = useT();
  const runtime = computer.runtimes.find((item) => item.type === app);
  const supported = appSupported(computer, app);
  const rawStatus = runtime?.status ?? "not_installed";
  const installed = supported && rawStatus !== "not_installed";
  const isReady = installed && rawStatus === "ready";
  const needsAction = installed && online && !isReady;
  const name = appNames[app];
  const description = t(appDescriptions[app]);
  const hint = !supported
    ? t(computersMessages.needsNewerLingerHint, {
        app: name,
        computer: computer.display_name,
      })
    : [name, runtime?.version].filter(Boolean).join(" ") + ` · ${description}`;

  const topRight = !supported ? null : !installed ? (
    online ? (
      <Button onClick={onSetUp} size="compact" tone="subtle">
        {t(computersMessages.add)}
      </Button>
    ) : null
  ) : !online ? null : isReady ? (
    active ? (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--app-status-success-surface)] px-2 py-0.5 text-[11px] font-medium text-app-success">
        <StatusDot tone="success" />
        {t(computersMessages.inUse)}
      </span>
    ) : (
      <span className="text-[11px] font-medium text-app-success/85">
        {t(onlineAppStates.ready)}
      </span>
    )
  ) : rawStatus === "authentication_required" ? (
    <Button onClick={onSetUp} size="compact" tone="primary">
      {t(computersMessages.signIn)}
    </Button>
  ) : rawStatus === "incompatible" ? (
    <Button onClick={onSetUp} size="compact" tone="primary">
      {t(computersMessages.update)}
    </Button>
  ) : (
    <RuntimeCheckCard
      align="end"
      app={app}
      cliInstallAvailable={cliInstallAvailable}
      computer={computer}
      floating
      focusable
    >
      <span className="inline-flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
        <Icon icon={InformationCircleIcon} size={14} />
      </span>
    </RuntimeCheckCard>
  );

  const subline = !supported ? (
    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
      {t(computersMessages.needsNewerLinger)}
    </span>
  ) : installed && !online ? (
    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
      {t(offlineAppStates[rawStatus])}
    </span>
  ) : needsAction ? (
    <span className="mt-0.5 block truncate text-[11px] text-app-warning">
      {t(onlineAppStates[rawStatus])}
    </span>
  ) : null;

  return (
    <Hint
      align="start"
      className="shrink-0"
      floating
      placement="top"
      text={hint}
    >
      <div
        className={cn(
          "flex w-[158px] flex-col justify-between gap-2.5 rounded-2xl px-3.5 py-3 transition-[background-color,box-shadow] duration-150 motion-reduce:transition-none",
          !supported
            ? "bg-muted/30 opacity-65"
            : !installed
              ? "bg-muted/45 hover:bg-muted/75"
              : needsAction
                ? "bg-[var(--app-status-warning-surface)]/55"
                : active && online
                  ? "bg-card shadow-sm"
                  : "bg-card shadow-outline hover:shadow-sm",
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <span
            className={cn(
              "flex size-7 shrink-0 items-center justify-center",
              installed && !online && "opacity-50 grayscale",
            )}
          >
            <AppBrandIcon
              active={installed && online && isReady}
              app={app}
              size={20}
            />
          </span>
          {topRight ? <span className="shrink-0">{topRight}</span> : null}
        </div>
        <div className="min-w-0">
          <span
            className={cn(
              "block truncate text-[13px] font-medium leading-tight",
              !supported || (installed && !online)
                ? "text-muted-foreground"
                : installed
                  ? "text-foreground"
                  : "text-foreground/80",
            )}
          >
            {name}
          </span>
          {subline}
        </div>
      </div>
    </Hint>
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
  floating = false,
  focusable = false,
}: {
  align?: "start" | "end";
  app: TeamHubLocalRuntimeType;
  children: ReactNode;
  cliInstallAvailable: boolean;
  computer: LocalComputer;
  floating?: boolean;
  focusable?: boolean;
}) {
  const t = useT();
  return (
    <HintCard
      align={align}
      floating={floating}
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

function WorkspaceFolderIcon() {
  return (
    <svg
      aria-hidden
      className="size-4 shrink-0"
      fill="none"
      viewBox="0 0 20 20"
    >
      <path
        d="M2.5 5.5A1.5 1.5 0 0 1 4 4h3.45c.44 0 .86.19 1.15.53l.85.99c.2.23.48.36.78.36H16A1.5 1.5 0 0 1 17.5 7.38V14.5A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5v-9Z"
        fill="currentColor"
        fillOpacity={0.08}
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth={1.45}
      />
      <path
        d="M2.5 8.25h15"
        stroke="currentColor"
        strokeOpacity={0.28}
        strokeWidth={1.2}
      />
    </svg>
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
          <WorkspaceFolderIcon />
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
  const computerIdRef = useRef<HTMLElement>(null);
  const command = computerCommand();
  const tools: [IconSvgElement, Message<string>, string][] = [
    [Activity01Icon, computersMessages.toolStatus, `${command} daemon status`],
    [RefreshIcon, computersMessages.toolRestart, `${command} daemon restart`],
    [Search01Icon, computersMessages.toolRecheck, `${command} runtime check`],
    [Link01Icon, computersMessages.reconnect, `${command} login`],
    [StopIcon, computersMessages.toolStop, `${command} daemon stop`],
  ];
  const row = "flex min-h-11 flex-wrap items-center gap-3 px-4 py-2";
  const label = "w-28 shrink-0 text-xs text-muted-foreground";
  return (
    <div className="divide-y divide-border/70">
      <div className={row}>
        <span className={label}>{t(computersMessages.app)}</span>
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-foreground">
            {computer.daemon_version ?? t(computersMessages.notReported)}
          </span>
          {onUpdate &&
          (computer.upgrade_required || isUpgradeRecommended(computer)) ? (
            <button
              className="inline-flex items-center gap-1 text-xs font-medium text-app-warning hover:underline"
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
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <code
            className="min-w-0 truncate font-mono text-xs text-muted-foreground"
            ref={computerIdRef}
          >
            {computer.computer_id}
          </code>
          <CopyValueButton
            selectionTargetRef={computerIdRef}
            value={computer.computer_id}
          />
        </span>
      </div>
      {cliInstallAvailable ? (
        <div className={cn(row, "items-start py-2.5")}>
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
                <Button size="compact" tone="ghost">
                  <Icon icon={icon} size={13} />
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
            aria-label={t(commonMessages.remove)}
            className="-ml-2.5 border-transparent"
            data-voice-risk="never"
            onClick={onRemove}
            size="compact"
            tone="danger"
          >
            <Icon icon={Delete02Icon} size={14} />
            {t(computersMessages.removeComputer)}
          </Button>
        </div>
      ) : null}
    </div>
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

export function platformLabel(platform?: ComputerPlatform) {
  return platform
    ? { darwin: "macOS", linux: "Linux", win32: "Windows" }[platform]
    : null;
}
