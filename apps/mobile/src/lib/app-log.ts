// The phone's own log: one JSON line per event, kept on the phone in two
// files of at most 256 KB each (the current one and the one before), for the
// Human to share when something goes wrong. Lines carry event names, codes,
// counts and timings only: never message or document text, keys, invites,
// audio or anything a person wrote.
import type { TextFiles } from "../computer/store";

export type LogLevel = "info" | "warn" | "error";
export type LogFields = Readonly<
  Record<string, string | number | boolean | undefined>
>;

export const LOG_PATH = "logs/app.log";
export const PREVIOUS_LOG_PATH = "logs/app.1.log";
const MAX_BYTES = 256 * 1024;
/** Lines held between flushes; older ones are dropped past this. */
const MAX_PENDING = 2_000;
const encoder = new TextEncoder();

function byteLength(text: string): number {
  return encoder.encode(text).length;
}

export class AppLog {
  readonly #files: TextFiles;
  readonly #maxBytes: number;
  readonly #now: () => Date;
  #pending: string[] = [];
  #current: string | undefined;
  #writing: Promise<void> = Promise.resolve();

  constructor(options: {
    files: TextFiles;
    maxBytes?: number;
    now?: () => Date;
  }) {
    this.#files = options.files;
    this.#maxBytes = options.maxBytes ?? MAX_BYTES;
    this.#now = options.now ?? (() => new Date());
  }

  log(level: LogLevel, event: string, fields: LogFields = {}): void {
    this.#pending.push(
      JSON.stringify({
        time: this.#now().toISOString(),
        level,
        event,
        ...fields,
      }),
    );
    if (this.#pending.length > MAX_PENDING)
      this.#pending.splice(0, this.#pending.length - MAX_PENDING);
  }

  /** Writes what was logged since the last flush; one write at a time. */
  flush(): Promise<void> {
    this.#writing = this.#writing
      .then(() => this.#write())
      .catch(() => undefined);
    return this.#writing;
  }

  async #write(): Promise<void> {
    if (this.#pending.length === 0) return;
    const batch = this.#pending;
    this.#pending = [];
    this.#current ??= (await this.#files.read(LOG_PATH)) ?? "";
    let size = byteLength(this.#current);
    for (const entry of batch) {
      const line = entry + "\n";
      const bytes = byteLength(line);
      if (bytes > this.#maxBytes) continue;
      if (size + bytes > this.#maxBytes) {
        await this.#files.write(PREVIOUS_LOG_PATH, this.#current);
        this.#current = "";
        size = 0;
      }
      this.#current += line;
      size += bytes;
    }
    await this.#files.write(LOG_PATH, this.#current);
  }

  /** Both files, oldest first, after writing anything pending. */
  async read(): Promise<string> {
    await this.flush();
    const previous = (await this.#files.read(PREVIOUS_LOG_PATH)) ?? "";
    const current = (await this.#files.read(LOG_PATH)) ?? "";
    return previous + current;
  }
}

type Sink = (level: LogLevel, event: string, fields?: LogFields) => void;
let sink: Sink = () => undefined;

/** Where logic modules' events go; the device adapter points it at the file. */
export function setLogSink(next: Sink): void {
  sink = next;
}

/** Logs from code that must not import the device: a no-op in tests. */
export function logEvent(
  level: LogLevel,
  event: string,
  fields?: LogFields,
): void {
  sink(level, event, fields);
}
