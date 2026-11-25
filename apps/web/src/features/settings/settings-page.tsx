import {
  AiChipIcon,
  Key01Icon,
  LanguageSkillIcon,
  LaptopIcon,
  Moon02Icon,
  UserIcon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { Suspense, type ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router";

import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/i18n/use-translation";

import { SaveDiagnosticsButton } from "./save-diagnostics-button";
import { settingsMessages } from "./settings.messages";

/** Settings is a page in the Space shell: its own sections beside the rail. */
export function SettingsLayout() {
  const { pathname } = useLocation();
  const t = useT();
  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside
        aria-label={t(settingsMessages.navigation)}
        className="flex shrink-0 flex-col border-b border-border px-3 py-4 md:w-[228px] md:border-r md:border-b-0"
      >
        <div className="flex items-center pt-0.5 pb-3.5">
          <h1 className="text-lg">{t(settingsMessages.title)}</h1>
        </div>
        <nav
          aria-label={t(settingsMessages.sections)}
          className="workspace-scrollbar flex min-h-0 flex-1 flex-wrap gap-1 md:flex-col md:flex-nowrap md:gap-0.5 md:overflow-y-auto"
        >
          <SettingsLink
            icon={<Icon icon={UserIcon} size={14} />}
            label={t(settingsMessages.profile)}
            to="account"
          />
          <SettingsLink
            icon={<Icon icon={Key01Icon} size={14} />}
            label={t(settingsMessages.security)}
            to="security"
          />
          <SettingsLink
            icon={<Icon icon={LaptopIcon} size={14} />}
            label={t(settingsMessages.computers)}
            to="computers"
          />
          <SettingsLink
            icon={<Icon icon={AiChipIcon} size={14} />}
            label={t(settingsMessages.models)}
            to="models"
          />
          <SettingsLink
            icon={<Icon icon={LanguageSkillIcon} size={14} />}
            label={t(settingsMessages.language)}
            to="language"
          />
          <SettingsLink
            icon={<Icon icon={Moon02Icon} size={14} />}
            label={t(settingsMessages.appearance)}
            to="appearance"
          />
        </nav>
        <SaveDiagnosticsButton />
      </aside>
      <div className="workspace-content-viewport workspace-scrollbar flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto px-6 py-6 [scrollbar-gutter:stable] md:px-8">
        <Suspense
          fallback={
            <SettingsSectionLoading
              computers={pathname.endsWith("/settings/computers")}
            />
          }
        >
          <Outlet />
        </Suspense>
      </div>
    </div>
  );
}

function SettingsSectionLoading({ computers }: { computers: boolean }) {
  const t = useT();
  const label = t(
    computers
      ? settingsMessages.loadingComputers
      : settingsMessages.loadingContent,
  );
  return (
    <div
      aria-busy="true"
      aria-label={label}
      className="mx-auto w-full max-w-(--app-settings-width) space-y-4"
      role="status"
    >
      <span className="sr-only">{label}...</span>
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

function SettingsLink({
  icon,
  label,
  to,
}: {
  icon: ReactNode;
  label: string;
  to: string;
}) {
  return (
    <NavLink
      className={({ isActive }) =>
        `flex h-[33px] shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none md:gap-2 md:text-sm ${
          isActive
            ? "bg-muted text-foreground"
            : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        }`
      }
      replace
      to={to}
    >
      {icon}
      {label}
    </NavLink>
  );
}
