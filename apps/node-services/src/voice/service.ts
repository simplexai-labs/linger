import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "@linger/service-kit";
import { sha256Hex, type JsonLogger } from "@linger/service-kit/node";
import type { components } from "@linger/wire-contracts/teamhub-internal/types";
import type { HttpHost } from "../http-host.js";
import {
  installModelPackages,
  modelPackageNames,
  modelPackagesInstalled,
  modelPackagesRoot,
} from "../model-packages.js";
import { hasBearerToken } from "../service-bearer-auth.js";
import { readVoiceConfig, type VoiceConfig } from "./config.js";

export type VoiceWorker = "asr" | "recorder" | "live";
export const voiceWorkerPorts = {
  asr: 4324,
  recorder: 4325,
  live: 4326,
} as const;
const VOICE_WORKERS = ["asr", "recorder", "live"] as const;
// LiveKit drains for 2 s, then allows jobs 68 s to save their final media.
export const VOICE_DRAIN_MS = 72_000;
/** Catches a reconcile notification that TeamHub could not deliver. */
export const VOICE_RECONCILE_POLL_MS = 60_000;
const RECONCILE_PATH = "/v1/voice/workers:reconcile";

type ProviderKeys = components["schemas"]["VoiceRuntimeProviderKeys"];

export interface VoiceWorkerSpawn {
  readonly args: string[];
  readonly env: NodeJS.ProcessEnv;
}

/** Soniox runs transcription and recording; xAI runs Live on its own. */
export function workerKeys(
  keys: ProviderKeys,
): Map<VoiceWorker, { variable: string; key: string }> {
  const soniox = keys.soniox_api_key?.trim();
  const xai = keys.xai_api_key?.trim();
  const workers = new Map<VoiceWorker, { variable: string; key: string }>();
  if (soniox) {
    workers.set("asr", { variable: "SONIOX_API_KEY", key: soniox });
    workers.set("recorder", { variable: "SONIOX_API_KEY", key: soniox });
  }
  if (xai) workers.set("live", { variable: "XAI_API_KEY", key: xai });
  return workers;
}

type FetchResult =
  | { readonly ok: true; readonly keys: ProviderKeys }
  | { readonly ok: false; readonly reason: string; readonly status?: number };

async function fetchProviderKeys(
  config: VoiceConfig,
  fetchImpl: typeof fetch,
): Promise<FetchResult> {
  if (!config.teamHubCredential)
    return { ok: false, reason: "credential_missing" };
  let response: Response;
  try {
    response = await fetchImpl(
      new URL("/internal/v1/voice/provider-keys", config.teamHubBaseUrl),
      {
        headers: { authorization: `Bearer ${config.teamHubCredential}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    return { ok: false, reason: "teamhub_unreachable" };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, reason: "teamhub_status", status: response.status };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "invalid_response" };
  }
  if (!isRecord(body)) return { ok: false, reason: "invalid_response" };
  const { soniox_api_key: soniox, xai_api_key: xai } = body;
  if (
    (soniox !== undefined && typeof soniox !== "string") ||
    (xai !== undefined && typeof xai !== "string")
  )
    return { ok: false, reason: "invalid_response" };
  return {
    ok: true,
    keys: {
      ...(soniox ? { soniox_api_key: soniox } : {}),
      ...(xai ? { xai_api_key: xai } : {}),
    },
  };
}

/** Separate processes keep inference, recording and Agent work off each other's
 * event loops. Workers follow TeamHub's effective provider keys: a reconcile
 * starts, stops or replaces a worker, and only the failed worker restarts after
 * a crash. Both act on one entry per worker; a generation number makes every
 * pending start, restart or drain from a superseded process a no-op. */
export async function startVoiceService(options: {
  logger: JsonLogger;
  http: HttpHost;
  environment?: NodeJS.ProcessEnv;
  spawnWorker?: (worker: VoiceWorker, spec: VoiceWorkerSpawn) => ChildProcess;
  installModels?: () => Promise<void>;
  fetch?: typeof fetch;
}) {
  const env = options.environment ?? process.env;
  const config = readVoiceConfig(env);
  const fetchImpl = options.fetch ?? fetch;
  // The VAD model's native package, when the runtime ships it separately: the
  // workers wait for its first download and find it on NODE_PATH.
  const models = modelPackageNames("voice");
  const installModels =
    options.installModels ?? (() => installModelPackages(models, env));
  // Worker starts share one download, so concurrent starts never fetch twice.
  let installing: Promise<void> | undefined;
  const install = () =>
    (installing ??= installModels().finally(() => {
      installing = undefined;
    }));
  const modelPath = models.length
    ? {
        NODE_PATH: [modelPackagesRoot(env), env.NODE_PATH]
          .filter(Boolean)
          .join(path.delimiter),
      }
    : {};
  let stopping = false;
  const entries = new Map<
    VoiceWorker,
    {
      /** The key this worker should run with; absent means stopped. */
      key?: { variable: string; key: string };
      digest?: string;
      generation: number;
      child?: ChildProcess;
      exited?: Promise<void>;
      retry?: NodeJS.Timeout;
      failures: number;
    }
  >(VOICE_WORKERS.map((worker) => [worker, { generation: 0, failures: 0 }]));
  const launch =
    options.spawnWorker ??
    ((_worker: VoiceWorker, spec: VoiceWorkerSpawn) =>
      spawn(process.execPath, spec.args, {
        env: spec.env,
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        detached: process.platform !== "win32",
      }));
  const killGroup = (child: ChildProcess) => {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH")
        options.logger.log("error", "voice.worker_cleanup_failed", { error });
    }
  };
  const drain = async (
    child: ChildProcess,
    exited: Promise<void> | undefined,
  ) => {
    const timer = setTimeout(() => killGroup(child), VOICE_DRAIN_MS);
    child.kill("SIGTERM");
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  };
  const start = (worker: VoiceWorker) => {
    const entry = entries.get(worker)!;
    const key = entry.key;
    if (stopping || !key) return;
    const generation = entry.generation;
    const current = () => !stopping && generation === entry.generation;
    const startedAt = Date.now();
    function restart(error: unknown) {
      if (!current()) return;
      options.logger.log("warn", "voice.worker_restarting", { worker, error });
      entry.failures = Date.now() - startedAt > 60_000 ? 0 : entry.failures + 1;
      entry.retry = setTimeout(
        () => {
          entry.retry = undefined;
          if (current()) start(worker);
        },
        Math.min(30_000, 1_000 * 2 ** Math.min(entry.failures - 1, 5)),
      );
    }
    if (!modelPackagesInstalled(models, env)) {
      install().then(() => {
        if (current()) start(worker);
      }, restart);
      return;
    }
    const workerEntry = fileURLToPath(
      import.meta.resolve("@linger/voice-runtime/worker"),
    );
    let child: ChildProcess;
    try {
      // Keys travel only in the child's environment. Both provider variables
      // are set explicitly, so a key inherited by node-services never wins.
      child = launch(worker, {
        args: [
          ...(workerEntry.endsWith(".ts")
            ? ["--import", "tsx"]
            : ["--conditions=linger-production"]),
          workerEntry,
          "start",
          ...(worker === "asr" ? [] : [`--${worker}`]),
        ],
        env: {
          ...env,
          ...modelPath,
          SONIOX_API_KEY: "",
          XAI_API_KEY: "",
          [key.variable]: key.key,
          TEAMHUB_BASE_URL: config.teamHubBaseUrl,
          VOICE_WORKER_PORT: String(voiceWorkerPorts[worker]),
        },
      });
    } catch (error) {
      restart(error);
      return;
    }
    entry.child = child;
    entry.exited = new Promise<void>((resolve) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        if (entry.child === child) entry.child = undefined;
        killGroup(child);
        resolve();
        restart(error);
      };
      child.once("error", finish);
      child.once("exit", (code, signal) => finish({ code, signal }));
    });
  };
  const apply = (keys: ProviderKeys) => {
    const wanted = workerKeys(keys);
    for (const worker of VOICE_WORKERS) {
      const entry = entries.get(worker)!;
      const key = wanted.get(worker);
      const digest = key ? sha256Hex(key.key) : undefined;
      // An unchanged key leaves a running, restarting or installing worker alone.
      if (digest === entry.digest) continue;
      entry.generation += 1;
      const generation = entry.generation;
      clearTimeout(entry.retry);
      entry.retry = undefined;
      entry.key = key;
      entry.digest = digest;
      entry.failures = 0;
      options.logger.log("info", "voice.worker_reconciled", {
        worker,
        action: !key ? "stop" : entry.child ? "replace" : "start",
      });
      const child = entry.child;
      if (!child) {
        start(worker);
        continue;
      }
      // The replacement binds the same port, so it waits for the old drain.
      void drain(child, entry.exited).then(() => {
        if (generation === entry.generation) start(worker);
      });
    }
  };
  let running: Promise<void> | undefined;
  let again = false;
  const runReconcile = async () => {
    do {
      again = false;
      const result = await fetchProviderKeys(config, fetchImpl);
      if (stopping) return;
      if (result.ok) apply(result.keys);
      else
        options.logger.log("warn", "voice.reconcile_failed", {
          reason: result.reason,
          ...(result.status ? { status: result.status } : {}),
        });
    } while (again && !stopping);
  };
  /** One reconcile runs at a time; triggers during it coalesce into one more. */
  const reconcile = (): Promise<void> => {
    if (stopping) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    running = runReconcile().finally(() => {
      running = undefined;
    });
    return running;
  };
  // Download the models before any key exists, so the first worker start after
  // a key is saved fits TeamHub's media start timeout. A worker start retries.
  if (!modelPackagesInstalled(models, env))
    install().catch((error: unknown) => {
      options.logger.log("warn", "voice.model_install_failed", { error });
    });
  // TeamHub may still be starting; a failed first reconcile retries on the poll.
  void reconcile();
  const poll = setInterval(() => void reconcile(), VOICE_RECONCILE_POLL_MS);
  const wantedWorkers = () =>
    VOICE_WORKERS.filter((worker) => entries.get(worker)!.key);
  // Readiness may fail while media reconnects; liveness continues to keep the
  // Agent and other media workers running. No provider credentials are returned.
  const unmount = options.http.mount({
    prefixes: ["/voice/health", RECONCILE_PATH],
    fetch: (request) => {
      if (new URL(request.url).pathname !== RECONCILE_PATH)
        return Response.json({ workers: wantedWorkers() });
      if (
        !config.managementCredential ||
        !hasBearerToken(
          request.headers.get("authorization") ?? undefined,
          config.managementCredential,
        )
      )
        return Response.json(
          {
            error: {
              code: "UNAUTHENTICATED",
              message: "Service bearer token is required",
              request_id: `request_${randomBytes(16).toString("hex")}`,
            },
          },
          { status: 401 },
        );
      if (request.method !== "POST")
        return new Response(null, { status: 405, headers: { allow: "POST" } });
      void reconcile();
      return new Response(null, { status: 202 });
    },
    readiness: async () => {
      const results = await Promise.all(
        wantedWorkers().map(async (worker) => {
          if (!entries.get(worker)?.child) return false;
          try {
            return (
              await fetch(`http://127.0.0.1:${voiceWorkerPorts[worker]}/`, {
                signal: AbortSignal.timeout(1_000),
              })
            ).ok;
          } catch {
            return false;
          }
        }),
      );
      return results.every(Boolean)
        ? { ready: true }
        : { ready: false, reason: "voice_worker_reconnecting" };
    },
  });
  return {
    /** Runs one reconcile now, or joins the one in flight. */
    reconcile,
    async stop() {
      stopping = true;
      clearInterval(poll);
      unmount();
      // Signal all workers together, so recorder flushing never waits for ASR.
      await Promise.all(
        [...entries.values()].map(async (entry) => {
          clearTimeout(entry.retry);
          const child = entry.child;
          if (child) await drain(child, entry.exited);
        }),
      );
    },
  };
}
