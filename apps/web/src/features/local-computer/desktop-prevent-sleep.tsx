import { PowerIcon } from "@hugeicons/core-free-icons";
import { type ReactNode, useEffect, useState } from "react";

import { Icon } from "@/components/ui/icon";
import { useT } from "@/i18n/use-translation";

import { RowMark } from "./computer-row";
import { computersMessages } from "./computers.messages";

// The desktop app's settings bridge (`window.lingerDesktop.settings`); absent
// in a browser and missing `preventSleep` in desktop builds that predate it.
interface DesktopSettingsSnapshot {
  readonly preventSleep?: boolean;
}

interface DesktopSettingsApi {
  get(): Promise<DesktopSettingsSnapshot>;
  set(patch: { preventSleep: boolean }): Promise<DesktopSettingsSnapshot>;
  onChange?(callback: (settings: DesktopSettingsSnapshot) => void): () => void;
}

function desktopSettingsApi(): DesktopSettingsApi | undefined {
  return typeof window === "undefined"
    ? undefined
    : (window as { lingerDesktop?: { settings?: DesktopSettingsApi } })
        .lingerDesktop?.settings;
}

/**
 * Mirrors the desktop tray's Prevent Sleep toggle inside Settings › Computers
 * for this computer, staying synced with tray changes.
 */
export function DesktopPreventSleep({
  renderGroup,
}: {
  renderGroup?: (content: ReactNode) => ReactNode;
}) {
  const t = useT();
  const [api] = useState(desktopSettingsApi);
  const [preventSleep, setPreventSleep] = useState<boolean>();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (typeof api?.get !== "function" || typeof api.set !== "function") return;
    let active = true;
    let receivedUpdate = false;
    void api
      .get()
      .then((next) => {
        if (
          active &&
          !receivedUpdate &&
          typeof next?.preventSleep === "boolean"
        )
          setPreventSleep(next.preventSleep);
      })
      .catch(() => undefined);
    const off =
      typeof api.onChange === "function"
        ? api.onChange((next) => {
            if (typeof next?.preventSleep === "boolean") {
              receivedUpdate = true;
              setPreventSleep(next.preventSleep);
            }
          })
        : undefined;
    return () => {
      active = false;
      off?.();
    };
  }, [api]);

  if (preventSleep === undefined || typeof api?.set !== "function") return null;

  const toggle = (next: boolean) => {
    setFailed(false);
    setSaving(true);
    api
      .set({ preventSleep: next })
      .then((updated) => {
        if (typeof updated?.preventSleep === "boolean")
          setPreventSleep(updated.preventSleep);
        else setPreventSleep(next);
      })
      .catch(() => setFailed(true))
      .finally(() => setSaving(false));
  };

  const content = (
    <div>
      <label className="flex min-h-14 w-full cursor-pointer items-center gap-3 rounded-lg py-2 pr-2.5 pl-2 transition-colors duration-150 hover:bg-sidebar-muted/60">
        <RowMark>
          <Icon icon={PowerIcon} size={20} />
        </RowMark>
        <span className="min-w-0 flex-1 text-left">
          <span className="block text-sm text-foreground">
            {t(computersMessages.preventSleep)}
          </span>
          <span className="block text-sm text-muted-foreground">
            {t(computersMessages.preventSleepHint)}
          </span>
        </span>
        <input
          aria-label={t(computersMessages.preventSleep)}
          checked={preventSleep}
          className="agent-connector-switch"
          disabled={saving}
          onChange={(event) => toggle(event.target.checked)}
          role="switch"
          type="checkbox"
        />
      </label>
      {failed ? (
        <p className="px-2 pt-1 text-xs text-app-danger" role="alert">
          {t(computersMessages.preventSleepFailed)}
        </p>
      ) : null}
    </div>
  );

  return renderGroup ? renderGroup(content) : content;
}
