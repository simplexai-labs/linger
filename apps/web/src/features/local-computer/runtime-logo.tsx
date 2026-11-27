import type { TeamHubLocalRuntimeType } from "@/features/teamhub/teamhub-types";
import { cn } from "@/lib/cn";

import antigravityLogo from "./runtime-logos/antigravity.svg";
import claudeLogo from "./runtime-logos/claude.svg";
import codexLogo from "./runtime-logos/codex.svg";
import piLogo from "./runtime-logos/pi.svg";

const logos: Record<TeamHubLocalRuntimeType, string> = {
  antigravity: antigravityLogo,
  claude: claudeLogo,
  codex: codexLogo,
  pi: piLogo,
};

/** The Runtime's own mark. Its name always sits beside it, so the mark is
 * decorative. */
export function RuntimeLogo({
  active = true,
  className,
  size = 18,
  type,
}: {
  active?: boolean;
  className?: string;
  size?: number;
  type: TeamHubLocalRuntimeType;
}) {
  return (
    <img
      alt=""
      aria-hidden
      className={cn(
        "shrink-0 object-contain transition-[filter,opacity] duration-150",
        !active && "opacity-45 grayscale",
        className,
      )}
      height={size}
      src={logos[type]}
      width={size}
    />
  );
}
