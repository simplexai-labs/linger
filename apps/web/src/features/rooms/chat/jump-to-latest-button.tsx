import { ArrowDown02Icon } from "@hugeicons/core-free-icons";

import { Icon } from "@/components/ui/icon";
import { useT } from "@/i18n/use-translation";

import { RunningDots } from "../task-sidebar/running-dots";
import { chatMessages } from "./chat.messages";

/**
 * Floats above the composer while the reader is away from the newest Message.
 * Typing dots replace the arrow while an Agent in the Room is still working, so
 * the reader knows more is arriving below.
 */
export function JumpToLatestButton({
  agentWorking,
  onClick,
}: {
  agentWorking: boolean;
  onClick: () => void;
}) {
  const t = useT();
  return (
    <button
      aria-label={t(chatMessages.jumpToLatest)}
      className="app-floating-enter absolute bottom-3 left-1/2 z-10 inline-flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-md transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-agent-working={agentWorking}
      data-jump-to-latest=""
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
