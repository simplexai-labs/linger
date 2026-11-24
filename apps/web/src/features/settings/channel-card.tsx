import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { useState, type ReactNode } from "react";

import { Icon } from "@/components/ui/icon";
import { StatusPill } from "@/components/ui/status-pill";
import { ChannelBrandIcon } from "@/features/rooms/channel-icon";

export interface ChannelCardProps {
  channel: string;
  title: string;
  description: string;
  statusLabel: string;
  statusTone: "danger" | "info" | "neutral" | "success" | "warning";
  enabled: boolean;
  switchLabel: string;
  switchDisabled?: boolean;
  onToggle: () => void;
  /** Whether the channel has expandable configuration content. */
  hasConfiguration?: boolean;
  expandLabel?: string;
  /** Optional inline alert/status notice shown under the header even when collapsed. */
  notice?: ReactNode;
  /** Configuration sections shown inside the card when expanded. */
  children?: ReactNode;
}

/**
 * Unified expandable card shared by every channel in Settings › Channels.
 * Header layout stays identical across off and on states; enabling a channel
 * with configuration automatically expands its drawer, and the chevron lets
 * the user collapse or expand it at any time.
 */
export function ChannelCard({
  channel,
  title,
  description,
  statusLabel,
  statusTone,
  enabled,
  switchLabel,
  switchDisabled = false,
  onToggle,
  hasConfiguration = false,
  expandLabel,
  notice,
  children,
}: ChannelCardProps) {
  const [override, setOverride] = useState<{
    forEnabled: boolean;
    expanded: boolean;
  } | null>(null);
  const canExpand = hasConfiguration && Boolean(children);
  const isExpanded = canExpand
    ? override && override.forEnabled === enabled
      ? override.expanded
      : enabled
    : false;

  return (
    <section className="overflow-hidden rounded-2xl bg-card shadow-outline">
      <div className="flex items-center gap-3.5 px-5 py-4">
        <ChannelBrandIcon channel={channel} size={32} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[15px] font-medium leading-5 text-foreground">
              {title}
            </h2>
            <StatusPill tone={statusTone}>{statusLabel}</StatusPill>
          </div>
          <p className="mt-0.5 text-xs leading-[18px] text-muted-foreground">
            {description}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {canExpand ? (
            <button
              aria-expanded={isExpanded}
              aria-label={expandLabel ?? title}
              className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() =>
                setOverride({ forEnabled: enabled, expanded: !isExpanded })
              }
              type="button"
            >
              <Icon
                className={`transition-transform duration-150 ${isExpanded ? "rotate-0" : "-rotate-90"}`}
                icon={ArrowDown01Icon}
                size={15}
              />
            </button>
          ) : null}

          <button
            aria-checked={enabled}
            aria-label={switchLabel}
            className={`relative h-5 w-9 shrink-0 rounded-full shadow-xs transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${enabled ? "bg-primary" : "bg-input"}`}
            disabled={switchDisabled}
            onClick={onToggle}
            role="switch"
            type="button"
          >
            <span
              className={`absolute left-0 top-0.5 size-4 rounded-full bg-card shadow-xs transition-transform duration-150 ${enabled ? "translate-x-4.5" : "translate-x-0.5"}`}
            />
          </button>
        </div>
      </div>

      {notice ? <div className="px-5 pb-4">{notice}</div> : null}

      {isExpanded ? (
        <div className="border-t border-border/70 bg-muted/25 px-3.5 py-4">
          {children}
        </div>
      ) : null}
    </section>
  );
}
