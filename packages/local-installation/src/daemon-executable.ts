import { realpathSync, statSync } from "node:fs";
import path from "node:path";

export function isAbsoluteForPlatform(
  candidate: string,
  platform: NodeJS.Platform,
): boolean {
  return platform === "win32"
    ? path.win32.isAbsolute(candidate)
    : path.isAbsolute(candidate);
}

function isExecutableFile(
  candidate: string,
  platform: NodeJS.Platform,
): string | null {
  if (!candidate || !isAbsoluteForPlatform(candidate, platform)) return null;
  try {
    const resolved = realpathSync(candidate);
    const info = statSync(resolved);
    if (!info.isFile()) return null;
    if (platform !== "win32" && (info.mode & 0o111) === 0) return null;
    return resolved;
  } catch {
    return null;
  }
}

/**
 * Resolves the bundled or explicitly configured `linger-computer-daemon` binary.
 * Order: explicit option -> `LINGER_COMPUTER_DAEMON` -> PATH lookup.
 */
export function resolveDaemonExecutable(
  env: NodeJS.ProcessEnv = process.env,
  explicitPath?: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  for (const candidate of [explicitPath, env.LINGER_COMPUTER_DAEMON]) {
    const trimmed = candidate?.trim();
    if (!trimmed) continue;
    const resolved = isExecutableFile(trimmed, platform);
    if (resolved) return resolved;
  }
  const binary =
    platform === "win32"
      ? "linger-computer-daemon.exe"
      : "linger-computer-daemon";
  const delimiter = platform === "win32" ? ";" : ":";
  const pathValue =
    platform === "win32"
      ? (Object.entries(env).find(
          ([key]) => key.toUpperCase() === "PATH",
        )?.[1] ?? "")
      : (env.PATH ?? "");
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    if (!isAbsoluteForPlatform(directory, platform)) continue;
    const candidate =
      platform === "win32"
        ? path.win32.join(directory, binary)
        : path.join(directory, binary);
    const resolved = isExecutableFile(candidate, platform);
    if (resolved) return resolved;
  }
  return null;
}
