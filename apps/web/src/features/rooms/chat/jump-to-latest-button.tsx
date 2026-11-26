import { ArrowDown02Icon } from "@hugeicons/core-free-icons";

import { Icon } from "@/components/ui/icon";
import { useT } from "@/i18n/use-translation";

import { RunningDots } from "../task-sidebar/running-dots";
import { chatMessages } from "./chat.messages";

const BOTTOM_OFFSET_CLASSES = {
  default: "bottom-3",
  raised: "bottom-12",
  stacked: "bottom-20",
} as const;

export type JumpToLatestOffset = keyof typeof BOTTOM_OFFSET_CLASSES;

/**
 * Floats above the composer while the reader is away from the newest Message.
 * Typing dots replace the arrow while an Agent in the Room is still working, so
 * the reader knows more is arriving below.
 */
export function JumpToLatestButton({
  agentWorking,
  bottomOffset = "default",
  onClick,
}: {
  agentWorking: boolean;
  /** Elevates the button above active bottom docks so floating controls never overlap. */
  bottomOffset?: JumpToLatestOffset;
  onClick: () => void;
}) {
  const t = useT();
  return (
    <button
      aria-label={t(chatMessages.jumpToLatest)}
      className={`app-floating-enter absolute ${BOTTOM_OFFSET_CLASSES[bottomOffset]} left-1/2 z-10 inline-flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-md transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
      data-agent-working={agentWorking}
      data-bottom-offset={bottomOffset}
      onClick={onClick}
      type="button"
    >
      {agentWorking ? (
        <RunningDots size={5} />
      ) : (
        <Icon icon={ArrowDown02Icon} size={16} />
      )}
    </button>
  );
}
