import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";

const DEFAULT_MAX_AGE_DAYS = 14;
const MS_PER_DAY = 86_400_000;
const DAILY_LOG_PATTERN = /^desktop-(\d{4})(\d{2})(\d{2})\.log$/;

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

function pruneExpiredLogs(
  directory: string,
  now: Date,
  maxAgeDays: number,
): void {
  if (maxAgeDays <= 0) return;
  const cutoffMs =
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
    maxAgeDays * MS_PER_DAY;
  try {
    for (const entry of readdirSync(directory)) {
      const match = DAILY_LOG_PATTERN.exec(entry);
      if (!match) continue;
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const fileDayMs = Date.UTC(year, month - 1, day);
      if (!Number.isFinite(fileDayMs) || fileDayMs >= cutoffMs) continue;
      const target = path.join(directory, entry);
      try {
        if (!lstatSync(target).isFile()) continue;
        unlinkSync(target);
      } catch {
        // Best-effort pruning; logging must never fail app startup.
      }
    }
  } catch {
    // Best-effort directory scan.
  }
}

// JSON lines under <userData>/logs, local only. Never log credentials,
// cookies or channel bodies.
export const fileLogger = (
  directory: string,
  options: {
    stderr?: boolean;
    maxAgeDays?: number;
    now?: () => Date;
  } = {},
): Logger => {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const now = options.now ?? (() => new Date());
  const maxAgeDays = options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  pruneExpiredLogs(directory, now(), maxAgeDays);
  const write =
    (level: string) =>
    (event: string, fields: Record<string, unknown> = {}): void => {
      const ts = now().toISOString();
      const line = JSON.stringify({ ts, level, event, ...fields });
      const day = ts.slice(0, 10).replaceAll("-", "");
      try {
        appendFileSync(
          path.join(directory, `desktop-${day}.log`),
          `${line}\n`,
          {
            mode: 0o600,
          },
        );
      } catch {
        // Logging must never take the app down.
      }
      if (options.stderr) process.stderr.write(`${line}\n`);
    };
  return { info: write("info"), warn: write("warn"), error: write("error") };
};
