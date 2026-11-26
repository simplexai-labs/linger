import { Message01Icon, Settings01Icon } from "@hugeicons/core-free-icons";
import {
  isRouteErrorResponse,
  NavLink,
  useLocation,
  useNavigate,
  useParams,
  useRouteError,
} from "react-router";

import { TeamHubError } from "@/features/teamhub/teamhub-client";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/ui/brand-mark";
import { Icon } from "@/components/ui/icon";
import { navigationMessages } from "@/features/rooms/room-navigation.messages";
import { settingsMessages } from "@/features/settings/settings.messages";
import { commonMessages } from "@/i18n/common.messages";
import { useT } from "@/i18n/use-translation";

import { routePagesMessages } from "./route-pages.messages";

export function FullPageRouteErrorSurface() {
  const { tenantId } = useParams();

  return <ApplicationRouteErrorSurface tenantId={tenantId} />;
}

export function PanelRouteErrorSurface() {
  return <PanelRouteErrorContent />;
}

function PanelRouteErrorContent() {
  const t = useT();
  const content = useRouteErrorContent(false);
  const navigate = useNavigate();

  return (
    <main
      aria-label={t(routePagesMessages.loadingError)}
      className="app-work-surface flex min-h-0 flex-1 items-center justify-center bg-app-surface px-6 py-12 text-center"
      role="alert"
    >
      <ErrorMessage
        detail={content.detail}
        message={content.message}
        onRetry={() => {
          void (content.restricted ? navigate("/") : navigate(0));
        }}
        title={content.title}
        actionLabel={t(
          content.restricted
            ? routePagesMessages.backToRooms
            : commonMessages.tryAgain,
        )}
      />
    </main>
  );
}

function ApplicationRouteErrorSurface({ tenantId }: { tenantId?: string }) {
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const { roomId } = useParams();
  const content = useRouteErrorContent(true);
  const roomsPath = tenantId
    ? roomId
      ? `/t/${tenantId}/rooms/${roomId}/chat`
      : `/t/${tenantId}/rooms`
    : undefined;
  const showRoomList = Boolean(
    tenantId && location.pathname.startsWith(`/t/${tenantId}/rooms`),
  );

  return (
    <div className="app-shell flex h-dvh min-h-0 overflow-hidden bg-app-canvas text-app-ink">
      <aside
        aria-label={t(navigationMessages.sidebar)}
        className="app-navigation hidden shrink-0 bg-app-sidebar md:flex"
      >
        <nav
          aria-label={t(navigationMessages.primary)}
          className="app-primary-navigation flex w-14 flex-col items-center bg-app-rail py-3"
        >
          <BrandMark className="size-8" />
          <div className="mt-4 flex w-full flex-1 flex-col items-center gap-2">
            <ErrorRailLink
              icon={<Icon icon={Message01Icon} size={16} />}
              label={t(routePagesMessages.rooms)}
              to={roomsPath}
            />
            <div className="mt-auto">
              <ErrorRailLink
                icon={<Icon icon={Settings01Icon} size={16} />}
                label={t(settingsMessages.title)}
                to={tenantId ? `/t/${tenantId}/settings` : undefined}
              />
            </div>
          </div>
        </nav>
        {showRoomList ? (
          <nav
            aria-label={t(routePagesMessages.roomNavigation)}
            className="app-secondary-navigation flex w-[248px] flex-col border-r border-border/60 bg-app-sidebar"
          >
            <div className="px-3 pb-1 pt-4">
              <h2 className="text-lg tracking-normal text-foreground">
                {t(navigationMessages.messages)}
              </h2>
            </div>
            <div className="px-3 py-4">
              <p className="text-sm text-muted-foreground">
                {t(routePagesMessages.rooms)}
              </p>
            </div>
          </nav>
        ) : null}
      </aside>
      <div className="app-work-surface flex min-w-0 flex-1 flex-col">
        <header className="flex h-(--app-header-height) shrink-0 items-center border-b border-border/60 bg-app-sidebar px-4 md:hidden">
          <BrandMark className="size-8" />
          <span className="ml-3 text-sm font-medium">Linger</span>
        </header>
        <main
          aria-label={t(routePagesMessages.loadingError)}
          className="app-work-surface flex min-h-0 flex-1 items-center justify-center bg-app-surface px-6 py-12 text-center"
          role="alert"
        >
          <ErrorMessage
            detail={content.detail}
            message={content.message}
            onRetry={() => {
              void (content.restricted ? navigate("/") : navigate(0));
            }}
            title={content.title}
            actionLabel={t(
              content.restricted
                ? routePagesMessages.backToRooms
                : commonMessages.tryAgain,
            )}
          />
        </main>
      </div>
    </div>
  );
}

function ErrorRailLink({
  icon,
  label,
  to,
}: {
  icon: React.ReactNode;
  label: string;
  to?: string;
}) {
  if (!to) {
    return (
      <span
        aria-label={label}
        className="flex size-8 items-center justify-center rounded-full text-muted-foreground/40"
        title={label}
      >
        {icon}
      </span>
    );
  }

  return (
    <NavLink
      aria-label={label}
      className={({ isActive }) =>
        `flex size-8 items-center justify-center rounded-full transition-colors duration-150 ${
          isActive
            ? "bg-sidebar-muted text-foreground"
            : "text-muted-foreground hover:text-foreground"
        }`
      }
      title={label}
      to={to}
    >
      {icon}
    </NavLink>
  );
}

function ErrorMessage({
  detail,
  message,
  onRetry,
  title,
  actionLabel,
}: {
  actionLabel: string;
  detail?: string;
  message: string;
  onRetry: () => void;
  title: string;
}) {
  return (
    <div className="max-w-md">
      <h1 className="text-lg">{title}</h1>
      <p className="mt-2 text-sm leading-6 text-app-muted" title={detail}>
        {message}
      </p>
      <Button className="mt-5" onClick={onRetry}>
        {actionLabel}
      </Button>
    </div>
  );
}

function useRouteErrorContent(fullPage: boolean) {
  const t = useT();
  const error = useRouteError();
  const status =
    isRouteErrorResponse(error) || error instanceof TeamHubError
      ? error.status
      : undefined;
  const { pathname } = useLocation();
  const restricted = status === 403 || status === 404;
  if (restricted)
    return {
      restricted: true,
      title: t(
        pathname.includes("/rooms/")
          ? routePagesMessages.roomRestrictedTitle
          : routePagesMessages.pageRestrictedTitle,
      ),
      message: t(routePagesMessages.restrictedBody),
    };
  // The reader gets a generic body; the raw error stays on hover for support.
  const detail = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`.trim()
    : error instanceof Error
      ? error.message
      : undefined;

  return {
    restricted: false,
    detail,
    message: t(routePagesMessages.loadFailedBody),
    title: t(
      fullPage
        ? routePagesMessages.teamHubUnavailableTitle
        : routePagesMessages.viewLoadFailedTitle,
    ),
  };
}
