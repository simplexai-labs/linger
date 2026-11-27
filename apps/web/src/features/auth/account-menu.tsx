import {
  Download04Icon,
  Logout01Icon,
  RefreshIcon,
  Settings01Icon,
} from "@hugeicons/core-free-icons";

import { ActionMenu, type ActionMenuItem } from "@/components/ui/action-menu";
import { Icon } from "@/components/ui/icon";
import {
  type DesktopUpdate,
  useDesktopUpdate,
} from "@/features/auth/desktop-update";
import { ActorAvatar } from "@/features/rooms/members/actor-avatar";
import type { TeamHubCurrentIdentity } from "@/features/teamhub/teamhub-types";
import type { Translate } from "@/i18n/language";
import { useT } from "@/i18n/use-translation";
import { cn } from "@/lib/cn";

import { accountMenuMessages } from "./account-menu.messages";

interface UpdatePresentation {
  // One line under the version; none while nothing is happening.
  readonly status?: string;
  readonly tone?: "danger";
  // A full error for the tooltip when the line is cut short.
  readonly detail?: string;
  readonly action?: { label: string; run: "install" | "check" };
  // An update waits for the person: the avatar carries a dot.
  readonly attention: boolean;
}

// What the account menu shows for the desktop app's updater state.
function updatePresentation(
  state: DesktopUpdate["state"],
  t: Translate,
): UpdatePresentation {
  const isServiceUpdate =
    state !== undefined &&
    "scope" in state &&
    (state.scope === "web" || state.scope === "backend");
  switch (state?.kind) {
    case "checking":
      return { status: t(accountMenuMessages.checking), attention: false };
    case "downloading":
      return {
        status: isServiceUpdate
          ? t(accountMenuMessages.serviceDownloading)
          : t(accountMenuMessages.downloading, { version: state.version }),
        attention: false,
      };
    case "ready":
      return {
        status: isServiceUpdate
          ? t(accountMenuMessages.serviceReady)
          : t(accountMenuMessages.ready, { version: state.version }),
        action: {
          label: isServiceUpdate
            ? t(accountMenuMessages.updateServices)
            : t(accountMenuMessages.restartToUpdate),
          run: "install",
        },
        attention: true,
      };
    case "waiting":
      return {
        status: isServiceUpdate
          ? t(accountMenuMessages.serviceWaiting)
          : t(accountMenuMessages.waiting, { version: state.version }),
        attention: false,
      };
    case "installing":
      return {
        status: isServiceUpdate
          ? t(accountMenuMessages.serviceInstalling)
          : t(accountMenuMessages.installing, { version: state.version }),
        attention: false,
      };
    case "available":
      return {
        status: t(accountMenuMessages.available, { version: state.version }),
        action: {
          label: t(accountMenuMessages.downloadUpdate),
          run: "install",
        },
        attention: true,
      };
    case "failed":
      return {
        status: t(accountMenuMessages.failed, { error: state.error }),
        tone: "danger",
        detail: state.error,
        action: { label: t(accountMenuMessages.tryAgain), run: "check" },
        attention: false,
      };
    default:
      return { attention: false };
  }
}

export function AccountMenu({
  identity,
  tenantId,
  isPending,
  onLogout,
  onNavigate,
  onOpenSettings,
  settingsOpen = false,
}: {
  identity: TeamHubCurrentIdentity;
  tenantId: string;
  isPending: boolean;
  onLogout: () => void;
  onNavigate: () => void;
  onOpenSettings: () => void;
  settingsOpen?: boolean;
}) {
  const currentActor = identity.actors.find(
    (actor) => actor.tenant_id === tenantId,
  );
  const name = currentActor?.display_name || identity.account.email;
  const identifier = identity.account.email;
  const inSettings = settingsOpen;
  const desktop = useDesktopUpdate();
  const t = useT();
  const update = updatePresentation(desktop?.state, t);
  const action = desktop && update.action;
  const updateItems: ActionMenuItem[] = action
    ? [
        {
          label: action.label,
          icon: (
            <Icon
              icon={
                desktop.state?.kind === "available"
                  ? Download04Icon
                  : RefreshIcon
              }
              size={14}
            />
          ),
          onSelect: action.run === "install" ? desktop.install : desktop.check,
        },
      ]
    : [];
  return (
    <ActionMenu
      label={t(accountMenuMessages.label)}
      placement="top-start"
      buttonClassName={`flex size-11 items-center justify-center rounded-full outline-none transition-colors hover:bg-sidebar-muted aria-expanded:bg-sidebar-muted focus-visible:ring-2 focus-visible:ring-ring md:size-8 ${inSettings ? "bg-sidebar-muted" : ""}`}
      trigger={
        <span className="relative flex">
          <ActorAvatar
            actorId={currentActor?.id}
            kind="human"
            name={name}
            size="xs"
          />
          {desktop && update.attention ? (
            <span
              aria-hidden="true"
              className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-(--app-unread) ring-2 ring-app-sidebar"
              data-testid="account-update-dot"
            />
          ) : null}
        </span>
      }
      header={
        <>
          <p className="truncate text-sm font-semibold" title={name}>
            {name}
          </p>
          <p className="truncate text-xs text-app-muted" title={identifier}>
            {identifier}
          </p>
          {desktop ? (
            <div className="mt-2 text-xs">
              <p className="text-app-muted">
                {t(accountMenuMessages.version, { version: desktop.version })}
              </p>
              {update.status ? (
                <p
                  className={cn(
                    "truncate",
                    update.tone === "danger"
                      ? "text-app-danger"
                      : "text-app-ink",
                  )}
                  title={update.detail ?? update.status}
                >
                  {update.status}
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      }
      iconClassName="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
      itemClassName="flex min-h-[33px] w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus:bg-accent disabled:pointer-events-none disabled:opacity-50 max-md:min-h-11"
      items={[
        ...updateItems,
        {
          label: t(accountMenuMessages.settings),
          icon: <Icon icon={Settings01Icon} size={14} />,
          separatorBefore: updateItems.length > 0,
          onSelect: () => {
            onNavigate();
            onOpenSettings();
          },
        },
        {
          voiceRisk: "never",
          label: t(
            isPending
              ? accountMenuMessages.loggingOut
              : accountMenuMessages.logOut,
          ),
          icon: <Icon icon={Logout01Icon} size={14} />,
          disabled: isPending,
          separatorBefore: true,
          onSelect: () => {
            onNavigate();
            onLogout();
          },
        },
      ]}
    />
  );
}
