import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";

import { createAppRoutes, InitialAppLoading } from "@/app/router";
import { startTeamHubSessionActivity } from "@/app/teamhub-session-activity";
import { startTeamHubAuthenticationRuntime } from "@/app/teamhub-authentication-runtime";
import { createAppQueryClient } from "@/app/query-client";
import { markDesktopShell } from "@/app/desktop-shell";
import { reportThemeToDesktop } from "@/app/desktop-theme";
// Fonts load from JS so Vite fingerprints their files; a CSS @import is inlined
// by Tailwind without rewriting the relative font URLs.
import "@fontsource-variable/geist";
import "@fontsource-variable/roboto-slab";
import "@/app/globals.css";
import { loadHanFont } from "@/app/han-font";
import { restoreTheme } from "@/app/theme";
import { installVitePreloadRecovery } from "@/app/vite-preload-recovery";
import { DesktopConnectorReturn } from "@/features/apps/desktop-connector-return";
import { createBrowserTeamHubRuntime } from "@/features/teamhub/browser-teamhub-runtime";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { commonMessages } from "@/i18n/common.messages";
import { reportLanguageToDesktop } from "@/i18n/desktop-language";
import { restoreLanguage } from "@/i18n/language";
import { useT } from "@/i18n/use-translation";

installVitePreloadRecovery({ buildId: import.meta.url });
markDesktopShell();
loadHanFont(navigator.languages);
// index.html already put the remembered theme on screen before the first
// paint; from here it follows the choice, the system and other tabs.
restoreTheme();
reportThemeToDesktop();

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Web app root element was not found.");
}

const root = createRoot(rootElement);
// The remembered language is loaded before the first paint, so its reader
// never sees the interface flash by in English. English loads nothing.
void restoreLanguage().then(() => {
  reportLanguageToDesktop();
  root.render(
    <StrictMode>
      <InitialAppLoading />
    </StrictMode>,
  );
  startBrowserApp().catch(() => {
    root.render(
      <StrictMode>
        <AppUnavailable />
      </StrictMode>,
    );
  });
});

function AppUnavailable() {
  const t = useT();
  return (
    <main
      className="flex min-h-dvh items-center justify-center bg-app-canvas px-6 text-center text-app-ink"
      role="alert"
    >
      <div>
        <h1 className="text-lg">{t(commonMessages.unavailableTitle)}</h1>
        <p className="mt-2 text-sm text-app-muted">
          {t(commonMessages.unavailableBody)}
        </p>
        <button
          className="mt-5 min-h-10 bg-app-action px-3 text-[14px] font-medium text-app-action-foreground hover:bg-app-action-hover [border-radius:var(--app-button-radius-large)]"
          onClick={() => globalThis.location.reload()}
          type="button"
        >
          {t(commonMessages.tryAgain)}
        </button>
      </div>
    </main>
  );
}

async function startBrowserApp() {
  const queryClient = createAppQueryClient();
  const runtime = createBrowserTeamHubRuntime();
  const router = createBrowserRouter(createAppRoutes(queryClient, runtime));

  startTeamHubAuthenticationRuntime({
    currentLocation: () => router.state.location,
    navigate: async (to, options) => await router.navigate(to, options),
    probeSession: async () => {
      await teamHubData(runtime.client.api.GET("/v0/session"));
    },
    queryClient,
  });

  startTeamHubSessionActivity({
    queryClient,
    renewSession: () => teamHubData(runtime.client.api.POST("/v0/session")),
  });

  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <DesktopConnectorReturn />
          <RouterProvider router={router} />
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}
