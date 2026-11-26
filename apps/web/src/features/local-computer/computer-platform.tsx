import { useId, useRef } from "react";

import { useT } from "@/i18n/use-translation";
import { cn } from "@/lib/cn";

import { computerSetupMessages } from "./computer-setup.messages";

export type ComputerPlatform = "darwin" | "linux" | "win32";

const PLATFORM_OPTIONS: readonly { label: string; value: ComputerPlatform }[] =
  [
    { label: "macOS", value: "darwin" },
    { label: "Windows", value: "win32" },
    { label: "Linux", value: "linux" },
  ];

export function browserComputerPlatform(): ComputerPlatform {
  const platform = navigator.platform || navigator.userAgent;
  if (/windows|^win(?:32|64)/i.test(platform)) return "win32";
  if (/linux|x11/i.test(platform)) return "linux";
  return "darwin";
}

/**
 * The environment name a Web origin's Computer installs under, as the
 * installers derive it: the host's first label without "-linger",
 * "local" for loopback, or the dashed address for an IP, plus any non-default
 * port.
 */
export function computerEnvironmentName(origin: string): string {
  const url = new URL(origin);
  const host = url.hostname.toLowerCase();
  let name: string;
  if (
    ["localhost", "127.0.0.1", "[::1]"].includes(host) ||
    host.endsWith(".localhost")
  )
    name = "local";
  else if (host.startsWith("["))
    name = `ip-${host.slice(1, -1).replace(/[:.]/gu, "-")}`;
  else if (/^[0-9.]+$/u.test(host)) name = `ip-${host.replaceAll(".", "-")}`;
  else {
    name = host.split(".")[0]!;
    if (name !== "linger") name = name.replace(/-linger$/u, "");
  }
  return url.port ? `${name}-${url.port}` : name;
}

/**
 * Each environment's Computer has its own command, so Computers of several
 * environments can share one machine.
 */
export function computerCommand(): string {
  return `linger-computer-${computerEnvironmentName(window.location.origin)}`;
}

export function computerInstallCommand(platform: ComputerPlatform): string {
  const origin = window.location.origin;
  return platform === "win32"
    ? `irm '${origin}/install/linger-computer.ps1' | iex`
    : `curl -fsSL "${origin}/install/linger-computer.sh" | bash`;
}

export function ComputerPlatformSelector({
  value,
  onChange,
}: {
  value: ComputerPlatform | "";
  onChange: (platform: ComputerPlatform) => void;
}) {
  const t = useT();
  const labelId = useId();
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIndex = PLATFORM_OPTIONS.findIndex(
    (option) => option.value === value,
  );

  function selectIndex(index: number) {
    const nextIndex =
      (index + PLATFORM_OPTIONS.length) % PLATFORM_OPTIONS.length;
    onChange(PLATFORM_OPTIONS[nextIndex]!.value);
    buttonRefs.current[nextIndex]?.focus();
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span id={labelId}>{t(computerSetupMessages.operatingSystem)}</span>
      <div
        aria-labelledby={labelId}
        className="inline-flex rounded-lg border border-border bg-muted p-0.5"
        role="radiogroup"
      >
        {PLATFORM_OPTIONS.map((option, index) => {
          const checked = value === option.value;
          const focusable = checked || (activeIndex < 0 && index === 0);
          return (
            <button
              aria-checked={checked}
              className={cn(
                "inline-flex h-7 items-center rounded-md px-2.5 text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                checked
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
              key={option.value}
              onClick={() => onChange(option.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                  event.preventDefault();
                  selectIndex(index + 1);
                } else if (
                  event.key === "ArrowLeft" ||
                  event.key === "ArrowUp"
                ) {
                  event.preventDefault();
                  selectIndex(index - 1);
                }
              }}
              ref={(node) => {
                buttonRefs.current[index] = node;
              }}
              role="radio"
              tabIndex={focusable ? 0 : -1}
              type="button"
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
