import type { TeamHubLocalRuntimeType } from "@/features/teamhub/teamhub-types";

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
  size = 18,
  type,
}: {
  size?: number;
  type: TeamHubLocalRuntimeType;
}) {
  return (
    <img
      alt=""
      className="shrink-0 object-contain"
      height={size}
      src={logos[type]}
      width={size}
    />
  );
}
