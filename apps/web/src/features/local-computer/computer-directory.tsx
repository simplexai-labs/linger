import { ActorAvatar } from "@/features/rooms/members/actor-avatar";
import type {
  TeamHubLocalComputerPage,
  TeamHubTenantAgent,
} from "@/features/teamhub/teamhub-types";
import { useTranslation } from "@/i18n/use-translation";
import { cn } from "@/lib/cn";

import { AppBrandIcon, ComputerDeviceIcon } from "./computer-app-brand-icon";
import { useComputerConnectionStatus } from "./computer-connection-status";
import { platformLabel } from "./computer-detail";
import {
  appNames,
  appOrder,
  appStatus,
  computerReadiness,
} from "./computer-readiness";
import { relativeTime } from "./computer-relative-time";
import { ComputerRow, StatusDot } from "./computer-row";
import { computersMessages } from "./computers.messages";
import { useDesktopComputer } from "./desktop-computer";

type LocalComputer = TeamHubLocalComputerPage["items"][number];

/** Every Computer in one elevated list card; selecting a row opens its detail. */
export function ComputerDirectory({
  agents,
  computers,
  onSelect,
}: {
  agents: TeamHubTenantAgent[];
  computers: LocalComputer[];
  onSelect: (computerId: string) => void;
}) {
  const { t } = useTranslation();
  const desktopComputer = useDesktopComputer();
  const ordered = [
    ...computers.filter((computer) => computer.status === "online"),
    ...computers.filter((computer) => computer.status !== "online"),
  ];
  const onlineCount = computers.filter(
    (computer) => computer.status === "online",
  ).length;

  return (
    <div>
      <div className="mb-2.5 flex flex-wrap items-center gap-2 px-0.5 text-xs tabular-nums text-muted-foreground">
        <span>
          {t(computersMessages.computersSummary, { count: computers.length })}
        </span>
        {onlineCount > 0 ? (
          <span className="inline-flex items-center gap-1.5">
            <span>·</span>
            <StatusDot tone="success" />
            {t(computersMessages.onlineCount, { count: onlineCount })}
          </span>
        ) : null}
      </div>
      <ul
        aria-label={t(computersMessages.directoryLabel)}
        className="divide-y divide-border/60 overflow-hidden rounded-2xl bg-card shadow-outline"
      >
        {ordered.map((computer) => (
          <li key={computer.computer_id}>
            <DirectoryRow
              agents={agents.filter(
                (agent) =>
                  agent.runtime.placement?.computer_id === computer.computer_id,
              )}
              computer={computer}
              isThisComputer={
                desktopComputer?.status?.computerId === computer.computer_id
              }
              onSelect={() => onSelect(computer.computer_id)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function DirectoryRow({
  agents,
  computer,
  isThisComputer,
  onSelect,
}: {
  agents: TeamHubTenantAgent[];
  computer: LocalComputer;
  isThisComputer: boolean;
  onSelect: () => void;
}) {
  const translation = useTranslation();
  const { t } = translation;
  const displayStatus = useComputerConnectionStatus(
    computer.computer_id,
    computer.status,
  );
  const readiness = computerReadiness(computer, displayStatus);
  const offline = displayStatus !== "online";
  const statusTone =
    readiness.kind === "ready"
      ? "success"
      : readiness.kind === "offline" || readiness.kind === "reconnecting"
        ? "neutral"
        : "warning";
  const subtitle =
    readiness.kind === "reconnecting" ? (
      <span className="town-shimmer-text">
        {t(computersMessages.reconnecting)}
      </span>
    ) : readiness.kind === "offline" ? (
      computer.last_seen_at ? (
        t(computersMessages.offlineSince, {
          time: relativeTime(computer.last_seen_at, translation),
        })
      ) : (
        t(computersMessages.offline)
      )
    ) : readiness.kind === "update" ? (
      t(computersMessages.updateRequired)
    ) : readiness.kind === "signIn" ? (
      t(computersMessages.signInToApp, { app: appNames[readiness.app] })
    ) : readiness.kind === "updateApp" ? (
      t(computersMessages.updateApp, { app: appNames[readiness.app] })
    ) : readiness.kind === "check" ? (
      t(computersMessages.couldNotCheckApp, { app: appNames[readiness.app] })
    ) : readiness.kind === "setUp" ? (
      t(computersMessages.setUpApp, { app: appNames[readiness.app] })
    ) : computer.active_operations ? (
      t(computersMessages.readyRunning, { count: computer.active_operations })
    ) : (
      t(computersMessages.ready)
    );
  const apps = appOrder.filter(
    (app) => appStatus(computer, app) !== "not_installed",
  );
  const os = platformLabel(computer.platform);

  return (
    <ComputerRow
      action={
        <span className="flex shrink-0 items-center gap-3">
          {apps.length ? (
            <span className={cn("flex gap-1", offline && "opacity-45")}>
              {apps.map((app) => (
                <span
                  className={cn(
                    "flex size-6 items-center justify-center rounded-lg ring-1 ring-inset",
                    appStatus(computer, app) === "ready"
                      ? "bg-muted/75 ring-border/70"
                      : "bg-[var(--app-status-warning-surface)] text-app-warning ring-[var(--app-status-warning-border)]",
                  )}
                  key={app}
                  title={appNames[app]}
                >
                  <AppBrandIcon
                    active={!offline && appStatus(computer, app) === "ready"}
                    app={app}
                    size={14}
                  />
                </span>
              ))}
            </span>
          ) : null}
          {agents.length ? (
            <span className="flex">
              {agents.slice(0, 4).map((agent, index) => (
                <span
                  className={cn(
                    "rounded-[20%] ring-2 ring-card",
                    index > 0 && "-ml-1.5",
                  )}
                  key={agent.actor.id}
                >
                  <ActorAvatar
                    actorId={agent.actor.id}
                    kind="agent"
                    name={agent.actor.display_name}
                    size="xxs"
                  />
                </span>
              ))}
            </span>
          ) : null}
        </span>
      }
      dimmed={offline}
      mark={
        <ComputerDeviceIcon
          online={!offline}
          platform={computer.platform}
          size={36}
        />
      }
      onClick={onSelect}
      showChevron
      subtitle={
        <span className="flex items-center gap-1.5">
          {readiness.kind === "reconnecting" ? null : (
            <StatusDot tone={statusTone} />
          )}
          <span
            className={cn(
              "truncate",
              statusTone === "warning" && "text-app-warning",
            )}
          >
            {subtitle}
          </span>
        </span>
      }
      title={
        <span className="flex items-center gap-2">
          <span className="truncate">{computer.display_name}</span>
          {os ? (
            <span className="shrink-0 text-xs font-normal text-muted-foreground/75">
              {os}
            </span>
          ) : null}
          {isThisComputer ? (
            <span className="shrink-0 rounded-md bg-muted/80 px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground">
              {t(computersMessages.thisComputer)}
            </span>
          ) : null}
        </span>
      }
    />
  );
}
