// The phone's log on this device: flushed every 10 seconds and when the app
// goes to the background, with a timing summary each minute and every
// uncaught JavaScript error. Sharing hands both files, joined into one, to
// the system share sheet (AirDrop, Mail, Files).
import Constants from "expo-constants";
import { File, Paths } from "expo-file-system";
import { AppState, Platform, Share } from "react-native";

import { documentFiles } from "../computer/store-expo";
import { t } from "../i18n/language";
import { AppLog, setLogSink, type LogFields, type LogLevel } from "./app-log";
import {
  diagnosticsZip,
  isUploadUrl,
  uploadDiagnostics,
} from "./diagnostics-upload";
import { diagnosticsUploadMessages } from "./diagnostics-upload.messages";
import { timingSummary } from "./timing";

export const appLog = new AppLog({ files: documentFiles });

export function log(level: LogLevel, event: string, fields?: LogFields): void {
  appLog.log(level, event, fields);
}

function logTiming(): void {
  for (const row of timingSummary())
    appLog.log("info", "timing.summary", {
      name: row.name,
      count: row.count,
      p50_ms: Math.round(row.p50 * 10) / 10,
      p90_ms: Math.round(row.p90 * 10) / 10,
    });
}

let started = false;

/** Starts flushing; safe to call more than once. */
export function startAppLog(): void {
  if (started) return;
  started = true;
  setLogSink(log);
  appLog.log("info", "app.started", {
    version: Constants.expoConfig?.version,
    os: `${Platform.OS} ${Platform.Version}`,
  });
  setInterval(() => void appLog.flush(), 10_000);
  setInterval(logTiming, 60_000);
  AppState.addEventListener("change", (state) => {
    if (state !== "active") {
      logTiming();
      void appLog.flush();
    }
  });
  // Only the error's kind and where it happened: a message can quote data.
  const previous = ErrorUtils.getGlobalHandler();
  ErrorUtils.setGlobalHandler((error: unknown, fatal?: boolean) => {
    const failure = error instanceof Error ? error : new Error("Unknown");
    appLog.log(fatal ? "error" : "warn", "app.uncaught_error", {
      name: /^\w{1,40}$/.test(failure.name) ? failure.name : "Error",
      at: stackFrameOf(failure.stack),
      fatal: !!fatal,
    });
    void appLog.flush();
    previous(error, fatal);
  });
}

/**
 * The first frame's file, line and column. The message can span lines and
 * quote data, so only a frame line is read, and only its location kept.
 */
function stackFrameOf(stack: string | undefined): string | undefined {
  for (const line of stack?.split("\n") ?? []) {
    if (!/^\s+at /.test(line)) continue;
    return /([\w.\-/]+:\d+:\d+)\)?\s*$/.exec(line)?.[1]?.slice(-120);
  }
  return undefined;
}

/** Writes both log files into one and opens the share sheet with it. */
export async function shareAppLog(): Promise<void> {
  logTiming();
  const text = await appLog.read();
  const file = new File(Paths.cache, "linger-phone-log.txt");
  if (file.exists) file.delete();
  file.create();
  await file.write(text);
  await Share.share({
    url: file.uri,
    title: t(diagnosticsUploadMessages.shareTitle),
  });
}

/** The receiver this build sends diagnostics to, or none. */
export function diagnosticsReceiver(): string | undefined {
  const url: unknown = Constants.expoConfig?.extra?.diagnosticsUploadUrl;
  return typeof url === "string" && isUploadUrl(url) ? url : undefined;
}

/** Zips the log with what built it and sends it; returns the report id. */
export async function sendAppLog(): Promise<string> {
  logTiming();
  const endpoint = diagnosticsReceiver();
  if (!endpoint) throw new Error("No diagnostics receiver in this build");
  const version = Constants.expoConfig?.version ?? "unknown";
  const platform = `${Platform.OS}-${String(Platform.Version)}`.replace(
    /[^A-Za-z0-9._+-]/g,
    "_",
  );
  const zip = diagnosticsZip({
    "app.log": await appLog.read(),
    "about.json": JSON.stringify({ app: "linger-mobile", version, platform }),
  });
  return uploadDiagnostics({ endpoint, zip, client: { version, platform } });
}
