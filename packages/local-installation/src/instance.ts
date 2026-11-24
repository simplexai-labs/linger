import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, readdir } from "node:fs/promises";
import { windowsPrivatePath } from "./windows-private.js";
import {
  atomicPrivate,
  privateDirectory,
  readPrivate,
} from "./private-files.js";
import { LEGACY_PROJECT_PREFIX, lingerHome } from "./home.js";
import { freePort, portFree } from "./ports.js";
import { readLiveKitSettings } from "./native-livekit.js";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseEnv } from "node:util";

export interface Instance {
  schemaVersion: 1;
  name: string;
  // Native processes run every service; `source` holds the checkout and the
  // ports once the installer binds the instance to it.
  mode: "source-native";
  root: string;
  project: string;
  origin: string;
  port: number;
  releaseDir: string;
  computerConfig: string;
  computerExecutable: string;
  computerName?: string;
  source?: {
    repo: string;
    ports: Record<
      "web" | "teamhub" | "nodeServices" | "document" | "postgres",
      number
    >;
  };
  model?: { baseUrl: string; keyFile: string; model: string };
}
interface InstanceOptions {
  name: string;
  home?: string;
  port?: number;
  releaseDir?: string;
  computerExecutable?: string;
  computerName?: string;
}
// Generated once per instance and never rewritten: the database, the service
// credentials and the Composio key TeamHub saves are bound to these values.
const credentials: Record<string, () => string> = {
  LINGER_POSTGRES_PASSWORD: () => randomBytes(32).toString("hex"),
  LINGER_SECRET_SEED: () => randomBytes(32).toString("hex"),
  // TeamHub requires 32 bytes in standard base64.
  TEAMHUB_SECRET_ENCRYPTION_KEY: () => randomBytes(32).toString("base64"),
};
// TeamHub proves with this key that it is this instance's server before the
// desktop app sends the saved password. It has its own file, not services.env
// or native.env, so only TeamHub's process (native-source.ts) and the
// desktop app read it.
export const localIdentityKeyFile = (root: string) =>
  path.join(root, "local-identity.key");
export async function readLocalIdentityKey(
  root: string,
): Promise<string | undefined> {
  const key = (await readPrivate(localIdentityKeyFile(root)))?.trim();
  return key && validIdentityKey(key) ? key : undefined;
}
const validIdentityKey = (key: string) =>
  /^[A-Za-z0-9+/]{43}=$/.test(key) && Buffer.from(key, "base64").length === 32;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export { atomicPrivate, privateDirectory, readPrivate };
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException)?.code === "ENOENT";

// Where instance `name` keeps its private state under the installation home.
export function instanceRoot(options: { name: string; home?: string }): string {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(options.name))
    throw new Error(
      "Invalid instance name; use lowercase letters, numbers and hyphens",
    );
  return path.join(
    path.resolve(options.home ?? lingerHome()),
    "instances",
    options.name,
  );
}
export function composeProject(root: string, name: string): string {
  return `linger-${name}-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`;
}
export async function loadInstance(options: {
  name: string;
  home?: string;
}): Promise<Instance | undefined> {
  const root = instanceRoot(options);
  const contents = await readPrivate(path.join(root, "instance.json"));
  if (contents === undefined) return undefined;
  const value = JSON.parse(contents) as Instance;
  if (
    (value.mode as string) === "source" ||
    (value.mode as string) === "release"
  )
    throw new Error(
      `The Linger installation in ${root} ran in Docker, which Linger no longer supports. Remove that folder and install again; Linger now runs natively.`,
    );
  // The installer converts it before it starts; `--migrate` reports why not,
  // and the desktop runs that and shows the reason for its own instance.
  if (value.project?.startsWith(LEGACY_PROJECT_PREFIX))
    throw new Error(
      `The installation in ${root} still has its names from the earlier Simplex app because it could not be converted. Run the installer with --migrate to see why, fix that, then start Linger again.`,
    );
  if (
    value.schemaVersion !== 1 ||
    value.name !== options.name ||
    value.root !== root ||
    value.mode !== "source-native" ||
    (value.source !== undefined && !validSourceDescriptor(value)) ||
    !Number.isSafeInteger(value.port) ||
    value.port < 1024 ||
    value.port > 65535 ||
    value.origin !== `http://localhost:${value.port}` ||
    value.project !== composeProject(root, value.name) ||
    value.computerConfig !== path.join(root, "computer", "config.json") ||
    typeof value.computerExecutable !== "string" ||
    typeof value.releaseDir !== "string" ||
    (value.model && value.model.keyFile !== path.join(root, "model.key"))
  )
    throw new Error("Invalid instance settings");
  if (value.model) {
    validateModelUrl(value.model.baseUrl);
    if (
      typeof value.model.model !== "string" ||
      !/^[-a-zA-Z0-9_./:]{1,256}$/.test(value.model.model)
    )
      throw new Error("Invalid model ID");
  }
  return value;
}
export function validSourceDescriptor(instance: Instance): boolean {
  const source = instance.source;
  const names = [
    "web",
    "teamhub",
    "nodeServices",
    "document",
    "postgres",
  ] as const;
  return Boolean(
    source &&
    typeof source.repo === "string" &&
    path.isAbsolute(source.repo) &&
    source.repo === instance.releaseDir &&
    source.ports &&
    Object.keys(source.ports).length === names.length &&
    names.every(
      (name) =>
        Number.isSafeInteger(source.ports[name]) &&
        source.ports[name] >= 1024 &&
        source.ports[name] <= 65535,
    ) &&
    new Set(Object.values(source.ports)).size === names.length &&
    source.ports.web === instance.port,
  );
}
export async function initializeInstance(
  options: InstanceOptions,
): Promise<Instance> {
  const root = instanceRoot(options);
  if (
    options.computerName !== undefined &&
    (!options.computerName.trim() ||
      options.computerName.length > 120 ||
      /\p{Cc}/u.test(options.computerName))
  )
    throw new Error("Invalid Computer name");
  if (
    options.port !== undefined &&
    (!Number.isSafeInteger(options.port) ||
      options.port < 1024 ||
      options.port > 65535)
  )
    throw new Error("Port must be an integer between 1024 and 65535");
  await privateDirectory(root);
  await privateDirectory(path.dirname(root));
  const seed = { root: path.dirname(root) } as Instance;
  // Initialization waits briefly for another initializer; user operations fail busy immediately.
  for (let attempt = 0; ; attempt++) {
    try {
      return await withInstanceLock(seed, async () => {
        const existing = await loadInstance(options);
        if (existing) {
          if (options.port !== undefined && existing.port !== options.port)
            throw new Error(
              "Instance port is already configured; select a different instance",
            );
          await writeMissingCredentials(root);
          await writeLocalIdentityKey(root);
          return existing;
        }
        const reserved = new Set<number>();
        for (const name of await readdir(path.dirname(root))) {
          if (!/^[a-z][a-z0-9-]{0,39}$/.test(name) || name === options.name)
            continue;
          const other = await loadInstance({
            name,
            home: path.dirname(path.dirname(root)),
          });
          if (other) {
            reserved.add(other.port);
            for (const port of Object.values(other.source?.ports ?? {}))
              reserved.add(port);
            const livekit = await readLiveKitSettings(other.root).catch(
              () => undefined,
            );
            if (livekit) reserved.add(livekit.httpPort).add(livekit.rtcPort);
          }
        }
        if (options.port !== undefined && reserved.has(options.port))
          throw new Error("Port is reserved by another instance");
        if (options.port !== undefined && !(await portFree(options.port)))
          throw new Error(`Port ${options.port} is occupied or unavailable`);
        const port =
          options.port ?? (await freePort(reserved, { preferred: 3000 }));
        const releaseDir = options.releaseDir
          ? path.resolve(options.releaseDir)
          : "";
        const instance: Instance = {
          schemaVersion: 1,
          name: options.name,
          mode: "source-native",
          root,
          project: composeProject(root, options.name),
          origin: `http://localhost:${port}`,
          port,
          releaseDir,
          computerConfig: path.join(root, "computer", "config.json"),
          ...(options.computerName
            ? { computerName: options.computerName }
            : {}),
          computerExecutable:
            options.computerExecutable ??
            process.env.LINGER_COMPUTER_BIN ??
            (releaseDir
              ? path.join(
                  releaseDir,
                  "computer",
                  process.platform === "win32"
                    ? "linger-computer.exe"
                    : "linger-computer",
                )
              : "linger-computer"),
        };
        await privateDirectory(path.dirname(instance.computerConfig));
        await writeMissingCredentials(root);
        await writeLocalIdentityKey(root);
        await atomicPrivate(
          path.join(root, "instance.json"),
          JSON.stringify(instance, null, 2) + "\n",
        );
        return instance;
      });
    } catch (error) {
      if (
        !(error instanceof Error && error.message === "Instance busy") ||
        attempt >= 100
      )
        throw error;
      await delay(20);
    }
  }
}
// Appends only the credentials services.env lacks, so an instance created
// before a credential existed gets it once and keeps every value it has.
async function writeMissingCredentials(root: string): Promise<void> {
  const file = path.join(root, "services.env");
  const current = (await readPrivate(file)) ?? "";
  const present = parseEnv(current);
  const added = Object.entries(credentials)
    .filter(([key]) => !present[key])
    .map(([key, generate]) => `${key}=${generate()}\n`);
  if (added.length === 0) return;
  await atomicPrivate(
    file,
    `${current}${current && !current.endsWith("\n") ? "\n" : ""}${added.join("")}`,
  );
}
// Writes the identity key once; an instance keeps it from then on.
async function writeLocalIdentityKey(root: string): Promise<void> {
  if (await readLocalIdentityKey(root)) return;
  await atomicPrivate(
    localIdentityKeyFile(root),
    `${randomBytes(32).toString("base64")}\n`,
  );
}
/** The error code when another process holds an instance's lock. */
export const INSTANCE_BUSY = "INSTANCE_BUSY";
/** The lock database every instance-scoped operation under `root` takes. */
export function instanceLockFile(root: string): string {
  return path.join(root, "operation.sqlite");
}
export async function withInstanceLock<T>(
  instance: Instance,
  callback: () => Promise<T>,
): Promise<T> {
  const lockFile = instanceLockFile(instance.root);
  const info = await lstat(lockFile).catch((error) => {
    if (missing(error)) return undefined;
    throw error;
  });
  if (
    info &&
    (!info.isFile() ||
      info.isSymbolicLink() ||
      (process.platform !== "win32" && info.uid !== process.getuid?.()))
  )
    throw new Error("Unsafe instance lock file");
  if (info && process.platform === "win32")
    await windowsPrivatePath(lockFile, "file");
  const database = new DatabaseSync(lockFile);
  try {
    if (process.platform === "win32")
      await windowsPrivatePath(lockFile, "file", true);
    else await chmod(lockFile, 0o600);
    database.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
  } catch (error) {
    database.close();
    if (error instanceof Error && error.message.includes("database is locked"))
      throw Object.assign(new Error("Instance busy", { cause: error }), {
        code: INSTANCE_BUSY,
      });
    throw error;
  }
  try {
    return await callback();
  } finally {
    try {
      database.exec("ROLLBACK");
    } finally {
      database.close();
    }
  }
}
function validateModelUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch (error) {
    throw new Error("Invalid model URL", { cause: error });
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      ["https:"].includes(url.protocol) ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw new Error(
      "Model URL requires HTTPS or loopback HTTP without credentials",
    );
}
export async function writeModelConfig(
  instance: Instance,
  model: { baseUrl: string; apiKey: string; model: string },
): Promise<void> {
  validateModelConfig(model);
  const keyFile = path.join(instance.root, "model.key");
  await atomicPrivate(keyFile, model.apiKey);
  instance.model = { baseUrl: model.baseUrl, keyFile, model: model.model };
  await atomicPrivate(
    path.join(instance.root, "instance.json"),
    JSON.stringify(instance, null, 2) + "\n",
  );
}

export function validateModelConfig(model: {
  baseUrl: string;
  apiKey: string;
  model: string;
}): void {
  validateModelUrl(model.baseUrl);
  if (
    typeof model.model !== "string" ||
    !/^[-a-zA-Z0-9_./:]{1,256}$/.test(model.model)
  )
    throw new Error("Specify a valid model ID from the gateway.");
  if (!model.apiKey.trim() || /[\r\n\0]/.test(model.apiKey))
    throw new Error("Invalid model key");
}
