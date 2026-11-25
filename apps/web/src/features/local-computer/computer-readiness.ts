import type {
  TeamHubLocalComputerPage,
  TeamHubLocalRuntimeType,
  TeamHubTenantAgent,
} from "@/features/teamhub/teamhub-types";

import type { Message } from "@/i18n/messages";

import type { ComputerDisplayStatus } from "./computer-connection-status";
import { compareComputerVersion } from "./computer-version";
import { computersMessages } from "./computers.messages";

type LocalComputer = TeamHubLocalComputerPage["items"][number];
type RuntimeStatus = LocalComputer["runtimes"][number]["status"];

/** Order the page suggests AI apps in when several need the same step. */
export const appOrder: readonly TeamHubLocalRuntimeType[] = [
  "claude",
  "codex",
  "pi",
  "antigravity",
];

export const appNames = {
  claude: "Claude Code",
  codex: "Codex",
  pi: "Pi",
  antigravity: "Antigravity",
} satisfies Record<TeamHubLocalRuntimeType, string>;

export const appDescriptions = {
  claude: computersMessages.descriptionClaude,
  codex: computersMessages.descriptionCodex,
  pi: computersMessages.descriptionPi,
  antigravity: computersMessages.descriptionAntigravity,
} satisfies Record<TeamHubLocalRuntimeType, Message<string>>;

export const runtimeStatusLabels = {
  authentication_required: computersMessages.statusSignInRequired,
  error: computersMessages.statusCouldNotCheck,
  incompatible: computersMessages.updateNeeded,
  not_installed: computersMessages.notInstalled,
  ready: computersMessages.ready,
  unknown: computersMessages.statusChecking,
} satisfies Record<RuntimeStatus, Message<string>>;

export type ComputerReadiness =
  | { kind: "reconnecting" }
  | { kind: "offline" }
  | { kind: "update" }
  | { kind: "signIn"; app: TeamHubLocalRuntimeType }
  | { kind: "updateApp"; app: TeamHubLocalRuntimeType }
  | { kind: "check"; app: TeamHubLocalRuntimeType }
  | { kind: "setUp"; app: TeamHubLocalRuntimeType }
  | { kind: "ready"; app: TeamHubLocalRuntimeType };

export function appStatus(
  computer: LocalComputer,
  app: TeamHubLocalRuntimeType,
): RuntimeStatus {
  return (
    computer.runtimes.find((runtime) => runtime.type === app)?.status ??
    "not_installed"
  );
}

// The first Computer release that can run each app added after the first
// ones. An older Computer never reports the app, and installing the app
// cannot change that; only updating Linger there can.
const firstComputerVersion: Partial<Record<TeamHubLocalRuntimeType, string>> = {
  antigravity: "0.56.0",
};

/** Whether the Computer's Linger can run the app once it is installed. */
export function appSupported(
  computer: Pick<LocalComputer, "daemon_version" | "runtimes">,
  app: TeamHubLocalRuntimeType,
): boolean {
  const first = firstComputerVersion[app];
  if (!first || !computer.daemon_version) return true;
  // A build between releases may run it before its version says so.
  if (computer.runtimes.some((runtime) => runtime.type === app)) return true;
  const order = compareComputerVersion(computer.daemon_version, first);
  return order === undefined || order >= 0;
}

function firstApp(computer: LocalComputer, status: RuntimeStatus) {
  return appOrder.find((app) => appStatus(computer, app) === status);
}

/**
 * Picks which ready runtime represents this Computer in the summary pill:
 * first the Computer's live active model-source runtime, then the runtime its
 * Agents actually run on (preferring Another Me, then most-used).
 */
export function preferredComputerRuntime(
  agents: readonly TeamHubTenantAgent[],
  activeRuntime?: TeamHubLocalRuntimeType,
): TeamHubLocalRuntimeType | undefined {
  if (activeRuntime) return activeRuntime;
  const counts = new Map<TeamHubLocalRuntimeType, number>();
  let anotherMeRuntime: TeamHubLocalRuntimeType | undefined;
  for (const agent of agents) {
    if (agent.runtime.placement?.type !== "local") continue;
    const runtimeType = agent.runtime.placement.runtime_type;
    if (!runtimeType) continue;
    if (agent.agent_type === "anotherme") anotherMeRuntime = runtimeType;
    counts.set(runtimeType, (counts.get(runtimeType) ?? 0) + 1);
  }
  if (anotherMeRuntime) return anotherMeRuntime;
  let best: TeamHubLocalRuntimeType | undefined;
  let bestCount = 0;
  for (const app of appOrder) {
    const count = counts.get(app) ?? 0;
    if (count > bestCount) {
      best = app;
      bestCount = count;
    }
  }
  return best;
}

/**
 * One conclusion for the whole Computer: an Agent can run as soon as one AI
 * app is ready, so the other apps never make a ready Computer look broken.
 */
export function computerReadiness(
  computer: LocalComputer,
  displayStatus: ComputerDisplayStatus,
  preferredRuntime?: TeamHubLocalRuntimeType,
): ComputerReadiness {
  if (displayStatus === "reconnecting") return { kind: "reconnecting" };
  // The Runner Gateway turns away a Computer below the version floor, so it
  // reads offline until the update, which is the step that brings it back.
  if (computer.upgrade_required) return { kind: "update" };
  if (displayStatus === "offline") return { kind: "offline" };
  const ready =
    (preferredRuntime && appStatus(computer, preferredRuntime) === "ready"
      ? preferredRuntime
      : undefined) ?? firstApp(computer, "ready");
  if (ready) return { kind: "ready", app: ready };
  const signIn = firstApp(computer, "authentication_required");
  if (signIn) return { kind: "signIn", app: signIn };
  // An installed app that is too old or could not be checked is closer to
  // ready than an app the user has not installed yet.
  const outdated = firstApp(computer, "incompatible");
  if (outdated) return { kind: "updateApp", app: outdated };
  const unchecked =
    firstApp(computer, "error") ?? firstApp(computer, "unknown");
  if (unchecked) return { kind: "check", app: unchecked };
  return { kind: "setUp", app: "claude" };
}
