export const DAEMON_TARGETS: Record<string, { goos: string; goarch: string }>;
export function daemonFileName(target: string): string;
export function run(
  command: string,
  args: string[],
  options?: Record<string, unknown>,
): Promise<void>;
export function buildDaemon(targets: string[]): Promise<void>;
export function buildTeamhubLauncher(
  target: string,
  outputPath: string,
): Promise<void>;
