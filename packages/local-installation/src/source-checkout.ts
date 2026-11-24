import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";
import {
  atomicPrivate,
  initializeInstance,
  loadInstance,
  readPrivate,
  withInstanceLock,
  type Instance,
} from "./instance.js";
import {
  liveKitEnvironment,
  prepareLiveKitSettings,
  readLiveKitSettings,
} from "./native-livekit.js";
import { readUserEnvironment } from "./user-environment.js";
import { localAccountProvisioned } from "./account.js";
import { latestLegacyBackup } from "./legacy-database.js";
import {
  inspectNativeProcess,
  reclaimNativeOrphans,
  type NativeService,
} from "./native-process.js";
import { freePort, portFree } from "./ports.js";
import type { SetupChoice } from "./setup-plan.js";
import type { ByokConfiguration } from "./byok-source.js";
import type { RuntimeDescriptor } from "./managed-runtimes.js";
import type { InstallerEvent } from "./events.js";

// A Native installation of one Linger source checkout: the desktop client's
// unpacked source package, or a developer's clone.
export interface SourceInstallOptions {
  setupChoice?: SetupChoice;
  byok?: ByokConfiguration;
  shareGpu?: boolean;
  localModelsApproval?: string;
  localModelsReplan?: boolean;
  name: string;
  home?: string;
  port?: number;
  email?: string;
  password?: string;
  computerName?: string;
  model?: { baseUrl: string; model: string; apiKey: string };
  runtimeModel?: { baseUrl: string; model: string; apiKey: string };
  signal: AbortSignal;
  onEvent: (event: InstallerEvent) => void;
  repo: string;
  // The desktop client is this machine's Computer: source installs skip the
  // Go Computer build and enrollment, and the client signs in itself.
  externalComputer?: boolean;
  // Cold-resume restarts of an existing checkout reuse an installed runtime
  // after one inspection and overlap runtime preparation with service startup.
  resume?: boolean;
  // A start from the saved setup (a resume, including the first one after an
  // app update onto a new checkout) reports local models that do not come
  // back instead of failing, so the person still reaches the workspace and
  // the Models page.
  degradeLocalModels?: boolean;
  // Passes runtime descriptors inspected during startup so callers avoid a
  // second runtime status probe.
  onRuntimeDescriptors?: (descriptors: RuntimeDescriptor[]) => void;
}
export interface EnvironmentReport {
  platform: string;
  arch: string;
  releaseAvailable: boolean;
  checks: {
    id: string;
    title: string;
    state: "ready" | "action_required" | "failed";
    detail: string;
  }[];
  availableBytes?: number;
  requiredBytes?: number;
}
export async function validateSourceRepository(
  repository: string,
): Promise<string> {
  const repo = await realpath(repository);
  try {
    const manifest = JSON.parse(
      await readFile(path.join(repo, "package.json"), "utf8"),
    ) as { name?: string };
    if (manifest.name !== "linger") throw new Error("Wrong repository");
    const info = await lstat(path.join(repo, "scripts/source-native.mjs"));
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Invalid native source script");
  } catch (cause) {
    throw new Error(
      "Source checkout must be a Linger checkout with scripts/source-native.mjs.",
      { cause },
    );
  }
  return repo;
}
// Points an instance at another checkout of the same source; its data and
// ports stay.
function rebind(instance: Instance, repo: string): void {
  const previous = instance.releaseDir;
  instance.releaseDir = repo;
  instance.source!.repo = repo;
  if (instance.computerExecutable.startsWith(previous + path.sep))
    instance.computerExecutable = path.join(
      repo,
      path.relative(previous, instance.computerExecutable),
    );
}
/**
 * Records that the instance's services run from the checkout it was
 * prepared with. Call it under the instance lock. Until then instance.json
 * keeps naming the checkout the running services came from, so a resume
 * never takes services left on an older checkout for the new one.
 */
export async function saveSourceBinding(instance: Instance): Promise<void> {
  const stored = await loadInstance({
    name: instance.name,
    home: path.resolve(instance.root, "../.."),
  });
  if (!stored?.source || stored.releaseDir === instance.releaseDir) return;
  rebind(stored, instance.releaseDir);
  await atomicPrivate(
    path.join(stored.root, "instance.json"),
    JSON.stringify(stored, null, 2) + "\n",
  );
}
// Which native service listens on each of the instance's ports.
const portOwners = {
  web: "web",
  teamhub: "teamhub",
  nodeServices: "node-services",
  document: "node-services",
  postgres: "postgres",
} as const satisfies Record<
  keyof NonNullable<Instance["source"]>["ports"],
  NativeService
>;
export async function prepareSourceConfiguration(
  repository: string,
  options: {
    name: string;
    home?: string;
    port?: number;
    computerName?: string;
    externalComputer?: boolean;
    // A source instance bound to another checkout follows this one, in
    // memory only: the caller saves the binding (saveSourceBinding) once
    // the services run from it.
    rebindSource?: boolean;
  },
): Promise<{
  instance: Instance;
  env: NodeJS.ProcessEnv;
  warnings: string[];
}> {
  const repo = await validateSourceRepository(repository);
  const instance = await initializeInstance({ ...options, releaseDir: repo });
  return withInstanceLock(instance, async () => {
    if (
      options.rebindSource &&
      instance.mode === "source-native" &&
      instance.source &&
      instance.releaseDir !== repo
    )
      rebind(instance, repo);
    if (
      instance.releaseDir !== repo ||
      (!instance.source &&
        (await readPrivate(path.join(instance.root, "local-account.json"))) !==
          undefined)
    )
      throw new Error(
        "Instance is already bound to another release or checkout; select a new instance.",
      );
    // The ports every other instance of this home keeps, Native LiveKit's too.
    const reservedPorts = async () => {
      const reserved = new Set<number>([
        instance.port,
        ...Object.values(instance.source?.ports ?? {}),
      ]);
      for (const name of await readdir(path.dirname(instance.root))) {
        if (!/^[a-z][a-z0-9-]{0,39}$/.test(name) || name === instance.name)
          continue;
        const other = await loadInstance({
          name,
          home: path.resolve(instance.root, "../.."),
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
      const livekit = await readLiveKitSettings(instance.root);
      if (livekit) reserved.add(livekit.httpPort).add(livekit.rtcPort);
      return reserved;
    };
    if (!instance.source) {
      const reserved = await reservedPorts();
      instance.source = {
        repo,
        ports: {
          web: instance.port,
          teamhub: await freePort(reserved),
          nodeServices: await freePort(reserved),
          document: await freePort(reserved),
          postgres: await freePort(reserved),
        },
      };
      await atomicPrivate(
        path.join(instance.root, "instance.json"),
        JSON.stringify(instance, null, 2) + "\n",
      );
    }
    const warnings: string[] = [];
    // A port another program took since it was chosen moves to a free one
    // while the service that listens there is stopped; the services then
    // restart because their environment names the new port. The web port is
    // the product origin. The desktop app follows it to a new port and keeps
    // its Computer and session, so for the desktop it moves like the others.
    // A Computer this installer enrolled keeps it once the owner account
    // exists (or a database set aside from an older install marks the
    // account to be made again): its self-update source and a pending
    // enrollment credential name the origin. There the web service reports
    // the program on its port instead.
    const keepsOrigin =
      !options.externalComputer &&
      ((await localAccountProvisioned(instance.root)) ||
        (await latestLegacyBackup(instance.root)) !== undefined);
    const movable = Object.entries(portOwners).filter(
      ([name]) => !keepsOrigin || name !== "web",
    ) as [keyof typeof portOwners, NativeService][];
    let reserved: Set<number> | undefined;
    for (const [name, owner] of movable) {
      const port = instance.source.ports[name];
      if (
        (await inspectNativeProcess(instance.root, owner)).running ||
        (await portFree(port))
      )
        continue;
      // The program may be one an earlier run left behind.
      await reclaimNativeOrphans(instance.root, {
        ports: [port],
        paths: [path.resolve(instance.root, "../.."), instance.root, repo],
      });
      if (await portFree(port)) continue;
      reserved ??= await reservedPorts();
      const next = await freePort(reserved);
      instance.source.ports[name] = next;
      if (name === "web") {
        instance.port = next;
        instance.origin = `http://localhost:${next}`;
      }
      // Only the ports change on disk: a checkout this run rebinds to is
      // saved once the services serve from it (saveSourceBinding).
      const stored = (await loadInstance({
        name: instance.name,
        home: path.resolve(instance.root, "../.."),
      }))!;
      await atomicPrivate(
        path.join(instance.root, "instance.json"),
        JSON.stringify(
          {
            ...stored,
            port: instance.port,
            origin: instance.origin,
            source: { ...stored.source!, ports: { ...instance.source.ports } },
          },
          null,
          2,
        ) + "\n",
      );
      warnings.push(
        `Port ${port} is in use by another program; Linger's ${owner} uses port ${next} instead.\n`,
      );
    }
    const envFile = path.join(instance.root, "native.env");
    // The desktop installs from a source package that each update replaces,
    // so only the instance's user.env configures it; a developer's checkout
    // also supplies its own .env, under user.env.
    let supplied: Record<string, string> = {};
    if (!options.externalComputer) {
      const selected = process.env.LOCAL_ENV_FILE
        ? path.resolve(repo, process.env.LOCAL_ENV_FILE)
        : path.join(repo, ".env");
      try {
        supplied = parseEnv(await readFile(selected, "utf8")) as Record<
          string,
          string
        >;
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "ENOENT" ||
          process.env.LOCAL_ENV_FILE
        )
          throw new Error("Cannot read source environment file.", {
            cause: error,
          });
      }
    }
    const user = await readUserEnvironment(instance.root, (message) =>
      warnings.push(message),
    );
    const secrets = parseEnv(
      (await readPrivate(path.join(instance.root, "services.env")))!,
    );
    const ports = instance.source.ports;
    const generated = {
      ...supplied,
      ...user,
      LOCAL_ENV_FILE: envFile,
      COMPUTER_RELEASE_TARGETS: `${process.platform}-${process.arch}`,
      WEB_HTTP_PORT: String(ports.web),
      TEAMHUB_HTTP_PORT: String(ports.teamhub),
      NODE_SERVICES_HTTP_PORT: String(ports.nodeServices),
      DOCUMENT_RUNTIME_HTTP_PORT: String(ports.document),
      POSTGRES_PORT: String(ports.postgres),
      WEB_PUBLIC_ORIGIN: instance.origin,
      AGENT_RUNNER_PUBLIC_GATEWAY_URL: `ws://127.0.0.1:${ports.nodeServices}/v1/runner-gateway`,
      LINGER_SECRET_SEED: secrets.LINGER_SECRET_SEED!,
      TEAMHUB_SECRET_ENCRYPTION_KEY: secrets.TEAMHUB_SECRET_ENCRYPTION_KEY!,
      TEAMHUB_DATABASE_URL: `postgres://simplexai:${encodeURIComponent(secrets.LINGER_POSTGRES_PASSWORD!)}@127.0.0.1:${ports.postgres}/simplexai?sslmode=disable`,
      TEAMHUB_HTTP_ADDRESS: `127.0.0.1:${ports.teamhub}`,
      TEAMHUB_BASE_URL: `http://127.0.0.1:${ports.teamhub}`,
      TEAMHUB_CLI_BASE_URL: `http://127.0.0.1:${ports.teamhub}`,
      TEAMHUB_NODE_SERVICES_URL: `http://127.0.0.1:${ports.nodeServices}`,
      TEAMHUB_ARTIFACT_STORAGE_ROOT: path.join(instance.root, "data/artifacts"),
      TEAMHUB_DOCUMENT_RUNTIME_URL: `http://127.0.0.1:${ports.document}`,
      NODE_SERVICES_HTTP_ADDRESS: `127.0.0.1:${ports.nodeServices}`,
      DOCUMENT_RUNTIME_HTTP_ADDRESS: `127.0.0.1:${ports.document}`,
      AGENT_HOME: path.join(instance.root, "data/agent"),
      COMPUTER_RELEASE_DIR: path.join(instance.root, "native/computer-release"),
      PORT: String(ports.web),
      // Both loopback addresses, so no other program answers for the origin.
      HOST: "127.0.0.1,::1",
      // Native runs its own LiveKit on loopback with this instance's ports
      // and keys.
      ...liveKitEnvironment(
        await prepareLiveKitSettings(
          instance.root,
          await reservedPorts(),
          (message) => warnings.push(message),
        ),
      ),
    };
    const quote = (value: string) => {
      if (!/[\r\n\0]/.test(value)) {
        // Match the launcher's parser, including literal Windows backslashes.
        for (const delimiter of ["'", "`", '"', ""]) {
          const quoted = `${delimiter}${value}${delimiter}`;
          if (parseEnv(`VALUE=${quoted}`).VALUE === value) return quoted;
        }
      }
      throw new Error("Source environment contains unsupported characters.");
    };
    const nativeFileOmissions = new Set([
      "WEB_HTTP_PORT",
      "TEAMHUB_HTTP_PORT",
      "DOCUMENT_RUNTIME_HTTP_PORT",
      "POSTGRES_PORT",
      "HOST",
      "LOCAL_ENV_FILE",
    ]);
    const entries = Object.entries(generated).filter(
      ([key]) => !nativeFileOmissions.has(key),
    );
    const text =
      entries.map(([key, value]) => `${key}=${quote(value)}`).join("\n") + "\n";
    // An unmatched leading quote can consume a later entry, even if the
    // isolated value round-trips. Validate exactly what the launcher reads.
    const parsed = parseEnv(text);
    if (entries.some(([key, value]) => parsed[key] !== value))
      throw new Error("Source environment contains unsupported characters.");
    await atomicPrivate(envFile, text);
    return { instance, env: generated, warnings };
  });
}
