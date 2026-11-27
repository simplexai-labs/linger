import type { TeamHubLocalRuntimeType } from "@/features/teamhub/teamhub-types";
import { cn } from "@/lib/cn";

import type { ComputerPlatform } from "./computer-platform";
import chromeLogo from "./logos/chrome.svg";
import computerMacLogo from "./logos/computer-mac.svg";
import computerPcLogo from "./logos/computer-pc.svg";
import { RuntimeLogo } from "./runtime-logo";

const sizeClasses = {
  14: "size-3.5",
  16: "size-4",
  20: "size-5",
} as const;

/** Real product brand icon: full color when connected and ready, grayscale otherwise. */
export function AppBrandIcon({
  active,
  app,
  className,
  size = 20,
}: {
  active: boolean;
  app: TeamHubLocalRuntimeType;
  className?: string;
  size?: keyof typeof sizeClasses;
}) {
  return (
    <RuntimeLogo
      active={active}
      className={cn(sizeClasses[size], className)}
      size={size}
      type={app}
    />
  );
}

/** Real Google Chrome brand icon: full color while online, muted when offline. */
export function ChromeBrandIcon({
  active = true,
  className,
  size = 16,
}: {
  active?: boolean;
  className?: string;
  size?: keyof typeof sizeClasses;
}) {
  return (
    <img
      alt=""
      aria-hidden
      className={cn(
        "shrink-0 object-contain transition-[filter,opacity] duration-150",
        sizeClasses[size],
        !active && "opacity-45 grayscale",
        className,
      )}
      src={chromeLogo}
    />
  );
}

const deviceSizeClasses = {
  36: "size-9",
  44: "size-11",
  56: "size-14",
} as const;

/** Hardware silhouette for a Local Computer: sleek MacBook on macOS, modern display elsewhere. */
export function ComputerDeviceIcon({
  className,
  online = true,
  platform,
  size = 44,
}: {
  className?: string;
  online?: boolean;
  platform?: ComputerPlatform;
  size?: keyof typeof deviceSizeClasses;
}) {
  const src =
    platform === "linux" || platform === "win32"
      ? computerPcLogo
      : computerMacLogo;
  return (
    <img
      alt=""
      aria-hidden
      className={cn(
        "shrink-0 object-contain transition-[filter,opacity] duration-150",
        deviceSizeClasses[size],
        !online && "opacity-45 grayscale",
        className,
      )}
      src={src}
    />
  );
}
