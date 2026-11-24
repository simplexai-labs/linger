export const DEV_USAGE: string;

export interface DevCliOptions {
  help: boolean;
  server: string | undefined;
  quickInstall: boolean;
  checkout: string | undefined;
  localmodels: string | undefined;
  localmodelsPython: string | undefined;
  debug: string | undefined;
  profile: string;
  reset: boolean;
  skipDaemon: boolean;
  withComputerTools: boolean;
  watch: boolean;
  dryRun: boolean;
  electronArgs: string[];
}

export interface DevSession {
  mode: "server" | "quick-install" | "default";
  profile: string;
  profileRoot: string;
  userData: string;
  home: string;
  serverUrl: string | null;
  checkout: string | null;
  localmodels: { python: string; moduleDir: string } | null;
  debug: string | null;
  hostTarget: string;
  watch: boolean;
  reset: boolean;
  skipDaemon: boolean;
  withComputerTools: boolean;
  electronArgs: string[];
  electronEnv: Record<string, string | undefined>;
}

export function parseDevArgs(argv: readonly string[]): DevCliOptions;

export function resolveLocalmodelsPython(
  moduleDir: string,
  explicitPython: string | undefined,
  deps?: {
    exists?: (target: string) => boolean;
    platform?: NodeJS.Platform;
    findOnPath?: (name: string) => string | undefined;
  },
): string;

export function resolveDevSession(
  options: DevCliOptions,
  deps: {
    repoRoot: string;
    env?: Readonly<Record<string, string | undefined>>;
    exists?: (target: string) => boolean;
    platform?: NodeJS.Platform;
    arch?: string;
    findOnPath?: (name: string) => string | undefined;
  },
): DevSession;

export function classifyWatchEvent(
  area: "installer" | "daemon" | "teamhub-cli",
  filename: string | null | undefined,
): "installer" | "daemon" | "teamhub-cli" | null;
