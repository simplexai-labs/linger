import { Message01Icon } from "@hugeicons/core-free-icons";

import { Icon } from "@/components/ui/icon";

import { ActorAvatar } from "./members/actor-avatar";

interface ChannelBrandIconProps {
  channel: string;
  size?: number;
  className?: string;
}

/** Crisp brand badge icon for external IM channels (WeChat, iMessage). */
export function ChannelBrandIcon({
  channel,
  size = 16,
  className = "",
}: ChannelBrandIconProps) {
  if (channel === "wechat") {
    return (
      <svg
        aria-hidden="true"
        className={`shrink-0 ${className}`}
        height={size}
        viewBox="0 0 24 24"
        width={size}
      >
        <rect fill="#07C160" height="24" rx="6" width="24" />
        {/* Larger back speech bubble */}
        <path
          d="M9.6 5.6c-3.15 0-5.7 2.13-5.7 4.75 0 1.49.82 2.82 2.1 3.7l-.52 1.62 1.84-.95c.72.24 1.49.38 2.28.38.3 0 .59-.02.88-.06-.18-.48-.28-1-.28-1.54 0-2.55 2.4-4.62 5.36-4.62.28 0 .56.02.83.06-.62-1.95-2.78-3.34-6.79-3.34z"
          fill="#FFFFFF"
        />
        <circle cx="7.7" cy="9.4" fill="#07C160" r="0.85" />
        <circle cx="11.4" cy="9.4" fill="#07C160" r="0.85" />
        {/* Smaller front speech bubble */}
        <path
          d="M15.4 10.1c-2.55 0-4.62 1.72-4.62 3.85 0 2.13 2.07 3.85 4.62 3.85.64 0 1.25-.11 1.81-.3l1.48.77-.42-1.31c1.05-.72 1.75-1.8 1.75-3.01 0-2.13-2.07-3.85-4.62-3.85z"
          fill="#FFFFFF"
        />
        <circle cx="13.9" cy="13.3" fill="#07C160" r="0.72" />
        <circle cx="16.9" cy="13.3" fill="#07C160" r="0.72" />
      </svg>
    );
  }

  if (channel === "imessage") {
    return (
      <svg
        aria-hidden="true"
        className={`shrink-0 ${className}`}
        height={size}
        viewBox="0 0 24 24"
        width={size}
      >
        <rect fill="#34C759" height="24" rx="6" width="24" />
        <path
          d="M12 5.4c-3.98 0-7.2 2.66-7.2 5.95 0 1.82.99 3.45 2.55 4.54-.17 1.15-.74 2.13-1.45 2.68-.18.14-.09.43.14.43 1.41 0 2.65-.56 3.55-1.22.75.23 1.56.35 2.41.35 3.98 0 7.2-2.66 7.2-5.95S15.98 5.4 12 5.4z"
          fill="#FFFFFF"
        />
      </svg>
    );
  }

  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-md bg-muted text-foreground ${className}`}
      style={{ height: size, width: size }}
    >
      <Icon icon={Message01Icon} size={Math.round(size * 0.65)} />
    </span>
  );
}

interface ChannelAvatarProps {
  actorId?: string;
  animate?: boolean;
  channel: string;
  name: string;
  size?: "nav" | "sm" | "md";
}

/** Another Me avatar with the external IM platform badge at the bottom-right corner. */
export function ChannelAvatar({
  actorId,
  animate = false,
  channel,
  name,
  size = "nav",
}: ChannelAvatarProps) {
  const badgeSize = size === "md" ? 18 : 15;
  return (
    <span className="relative inline-flex shrink-0">
      <ActorAvatar
        actorId={actorId}
        animate={animate}
        kind="agent"
        name={name}
        showTitle={false}
        size={size}
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-0.5 -right-0.5 flex items-center justify-center rounded-[5px] bg-white p-[1.5px] shadow-xs ring-1 ring-black/5"
        data-channel-badge={channel}
      >
        <ChannelBrandIcon channel={channel} size={badgeSize} />
      </span>
    </span>
  );
}
