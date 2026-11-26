import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";

export const DEFAULT_NATIVE_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_NATIVE_LOG_MAX_BACKUPS = 3;

export interface NativeLogOptions {
  readonly path: string;
  readonly maxBytes?: number;
  readonly maxBackups?: number;
  readonly droppedLineMessage?: (droppedCount: number) => string;
}

export interface RotatingNativeLog {
  append(line: string): void;
  close(): void;
}

function isPrivateOwner(info: Stats): boolean {
  // Windows reports neither owner nor mode bits; the native directory ACL,
  // repaired by privateDirectory, is what keeps these files private there.
  return (
    process.platform === "win32" ||
    (info.uid === process.getuid?.() && !(info.mode & 0o077))
  );
}

function openPrivateLogSync(logPath: string): { fd: number; size: number } {
  const fd = openSync(
    logPath,
    constants.O_CREAT |
      constants.O_APPEND |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || !isPrivateOwner(info)) {
      throw new Error("Unsafe native log");
    }
    return { fd, size: info.size };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function shiftBackupsSync(logPath: string, maxBackups: number): void {
  if (maxBackups <= 0) {
    unlinkSync(logPath);
    return;
  }
  const oldest = `${logPath}.${maxBackups}`;
  try {
    if (existsSync(oldest)) unlinkSync(oldest);
  } catch {
    // Best-effort pruning so logging cannot drop process ownership.
  }
  for (let index = maxBackups - 1; index >= 1; index--) {
    const source = `${logPath}.${index}`;
    const target = `${logPath}.${index + 1}`;
    try {
      if (existsSync(source)) renameSync(source, target);
    } catch {
      // Skip transient backup conflicts rather than crashing the supervisor.
    }
  }
  renameSync(logPath, `${logPath}.1`);
}

/**
 * Opens an owner-only append log with bounded size rotation.
 */
export function openRotatingNativeLog(
  options: NativeLogOptions,
): RotatingNativeLog {
  const maxBytes = options.maxBytes ?? DEFAULT_NATIVE_LOG_MAX_BYTES;
  const maxBackups = options.maxBackups ?? DEFAULT_NATIVE_LOG_MAX_BACKUPS;
  let state = openPrivateLogSync(options.path);
  let dropped = 0;

  const close = (): void => {
    if (state.fd < 0) return;
    try {
      closeSync(state.fd);
    } catch {
      // Already closed.
    }
    state = { fd: -1, size: 0 };
  };

  const rotateIfOversize = (): void => {
    if (state.size < maxBytes) return;
    close();
    shiftBackupsSync(options.path, maxBackups);
    state = openPrivateLogSync(options.path);
  };

  if (state.size >= maxBytes) {
    try {
      rotateIfOversize();
    } catch {
      // Retain ownership even if initial log rotation fails.
    }
  }

  const writeChunk = (text: string): void => {
    if (state.fd < 0) state = openPrivateLogSync(options.path);
    writeSync(state.fd, text);
    state.size += Buffer.byteLength(text);
  };

  return {
    append(line: string): void {
      try {
        if (dropped > 0 && options.droppedLineMessage) {
          writeChunk(options.droppedLineMessage(dropped));
          dropped = 0;
        }
        writeChunk(line);
        rotateIfOversize();
      } catch {
        // Keep draining pipes and retain ownership even when disk writes fail.
        dropped++;
      }
    },
    close,
  };
}
