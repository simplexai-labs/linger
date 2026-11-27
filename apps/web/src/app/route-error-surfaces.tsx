import { Message01Icon, Settings01Icon } from "@hugeicons/core-free-icons";
import { useEffect, useRef } from "react";
import {
  isRouteErrorResponse,
  NavLink,
  useLocation,
  useNavigate,
  useParams,
  useRouteError,
} from "react-router";

import {
  TeamHubError,
  TeamHubTransportError,
} from "@/features/teamhub/teamhub-client";
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

const TRANSIENT_UNAVAILABLE_STATUSES = new Set([502, 503, 504]);
const RECOVERY_BACKOFF_MS = [2_000, 3_000, 5_000, 5_000, 10_000] as const;
const RECOVERY_PROBE_TIMEOUT_MS = 5_000;
const AUTO_RELOAD_STORAGE_KEY = "linger:route-error-auto-reload";
const AUTO_RELOAD_WINDOW_MS = 60_000;
const AUTO_RELOAD_MAX_ATTEMPTS = 2;

interface AutoReloadRecord {
  at: number;
  count: number;
  path: string;
}

function readAutoReloadRecord(pathname: string): AutoReloadRecord | undefined {
  try {
    const raw = window.sessionStorage.getItem(AUTO_RELOAD_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<AutoReloadRecord>;
    if (
      parsed.path !== pathname ||
      typeof parsed.count !== "number" ||
      typeof parsed.at !== "number" ||
      Date.now() - parsed.at >= AUTO_RELOAD_WINDOW_MS
    ) {
      return undefined;
    }
    return { path: parsed.path, count: parsed.count, at: parsed.at };
  } catch {
    return undefined;
  }
}

function autoReloadBudgetExhausted(pathname: string): boolean {
  const record = readAutoReloadRecord(pathname);
  return record !== undefined && record.count >= AUTO_RELOAD_MAX_ATTEMPTS;
}

function recordAutoReload(pathname: string): void {
  try {
    const previous = readAutoReloadRecord(pathname);
    const next: AutoReloadRecord = {
      path: pathname,
      count: (previous?.count ?? 0) + 1,
      at: Date.now(),
    };
    window.sessionStorage.setItem(
      AUTO_RELOAD_STORAGE_KEY,
      JSON.stringify(next),
    );
  } catch {
    // Ignore storage failures in restricted browsing contexts.
  }
}

function clearAutoReloadRecord(): void {
  try {
    window.sessionStorage.removeItem(AUTO_RELOAD_STORAGE_KEY);
  } catch {
    // Ignore storage failures in restricted browsing contexts.
  }
}

function isTransientUnavailableError(error: unknown): boolean {
  if (error instanceof TeamHubTransportError) return true;
  if (error instanceof TeamHubError) {
    return TRANSIENT_UNAVAILABLE_STATUSES.has(error.status);
  }
  if (isRouteErrorResponse(error)) {
    return TRANSIENT_UNAVAILABLE_STATUSES.has(error.status);
  }
  return false;
}

async function probeBackendReady(signal: AbortSignal): Promise<boolean> {
  const timeout = new AbortController();
  const timerId = window.setTimeout(() => {
    timeout.abort();
  }, RECOVERY_PROBE_TIMEOUT_MS);
  const probeSignal = AbortSignal.any([signal, timeout.signal]);
  try {
    const response = await fetch("/readyz", {
      method: "HEAD",
      cache: "no-store",
      signal: probeSignal,
    });
    await response.body?.cancel().catch(() => {});
    if (response.ok) return true;
    if (response.status !== 404) return false;
    // Older servers without /readyz fall back to /v0/me; any non-5xx reply
    // (such as 200 or 401) confirms TeamHub is reachable again.
    const fallback = await fetch("/v0/me", {
      method: "GET",
      cache: "no-store",
      signal: probeSignal,
    });
    await fallback.body?.cancel().catch(() => {});
    return fallback.status < 500;
  } finally {
    window.clearTimeout(timerId);
  }
}

function ApplicationRouteErrorSurface({ tenantId }: { tenantId?: string }) {
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const { roomId } = useParams();
  const content = useRouteErrorContent(true);
  const cancelRecoveryRef = useRef<(() => void) | null>(null);
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);

  useEffect(() => {
    if (
      !content.transientUnavailable ||
      autoReloadBudgetExhausted(location.pathname)
    ) {
      return;
    }

    let stopped = false;
    let attempt = 0;
    let timerId: number | undefined;
    let controller: AbortController | undefined;
    let waitingForVisibility = false;

    const onVisibilityChange = () => {
      if (stopped || document.visibilityState === "hidden") return;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      waitingForVisibility = false;
      void probe();
    };

    const cleanup = () => {
      stopped = true;
      if (timerId !== undefined) {
        window.clearTimeout(timerId);
        timerId = undefined;
      }
      if (waitingForVisibility) {
        document.removeEventListener("visibilitychange", onVisibilityChange);
        waitingForVisibility = false;
      }
      controller?.abort();
      controller = undefined;
    };

    const scheduleNext = () => {
      if (stopped) return;
      const delayMs =
        RECOVERY_BACKOFF_MS[
          Math.min(attempt, RECOVERY_BACKOFF_MS.length - 1)
        ] ?? 10_000;
      attempt += 1;
      timerId = window.setTimeout(() => {
        timerId = undefined;
        if (stopped) return;
        if (document.visibilityState === "hidden") {
          waitingForVisibility = true;
          document.addEventListener("visibilitychange", onVisibilityChange);
          return;
        }
        void probe();
      }, delayMs);
    };

    const probe = async () => {
      if (stopped) return;
      controller = new AbortController();
      try {
        const ready = await probeBackendReady(controller.signal);
        if (stopped) return;
        if (ready) {
          cleanup();
          recordAutoReload(location.pathname);
          void navigateRef.current(0);
          return;
        }
      } catch {
        if (stopped) return;
      } finally {
        controller = undefined;
      }
      scheduleNext();
    };

    cancelRecoveryRef.current = cleanup;
    scheduleNext();

    return () => {
      if (cancelRecoveryRef.current === cleanup) {
        cancelRecoveryRef.current = null;
      }
      cleanup();
    };
  }, [content.transientUnavailable, location.pathname]);

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
        <header className="flex h-(--app-header-height) shrink-0 items-center bg-app-sidebar px-4 md:hidden">
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
              cancelRecoveryRef.current?.();
              clearAutoReloadRecord();
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
      transientUnavailable: false,
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
    transientUnavailable: isTransientUnavailableError(error),
    detail,
    message: t(routePagesMessages.loadFailedBody),
    title: t(
      fullPage
        ? routePagesMessages.teamHubUnavailableTitle
        : routePagesMessages.viewLoadFailedTitle,
    ),
  };
}
