import { useQuery } from "@tanstack/react-query";
import { ChromeIcon } from "@hugeicons/core-free-icons";
import { lazy, Suspense, useState } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";

import { ComputerRow, ProgressChip, RowMark, StatusDot } from "../computer-row";
import { browserConnectionQueryOptions } from "./browser-connection-api";
import {
  browserConnectionErrorMessage,
  browserConnectionStateCopy,
  browserConnectionUnavailableCopy,
  isBrowserConnectionUnsupported,
  type BrowserConnectionComputer,
} from "./browser-connection-copy";
import type { TeamHubBrowserConnectionStatus } from "@/features/teamhub/teamhub-types";

const BrowserConnectionDialog = lazy(() =>
  import("./browser-connection-dialog").then((module) => ({
    default: module.BrowserConnectionDialog,
  })),
);

/** One Local Computer's browser, as a summary chip or an Access row. */
export function ComputerBrowserConnection({
  computer,
  computerId,
  online,
  tenantId,
  variant,
}: {
  computer?: BrowserConnectionComputer;
  computerId: string;
  online: boolean;
  tenantId: string;
  variant: "chip" | "row";
}) {
  const { client } = useTeamHubRuntime();
  const [open, setOpen] = useState(false);
  const status = useQuery({
    ...browserConnectionQueryOptions(client, tenantId, computerId),
    enabled: online,
  });
  const state = status.data?.state;
  const unsupported =
    state === "unsupported" || isBrowserConnectionUnsupported(status.error);
  const savedConnectionInvalid =
    status.error instanceof TeamHubError &&
    status.error.code === "BROWSER_CONNECTION_INVALID";
  // A Personal Cloud Computer has no everyday Chrome to connect, so the chip
  // waits for the status rather than appearing and then vanishing.
  if (
    variant === "chip" &&
    (unsupported ||
      (online &&
        (status.isPending || (status.isError && !savedConnectionInvalid))))
  )
    return null;
  const connected = state === "connected";
  const copy = status.data
    ? browserConnectionStateCopy(status.data.state)
    : null;
  const explanation = !online
    ? "Unavailable while this computer is offline."
    : unsupported
      ? browserConnectionUnavailableCopy(computer)
      : status.isError
        ? browserConnectionErrorMessage(status.error, computer)
        : status.data
          ? browserExplanation(status.data.state)
          : "Checking browser status…";
  const dialog = open ? (
    <Suspense fallback={null}>
      <BrowserConnectionDialog
        computerId={computerId}
        onClose={() => setOpen(false)}
        tenantId={tenantId}
      />
    </Suspense>
  ) : null;

  if (variant === "chip")
    return (
      <>
        <ProgressChip
          hint={
            connected
              ? "Agents can use your Chrome"
              : "Optional · let Agents use your Chrome"
          }
          icon={ChromeIcon}
          label={connected ? "Chrome" : "Connect Chrome"}
          onClick={connected || !online ? undefined : () => setOpen(true)}
          state={connected ? "done" : "optional"}
        />
        {dialog}
      </>
    );

  return (
    <>
      <ComputerRow
        action={
          online &&
          status.isError &&
          !unsupported &&
          !savedConnectionInvalid ? (
            <Button
              disabled={status.isFetching}
              onClick={() => void status.refetch()}
              size="compact"
              tone="secondary"
            >
              {status.isFetching ? "Checking…" : "Check again"}
            </Button>
          ) : online &&
            (status.isSuccess || savedConnectionInvalid) &&
            !unsupported ? (
            <Button
              onClick={() => setOpen(true)}
              size="compact"
              tone={connected ? "ghost" : "secondary"}
            >
              {connected ? "Manage" : "Connect"}
            </Button>
          ) : null
        }
        dimmed={!online}
        mark={
          <RowMark>
            <Icon icon={ChromeIcon} size={20} />
          </RowMark>
        }
        subtitle={explanation}
        title={
          <span className="flex items-center gap-2">
            Chrome
            {online && copy ? (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {/* Not connecting is a valid choice, so it never reads as a problem. */}
                <StatusDot
                  tone={
                    status.data?.state === "not_connected"
                      ? "neutral"
                      : copy.tone
                  }
                />
                {copy.short}
              </span>
            ) : null}
          </span>
        }
      />
      {dialog}
    </>
  );
}

/**
 * The second line of the Chrome row. Browser tools work without a connection;
 * connecting only decides whose Chrome, and so whose sign-ins, they use.
 */
function browserExplanation(state: TeamHubBrowserConnectionStatus["state"]) {
  switch (state) {
    case "connected":
      return "Agents use your sign-ins.";
    case "isolated":
      return "Agents browse without your sign-ins.";
    case "not_connected":
      return "Agents ask before browsing.";
    default:
      return browserConnectionStateCopy(state).label;
  }
}
