import { Tick02Icon } from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";
import { anotherMeQueryOptions } from "@/features/rooms/room-queries";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubLocalComputerPage,
  TeamHubLocalRuntimeType,
} from "@/features/teamhub/teamhub-types";
import { RichMessage, useT } from "@/i18n/use-translation";
import { cn } from "@/lib/cn";

import { CommandLine } from "./computer-app-setup-dialog";
import {
  browserComputerPlatform,
  computerCommand,
  computerInstallCommand,
  ComputerPlatformSelector,
} from "./computer-platform";
import {
  appNames,
  appOrder,
  appStatus,
  runtimeStatusLabels,
} from "./computer-readiness";
import { computerSetupMessages } from "./computer-setup.messages";
import { computersMessages } from "./computers.messages";
import { useCliInstallAvailable, useDesktopComputer } from "./desktop-computer";
import { DesktopComputerSetup } from "./desktop-computer-setup";
import { localComputersQueryOptions } from "./local-computer-queries";
import { LocalRuntimeAuthenticationGuidance } from "./local-runtime-authentication-guidance";
import { LocalRuntimeInstallGuidance } from "./local-runtime-install-guidance";
import { ServerConnection } from "./server-connection";

type LocalComputer = TeamHubLocalComputerPage["items"][number];
type RuntimeStatus = LocalComputer["runtimes"][number]["status"];

// Runtime installs and sign-ins happen on the Computer and reach the Web only
// through the inventory, so the gate polls while it is open.
const pollIntervalMs = 3_000;

/**
 * Every model call, Another Me's included, runs on the Human's own Computer,
 * so this build has nothing to offer before one runs an AI app. TeamHub
 * creates Another Me the first time such a Computer comes online; until then
 * this gate covers the product except Settings, where a Pi-only Computer
 * loads its first local model. It exists only while no hosted runtime does.
 */
export function LocalComputerGate({
  onSignOut,
  signingOut,
  tenantId,
}: {
  onSignOut: () => void;
  signingOut: boolean;
  tenantId: string;
}) {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const desktop = useDesktopComputer();
  const cliInstallAvailable = useCliInstallAvailable();
  const [platform, setPlatform] = useState(browserComputerPlatform);
  // The desktop preloads this page hidden so "Open Linger" can reveal a
  // rendered Room, and the realtime stream is closed while hidden, so the gate
  // keeps polling in the background or it never sees Another Me arrive.
  const computers = useQuery({
    ...localComputersQueryOptions(client, tenantId),
    refetchInterval: pollIntervalMs,
    refetchIntervalInBackground: true,
  });
  useQuery({
    ...anotherMeQueryOptions(client, tenantId),
    refetchInterval: pollIntervalMs,
    refetchIntervalInBackground: true,
  });
  const computer = gateComputer(computers.data?.items ?? []);
  const online = computer?.status === "online" && !computer.upgrade_required;
  const ready = online && hasReadyRuntime(computer);
  const desktopOnlyStep = Boolean(
    desktop && (!computer || !cliInstallAvailable),
  );
  const command = computerCommand();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm">
      <section
        aria-labelledby="local-computer-gate-title"
        aria-modal="true"
        className="workspace-scrollbar flex max-h-full w-full max-w-[560px] flex-col overflow-y-auto rounded-2xl border border-border bg-card text-foreground shadow-lg"
        role="dialog"
      >
        <header className="border-b border-border px-6 pb-4 pt-5">
          <p className="text-xs text-muted-foreground">
            {t(computersMessages.gateKicker)}
          </p>
          <h2 className="mt-1 text-lg" id="local-computer-gate-title">
            {t(computersMessages.gateTitle)}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(computersMessages.gateIntro)}
          </p>
          {desktop ? null : (
            <ComputerPlatformSelector onChange={setPlatform} value={platform} />
          )}
        </header>

        {ready ? (
          <p
            className="flex items-center justify-center gap-2 px-6 py-10 text-sm"
            role="status"
          >
            <Spinner size={14} />
            {t(computersMessages.gateReady)}
          </p>
        ) : (
          <ol className="divide-y divide-border px-6">
            {desktopOnlyStep && desktop ? (
              <GateStep
                number={1}
                state={online ? "done" : "current"}
                title={t(computerSetupMessages.connectThisComputer)}
              >
                {online && computer ? (
                  <p className="mt-2 text-xs text-app-success" role="status">
                    {t(computersMessages.computerOnline, {
                      computer: computer.display_name,
                    })}
                  </p>
                ) : (
                  <DesktopComputerSetup desktop={desktop} />
                )}
              </GateStep>
            ) : (
              <>
                <GateStep
                  number={1}
                  state={computer ? "done" : "current"}
                  title={t(computersMessages.installTheCli)}
                >
                  <CommandLine
                    command={computerInstallCommand(platform)}
                    key={platform}
                  />
                </GateStep>
                <GateStep
                  number={2}
                  state={online ? "done" : computer ? "current" : "next"}
                  title={t(computerSetupMessages.connectThisComputer)}
                >
                  <CommandLine command={`${command} login`} />
                  <ConnectionStatus command={command} computer={computer} />
                </GateStep>
              </>
            )}
            <GateStep
              number={desktopOnlyStep ? 2 : 3}
              state={online ? "current" : "next"}
              title={t(computersMessages.setUpAiApp)}
            >
              {computer && online ? (
                <AppSetup computer={computer} tenantId={tenantId} />
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t(computersMessages.availableOnceOnline)}
                </p>
              )}
            </GateStep>
          </ol>
        )}
        {ready || desktop ? null : (
          <div className="px-6 pb-5">
            <ServerConnection tenantId={tenantId} />
          </div>
        )}

        <footer className="flex justify-end border-t border-border bg-muted/40 px-6 py-3">
          <Button
            data-voice-risk="never"
            disabled={signingOut}
            onClick={onSignOut}
            tone="ghost"
          >
            {signingOut
              ? t(computersMessages.signingOut)
              : t(computersMessages.signOut)}
          </Button>
        </footer>
      </section>
    </div>
  );
}

function ConnectionStatus({
  command,
  computer,
}: {
  command: string;
  computer: LocalComputer | undefined;
}) {
  const t = useT();
  if (!computer)
    return (
      <p
        className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground"
        role="status"
      >
        <Spinner size={12} />
        {t(computersMessages.waitingForComputer)}
      </p>
    );
  if (computer.upgrade_required)
    return (
      <p className="mt-2 text-xs text-app-warning" role="status">
        {t(computersMessages.computerNeedsUpdate, {
          computer: computer.display_name,
        })}
      </p>
    );
  if (computer.status !== "online")
    return (
      <p className="mt-2 text-xs text-app-warning" role="status">
        <RichMessage
          message={computersMessages.computerOfflineStart}
          tags={{
            code: (text) => <code className="font-mono">{text}</code>,
          }}
          values={{
            command: `${command} daemon start`,
            computer: computer.display_name,
          }}
        />
      </p>
    );
  return (
    <p className="mt-2 text-xs text-app-success" role="status">
      {t(computersMessages.computerOnline, { computer: computer.display_name })}
    </p>
  );
}

function AppSetup({
  computer,
  tenantId,
}: {
  computer: LocalComputer;
  tenantId: string;
}) {
  const t = useT();
  const missing = appOrder.filter(
    (app) => appStatus(computer, app) === "not_installed",
  );
  const outdated = appOrder.filter(
    (app) => appStatus(computer, app) === "incompatible",
  );
  const signIn = appOrder.filter(
    (app) => appStatus(computer, app) === "authentication_required",
  );
  return (
    <div className="mt-2 space-y-3">
      <p className="text-xs text-muted-foreground">
        {t(computersMessages.oneReadyAppEnough)}
      </p>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {appOrder.map((app) => (
          <AppRow app={app} key={app} status={appStatus(computer, app)} />
        ))}
      </ul>
      {signIn.map((app) => (
        <div className="text-xs" key={app} role="status">
          <LocalRuntimeAuthenticationGuidance
            computer={computer}
            computerName={computer.display_name}
            runtimeType={app}
          />
        </div>
      ))}
      {signIn.length === 0 ? (
        <>
          <LocalRuntimeInstallGuidance
            action="update"
            computerName={computer.display_name}
            platform={computer.platform}
            runtimeTypes={outdated}
          />
          <LocalRuntimeInstallGuidance
            computerName={computer.display_name}
            platform={computer.platform}
            runtimeTypes={missing}
          />
        </>
      ) : null}
      <p className="text-xs text-muted-foreground">
        <RichMessage
          message={computersMessages.orRunLocalModel}
          tags={{
            link: (text) => (
              <Link
                className="text-foreground underline underline-offset-2"
                to={`/t/${encodeURIComponent(tenantId)}/settings/models?computer=${encodeURIComponent(computer.computer_id)}`}
              >
                {text}
              </Link>
            ),
          }}
          values={{ computer: computer.display_name }}
        />
      </p>
      <p
        className="flex items-center gap-1.5 text-xs text-muted-foreground"
        role="status"
      >
        <Spinner size={12} />
        {t(computersMessages.checkingComputer, {
          computer: computer.display_name,
        })}
      </p>
    </div>
  );
}

function AppRow({
  app,
  status,
}: {
  app: TeamHubLocalRuntimeType;
  status: RuntimeStatus;
}) {
  const t = useT();
  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
      {appNames[app]}
      <span
        className={cn(
          "text-xs",
          status === "ready"
            ? "text-app-success"
            : status === "authentication_required"
              ? "text-app-warning"
              : "text-muted-foreground",
        )}
      >
        {t(runtimeStatusLabels[status])}
      </span>
    </li>
  );
}

function GateStep({
  children,
  number,
  state,
  title,
}: {
  children: ReactNode;
  number: number;
  state: "done" | "current" | "next";
  title: string;
}) {
  return (
    <li className="flex gap-3 py-4">
      <span
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-2xs font-semibold",
          state === "done"
            ? "bg-app-success text-white"
            : state === "current"
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground",
        )}
      >
        {state === "done" ? <Icon icon={Tick02Icon} size={12} /> : number}
      </span>
      <div className={cn("min-w-0 flex-1", state === "next" && "opacity-60")}>
        <p className="text-sm font-medium">{title}</p>
        {children}
      </div>
    </li>
  );
}

/** The Computer closest to running Another Me: online and ready first. */
function gateComputer(computers: readonly LocalComputer[]) {
  const online = computers.filter(
    (computer) => computer.status === "online" && !computer.upgrade_required,
  );
  return online.find(hasReadyRuntime) ?? online[0] ?? computers[0] ?? undefined;
}

function hasReadyRuntime(computer: LocalComputer) {
  return computer.runtimes.some(
    (runtime) => runtime.status === "ready" && runtime.models.length > 0,
  );
}
