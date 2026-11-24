import type { TeamHubLocalRuntimeType } from "@/features/teamhub/teamhub-types";

import { type ComputerPlatform, computerCommand } from "./computer-platform";
import { compareComputerVersion } from "./computer-version";
import type { DesktopComputer } from "./desktop-computer";

/**
 * The command that signs in to each AI app; Pi signs in with /login inside it,
 * and Antigravity opens its Google sign-in on its first start.
 */
export const loginCommands = {
  codex: "codex login",
  claude: "claude auth login",
  pi: "pi",
  antigravity: "agy",
} satisfies Record<TeamHubLocalRuntimeType, string>;

// The first Computer CLI with `runtime login`, which opens a Runtime with the
// bundled Node and launcher the Daemon uses instead of whatever is on PATH.
export const FIRST_RUNTIME_LOGIN_COMPUTER_VERSION = "0.59.0";

export interface SignInComputer {
  computer_id?: string;
  platform?: string;
  daemon_version?: string;
}

// On Windows a bare command can start on an older system Node, so a CLI that
// has `runtime login` signs in exactly as the Daemon starts the Runtime. The
// Desktop app's own Computer has no such CLI on PATH and no bundled Node, and
// until Desktop reports which Computer is its own, any Computer may be it.
// `desktop` is `useDesktopComputer()`: undefined in a browser.
export function signInCommand(
  runtimeType: TeamHubLocalRuntimeType,
  computer: SignInComputer | undefined,
  desktop?: Pick<DesktopComputer, "status">,
): string {
  if (desktop && !desktop.status) return loginCommands[runtimeType];
  const order = computer?.daemon_version
    ? compareComputerVersion(
        computer.daemon_version,
        FIRST_RUNTIME_LOGIN_COMPUTER_VERSION,
      )
    : undefined;
  if (
    computer?.platform === "win32" &&
    order !== undefined &&
    order >= 0 &&
    computer.computer_id !== desktop?.status?.computerId
  )
    return `${computerCommand()} runtime login ${runtimeType}`;
  return loginCommands[runtimeType];
}

// Local Computer finds these installs in its default search folders
// (%APPDATA%\npm and ~/.local/bin) without a restart.
export function installCommand(
  runtimeType: TeamHubLocalRuntimeType,
  platform: ComputerPlatform | undefined,
): string {
  if (runtimeType === "claude")
    return platform === "win32"
      ? "irm https://claude.ai/install.ps1 | iex"
      : "curl -fsSL https://claude.ai/install.sh | bash";
  if (runtimeType === "antigravity")
    return platform === "win32"
      ? "irm https://antigravity.google/cli/install.ps1 | iex"
      : "curl -fsSL https://antigravity.google/cli/install.sh | bash";
  return runtimeType === "codex"
    ? "npm install -g @openai/codex"
    : "npm install -g @earendil-works/pi-coding-agent";
}

// Antigravity's install scripts exit without upgrading when `agy` is already
// installed, so an outdated installation updates through `agy update`.
export function updateCommand(
  runtimeType: TeamHubLocalRuntimeType,
  platform: ComputerPlatform | undefined,
): string {
  if (runtimeType === "antigravity") return "agy update";
  return installCommand(runtimeType, platform);
}
