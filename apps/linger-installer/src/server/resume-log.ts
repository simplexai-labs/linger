import { closeSync, openSync, renameSync, writeSync } from "node:fs";
import path from "node:path";
import { redact } from "@linger/local-installation/redaction";
import { privateDirectory } from "@linger/local-installation/private-files";

/** Caps one resume's log so a long or looping run cannot fill the disk. */
export const RESUME_LOG_MAX_BYTES = 512 * 1024;

/**
 * The last `--resume` run's log, beside the installer's job logs, which Save
 * Diagnostics collects. The run before it is kept as resume.1.log.
 */
export function resumeLogFile(home: string): string {
  return path.join(path.resolve(home), "installer", "resume.log");
}

export interface ResumeLog {
  write(message: string): void;
  close(): void;
}

/**
 * Opens a fresh resume log for `home`, moving the previous one aside. The
 * desktop does not read resume stderr (detached services could hold a pipe
 * open), so this file is the only record of why a resume failed. Each line
 * is timestamped and redacted; logging never fails the resume.
 */
export async function openResumeLog(
  home: string,
  now: () => Date = () => new Date(),
  maxBytes = RESUME_LOG_MAX_BYTES,
): Promise<ResumeLog> {
  const file = resumeLogFile(home);
  let fd: number | undefined;
  try {
    await privateDirectory(path.dirname(file));
    try {
      renameSync(file, file.replace(/\.log$/, ".1.log"));
    } catch {
      // No earlier resume log.
    }
    fd = openSync(file, "w", 0o600);
  } catch {
    fd = undefined;
  }
  let written = 0;
  let truncated = false;
  const append = (text: string) => {
    if (fd === undefined || truncated) return;
    const bytes = Buffer.byteLength(text);
    try {
      if (written + bytes > maxBytes) {
        truncated = true;
        writeSync(fd, `[resume log truncated at ${maxBytes} bytes]\n`);
        return;
      }
      writeSync(fd, text);
      written += bytes;
    } catch {
      truncated = true;
    }
  };
  return {
    write(message) {
      const stamp = now().toISOString();
      for (const line of message.replace(/\n$/, "").split("\n"))
        append(`${stamp} ${redact(line)}\n`);
    },
    close() {
      if (fd === undefined) return;
      try {
        closeSync(fd);
      } catch {
        // Already closed.
      }
      fd = undefined;
    },
  };
}
