import { createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { redact } from "@linger/local-installation/redaction";
import { ZipFile } from "yazl";

import {
  DiagnosticsSender,
  diagnosticsUploadUrl,
  uploadDiagnostics,
  type PreparedDiagnostics,
} from "./diagnostics-upload.js";
import type { LocalServerModule } from "./local-server.js";
import { LOCAL_INSTANCE } from "./local-server.js";
import type { Module, ModuleContext } from "./modules.js";
import { savedSecretValues } from "./provider-keys.js";

// A file put into the bundle: where it is read from and its name inside.
export interface DiagnosticsFile {
  readonly file: string;
  readonly entry: string;
  readonly maxBytes?: number;
}

// Files that hold credentials or keys never go into the bundle, whatever
// folder they are found in. Matched on the base name, case-insensitively,
// since Windows paths are.
const EXCLUDED_NAMES = new Set([
  "api-key",
  "byok.json",
  "gateway.json",
  "caller.key",
  "control.key",
  "credential.json",
  "launch.html",
  "local-account.json",
  "postgres-password",
  "auth.json",
  ".credentials.json",
  "cookies",
  "cookies-journal",
]);

export const excludedFromDiagnostics = (file: string): boolean => {
  const name = path.win32.basename(file).toLowerCase();
  return (
    EXCLUDED_NAMES.has(name) ||
    // .env, services.env, compose.env, native.env, .env.local…
    name.startsWith(".env") ||
    name.endsWith(".env") ||
    // Installer job inputs carry model API keys.
    name.endsWith(".input.json") ||
    /\.(key|pem|p12|sqlite|sqlite-wal|sqlite-shm|db)$/.test(name) ||
    name.includes("credential") ||
    name.includes("secret")
  );
};

// The name inside the zip: `prefix/` and the path below `root`, with forward
// slashes on every platform.
export const diagnosticsEntry = (
  prefix: string,
  root: string,
  file: string,
  pathApi: typeof path = path,
): string =>
  [prefix, ...pathApi.relative(root, file).split(pathApi.sep)]
    .filter(Boolean)
    .join("/");

// Values of keys that look secret, in JSON ("accessToken": "…") and in
// key=value text, on top of the installer's own redaction.
const SECRET_KEY =
  /("[\w.-]*(?:token|secret|password|passwd|cookie|credential|api[_-]?key|authorization|private[_-]?key)[\w.-]*"\s*:\s*)("(?:[^"\\\n]|\\.)*"|[^\s,}\]]+)/gi;

export const redactDiagnostics = (text: string): string =>
  redact(text.replace(SECRET_KEY, '$1"[REDACTED]"'));

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Replaces the home folder with ~ as logs print it: native separators,
// forward slashes, and doubled backslashes inside JSON. Windows paths
// compare case-insensitively. The account name in it often names the
// person.
export const homeRedactor = (home: string): ((text: string) => string) => {
  const trimmed = home.replace(/[\\/]+$/, "");
  // A home at the root would turn every path into ~.
  if (trimmed.split(/[\\/]/).filter(Boolean).length < 2) return (text) => text;
  const windows = /^[A-Za-z]:\\/.test(trimmed) || trimmed.includes("\\");
  const forms = new Set([
    trimmed,
    trimmed.replaceAll("\\", "/"),
    trimmed.replaceAll("\\", "\\\\"),
  ]);
  const pattern = new RegExp(
    `(?:${[...forms]
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join("|")})(?![\\w.-])`,
    windows ? "gi" : "g",
  );
  return (text) => text.replace(pattern, "~");
};

// Logs keep their newest part; the bundle stays small enough to send.
const MAX_FILE_BYTES = 8 * 1024 * 1024;
// Localmodels stack run records, deployment records, and engine logs are
// capped tighter by both count and byte length so repeated retries never bloat
// the bundle.
export const MAX_LOCALMODELS_FILES = 5;
export const MAX_LOCALMODELS_BYTES = 256 * 1024;

const readTail = async (
  file: string,
  maxBytes: number = MAX_FILE_BYTES,
): Promise<string> => {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    return start > 0
      ? `[first ${start} bytes left out]\n${text.slice(text.indexOf("\n") + 1)}`
      : text;
  } finally {
    await handle.close();
  }
};

const isFile = async (file: string): Promise<boolean> =>
  stat(file).then(
    (info) => info.isFile(),
    () => false,
  );

const newestRegularFiles = async (
  candidates: readonly string[],
  limit: number,
): Promise<string[]> => {
  const dated = await Promise.all(
    candidates.map(async (file) => {
      const info = await lstat(file).catch(() => undefined);
      return info && !info.isSymbolicLink() && info.isFile()
        ? { file, mtimeMs: info.mtimeMs }
        : undefined;
    }),
  );
  return dated
    .filter((item): item is { file: string; mtimeMs: number } => Boolean(item))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.file.localeCompare(a.file))
    .slice(0, limit)
    .map((item) => item.file)
    .sort();
};

const MAX_SECRET_FILE_BYTES = 4 * 1024;

// Per-deployment localmodels bearer keys stay out of the zip as files, and
// their values are also scrubbed from every bundled text in case an engine or
// step record echoes `--api-key <value>` in argv form.
const localmodelsSecretValues = async (home: string): Promise<string[]> => {
  const keyFiles = await listFiles(
    path.join(home, "runtime", "localmodels", "models", "deployments"),
    1,
    (file) => path.basename(file) === "api-key",
  );
  const secrets = await Promise.all(
    keyFiles.map(async (file) => {
      const info = await lstat(file).catch(() => undefined);
      if (
        !info ||
        info.isSymbolicLink() ||
        !info.isFile() ||
        info.size === 0 ||
        info.size > MAX_SECRET_FILE_BYTES
      )
        return undefined;
      const value = (await readFile(file, "utf8").catch(() => "")).trim();
      return value.length >= 4 ? value : undefined;
    }),
  );
  return secrets.filter((value): value is string => Boolean(value));
};

const localmodelsFiles = async (
  home: string,
  prefix: string,
): Promise<DiagnosticsFile[]> => {
  const root = path.join(home, "runtime", "localmodels");
  const stackRuns = await listFiles(
    path.join(root, "state", "stacks"),
    0,
    (file) => /\.(?:run\.json|progress)$/.test(file),
  );
  const deployments = await listFiles(
    path.join(root, "state", "deployments", "local"),
    0,
    (file) => /\.json$/.test(file),
  );
  const serverLogs = await listFiles(
    path.join(root, "models", "deployments"),
    1,
    (file) => path.basename(file) === "server.log",
  );
  const selected = [
    ...(await newestRegularFiles(stackRuns, MAX_LOCALMODELS_FILES)),
    ...(await newestRegularFiles(deployments, MAX_LOCALMODELS_FILES)),
    ...(await newestRegularFiles(serverLogs, MAX_LOCALMODELS_FILES)),
  ];
  return selected.map((file) => ({
    file,
    entry: diagnosticsEntry(prefix, home, file),
    maxBytes: MAX_LOCALMODELS_BYTES,
  }));
};

const listFiles = async (
  directory: string,
  depth: number,
  keep: (file: string) => boolean,
  skip: ReadonlySet<string> = new Set(),
): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  const files: string[] = [];
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0 && !skip.has(entry.name))
        files.push(...(await listFiles(file, depth - 1, keep, skip)));
    } else if (entry.isFile() && keep(file)) files.push(file);
  }
  return files.sort();
};

// What an installation home holds that explains a failure: the installer's
// job logs, the instance settings and the service logs. Data folders are
// never walked.
export const installationFiles = async (
  home: string,
  prefix: string,
): Promise<DiagnosticsFile[]> => {
  const files: DiagnosticsFile[] = [];
  const add = (file: string) =>
    files.push({ file, entry: diagnosticsEntry(prefix, home, file) });
  for (const file of [
    path.join(home, "desktop", "local-server.json"),
    path.join(home, "runtime", "model-services", "controller.log"),
  ])
    if (await isFile(file)) add(file);
  for (const file of await listFiles(path.join(home, "installer"), 1, (file) =>
    /\.(json|log)$/.test(file),
  ))
    add(file);
  files.push(...(await localmodelsFiles(home, prefix)));
  const instances = path.join(home, "instances");
  for (const name of await readdir(instances).catch(() => [] as string[]))
    for (const file of await listFiles(
      path.join(instances, name),
      3,
      (file) => /\.(json|log)$/.test(file),
      new Set(["data", "postgres-data", "node_modules", "processes"]),
    ))
      add(file);
  return files.filter((item) => !excludedFromDiagnostics(item.file));
};

// The Desktop's own logs and settings under its userData folder; the
// Gateway credential and the web session's cookies stay out.
export const desktopFiles = async (
  userData: string,
): Promise<DiagnosticsFile[]> => {
  const files: DiagnosticsFile[] = [];
  for (const file of await listFiles(
    path.join(userData, "logs"),
    0,
    () => true,
  ))
    files.push({ file, entry: diagnosticsEntry("desktop", userData, file) });
  for (const file of [
    path.join(userData, "config.json"),
    path.join(userData, "computer", "config.json"),
  ])
    if (await isFile(file))
      files.push({ file, entry: diagnosticsEntry("desktop", userData, file) });
  return files.filter((item) => !excludedFromDiagnostics(item.file));
};

export interface DiagnosticsOptions {
  readonly userData: string;
  // Installation homes: the default LINGER_HOME and, when elsewhere, the
  // folder the installation went into.
  readonly homes: readonly string[];
  // The folder the zip is saved in.
  readonly output: string;
  // Shown first in the bundle: version, platform and the setup state.
  readonly summary: Record<string, unknown>;
  readonly now?: Date;
  // The person's home folder, replaced with ~ everywhere.
  readonly userHome?: string;
}

// Writes linger-diagnostics-<time>.zip with every text redacted and
// returns its path, entries and size.
export const collectDiagnostics = async (
  options: DiagnosticsOptions,
): Promise<PreparedDiagnostics> => {
  const zip = new ZipFile();
  const added = new Set<string>();
  const homes = [...new Set(options.homes.map((home) => path.resolve(home)))];
  // The saved keys themselves, wherever a service printed them.
  const keys = [
    ...new Set([
      ...homes.flatMap((home) => savedSecretValues(home, LOCAL_INSTANCE)),
      ...(
        await Promise.all(homes.map((home) => localmodelsSecretValues(home)))
      ).flat(),
    ]),
  ];
  const withoutHome = homeRedactor(options.userHome ?? os.homedir());
  const addText = (entry: string, text: string) => {
    if (added.has(entry)) return;
    added.add(entry);
    for (const key of keys) text = text.replaceAll(key, "[REDACTED]");
    zip.addBuffer(
      Buffer.from(withoutHome(redactDiagnostics(text)), "utf8"),
      entry,
    );
  };
  const files = [...(await desktopFiles(options.userData))];
  for (const [index, home] of homes.entries()) {
    const prefix = index === 0 ? "linger-home" : `linger-home-${index + 1}`;
    files.push(...(await installationFiles(home, prefix)));
  }
  addText(
    "summary.json",
    JSON.stringify(
      {
        ...options.summary,
        os: `${os.type()} ${os.release()} ${os.arch()}`,
        homes,
        files: files.map((item) => item.entry),
      },
      null,
      2,
    ),
  );
  for (const item of files) {
    try {
      addText(item.entry, await readTail(item.file, item.maxBytes));
    } catch (error) {
      addText(`${item.entry}.error.txt`, String(error));
    }
  }
  zip.end();
  const stamp = (options.now ?? new Date())
    .toISOString()
    .replace(/\..*$/, "")
    .replaceAll(/[-:]/g, "")
    .replace("T", "-");
  const target = path.join(options.output, `linger-diagnostics-${stamp}.zip`);
  const partial = `${target}.partial`;
  try {
    await pipeline(
      zip.outputStream,
      createWriteStream(partial, { mode: 0o600 }),
    );
    await rename(partial, target);
  } finally {
    await rm(partial, { force: true });
  }
  return {
    file: target,
    entries: [...added],
    bytes: (await stat(target)).size,
  };
};

export interface DiagnosticsModuleOptions {
  readonly userData: string;
  readonly logs: string;
  // The default LINGER_HOME.
  readonly home: string;
  readonly version: string;
  // Where saved bundles go, normally Downloads.
  readonly output: () => string;
  readonly openFolder: (folder: string) => Promise<string>;
  readonly showFile: (file: string) => void;
  // Where a bundle waits for consent; deleted once sent or declined.
  readonly outbox: string;
}

// "Show Logs", "Save Diagnostics" and "Send Diagnostics" for the setup
// page, the start failure page and the tray.
export class DiagnosticsModule implements Module {
  readonly name = "Diagnostics";
  readonly dependsOn = ["LocalServer"];
  readonly #options: DiagnosticsModuleOptions;
  #ctx: ModuleContext | undefined;
  #saving: Promise<string> | undefined;
  readonly sender: DiagnosticsSender;

  constructor(options: DiagnosticsModuleOptions) {
    this.#options = options;
    this.sender = new DiagnosticsSender({
      endpoint: () => this.uploadUrl(),
      prepare: async () => {
        await mkdir(options.outbox, { recursive: true, mode: 0o700 });
        return this.#collect(options.outbox);
      },
      upload: (endpoint, bundle, onProgress) =>
        uploadDiagnostics({
          endpoint,
          file: bundle.file,
          bytes: bundle.bytes,
          client: {
            version: options.version,
            platform: `${process.platform}-${process.arch}`,
          },
          onProgress,
        }),
      discard: (file) => rm(file, { force: true }),
      onChange: (state) => {
        if (state.phase === "sent")
          this.#ctx?.log.info("diagnostics.sent", {
            host: state.host,
            report_id: state.reportId,
          });
        if (state.phase === "failed")
          this.#ctx?.log.warn("diagnostics.send_failed", {
            error: state.error,
          });
        this.#ctx?.bus.emit("diagnostics.changed");
      },
    });
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.#ctx = ctx;
    // A bundle left by a send the app quit during.
    await rm(this.#options.outbox, { recursive: true, force: true });
  }

  // The receiver Send Diagnostics uploads to; none hides it.
  uploadUrl(): string | undefined {
    const config = this.#ctx?.config.get();
    return config && diagnosticsUploadUrl(config);
  }

  async stop(): Promise<void> {}

  // Opens the log folder in Explorer, Finder or the file manager.
  async openLogs(): Promise<void> {
    const error = await this.#options.openFolder(this.#options.logs);
    if (error) throw new Error(`Couldn't open ${this.#options.logs}: ${error}`);
  }

  // Saves the bundle and shows it in its folder; one at a time.
  save(): Promise<string> {
    this.#saving ??= this.#save().finally(() => {
      this.#saving = undefined;
    });
    return this.#saving;
  }

  async #save(): Promise<string> {
    const { file } = await this.#collect(this.#options.output());
    this.#ctx?.log.info("diagnostics.saved", { file });
    this.#options.showFile(file);
    return file;
  }

  #collect(output: string): Promise<PreparedDiagnostics> {
    const local = this.#ctx?.get<LocalServerModule>("LocalServer").status();
    const config = this.#ctx?.config.get();
    return collectDiagnostics({
      userData: this.#options.userData,
      homes: [this.#options.home, ...(local ? [local.location.path] : [])],
      output,
      summary: {
        version: this.#options.version,
        platform: `${process.platform}-${process.arch}`,
        serverUrl: config?.serverUrl,
        computerId: config?.computerId,
        localServer: local && {
          phase: local.phase,
          step: local.step,
          message: local.message,
          origin: local.origin,
        },
      },
    });
  }
}
