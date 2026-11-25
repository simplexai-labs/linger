import { PlugSocketIcon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { useT } from "@/i18n/use-translation";
import { cn } from "@/lib/cn";
import { useCallback, useState } from "react";

import { connectorMessages as m } from "./connectors.messages";

const SIZES = {
  md: { icon: 20, image: "size-6", text: "text-xs" },
  profile: { icon: 15, image: "size-4", text: "text-[10px]" },
  sm: { icon: 12, image: "size-3", text: "text-[9px]" },
} as const;

function appMonogram(name: string) {
  const trimmed = name.trim();
  if (!trimmed) return "";
  return trimmed.charAt(0).toUpperCase();
}

export function AppLogo({
  name,
  size = "md",
  url,
}: {
  name: string;
  size?: keyof typeof SIZES;
  url?: string;
}) {
  const [loadedUrl, setLoadedUrl] = useState<string>();
  const [failedUrl, setFailedUrl] = useState<string>();
  const t = useT();
  const isLoaded = Boolean(url && loadedUrl === url);
  const showImage = Boolean(url && failedUrl !== url);
  const monogram = size === "sm" ? "" : appMonogram(name);

  // A cached image may already be complete before React attaches onLoad.
  const handleImageRef = useCallback(
    (node: HTMLImageElement | null) => {
      if (!node || !url || !node.complete) return;
      if (node.naturalWidth > 0) setLoadedUrl(url);
      else setFailedUrl(url);
    },
    [url],
  );

  return (
    <span
      className={cn(
        "relative inline-flex items-center justify-center",
        SIZES[size].image,
      )}
    >
      {!isLoaded ? (
        <span
          aria-label={t(m.appIcon, { name })}
          className={cn(
            "inline-flex size-full items-center justify-center text-muted-foreground",
            monogram && "rounded-md bg-muted font-semibold leading-none",
          )}
          role="img"
        >
          {monogram ? (
            <span aria-hidden="true" className={SIZES[size].text}>
              {monogram}
            </span>
          ) : (
            <Icon icon={PlugSocketIcon} size={SIZES[size].icon} />
          )}
        </span>
      ) : null}
      {showImage ? (
        <img
          alt=""
          className={cn(
            SIZES[size].image,
            "object-contain",
            isLoaded
              ? "opacity-100"
              : "pointer-events-none absolute inset-0 opacity-0",
          )}
          decoding="async"
          onError={() => setFailedUrl(url)}
          onLoad={(event) => {
            if (event.currentTarget.naturalWidth > 0) {
              setLoadedUrl(url);
            } else {
              setFailedUrl(url);
            }
          }}
          ref={handleImageRef}
          referrerPolicy="no-referrer"
          src={url}
        />
      ) : null}
    </span>
  );
}

/**
 * A logo in the tile Connectors draws app logos in; `small` fits it beside a
 * dialog title. The name always sits beside it, so the tile is decorative.
 */
export function AppLogoTile({
  name,
  small = false,
  url,
}: {
  name: string;
  small?: boolean;
  url?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-lg bg-card has-[img]:bg-(--app-logo-tile) text-foreground shadow-outline ${small ? "size-7" : "size-10"}`}
    >
      <AppLogo name={name} size={small ? "profile" : "md"} url={url} />
    </span>
  );
}
