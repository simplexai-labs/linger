import { fileURLToPath } from "node:url";

import {
  WorkerDocumentNormalizer,
  type DocumentNormalizer,
} from "./document-normalizer/document-normalizer.js";
import { createJsonLogger, type JsonLogger } from "@linger/service-kit/node";

import type { Flashback } from "./flashback.js";
import type { ModelCall } from "./runtime-model-call.js";
import { startHttpHost, type HttpHost } from "./http-host.js";
import { pruneModelPackages } from "./model-packages.js";
import {
  NODE_SERVICES_DEFAULT_ADDRESS,
  readListenAddress,
  type ListenAddress,
} from "./listen-address.js";
import {
  SHUTDOWN_TIMEOUT_MS,
  runServiceProcess,
  type ProcessControl,
} from "./process-lifecycle.js";
import {
  readTeamHubHealthUrl,
  waitForTeamHubHealth,
} from "./teamhub-health.js";

interface RunningRole {
  /** Called once every selected role has started, for background work that
   * uses a seam a later role fills, such as the agent role's model call. */
  started?(): void;
  /** Called on every role before the first role stops, so that background
   * work stops taking new items while the roles it calls drain. */
  stopping?(): void;
  stop(): Promise<void>;
}

/** What the host passes to every role's start function. */
interface RoleHost extends ProcessControl {
  readonly logger: JsonLogger;
  /** The shared listener; present whenever an HTTP role is selected. */
  readonly http: HttpHost | undefined;
  /** The process's one document normalizer, served by LLM Wiki. */
  readonly normalizer: DocumentNormalizer;
  /** What a role hands to the roles that start after it. The agent role fills
   * modelCall after Memory and LLM Wiki have started, so they read it when
   * they call, and Memory's scheduler starts only from started(). */
  readonly seams: { flashback?: Flashback; modelCall?: ModelCall };
  /** Replaces the Agent Service's Room request timeout in process tests. */
  readonly agentRoomRequestTimeoutMs?: number;
}

// Each role loads only when selected, so a single-role process skips the
// other roles' dependencies. Roles start in this order and stop in reverse:
// the Agent Service stops before the Memory it calls, and the Document
// Runtime, which starts last, drains first.
const roles = {
  memory: async (host: RoleHost) => {
    const memory = await (
      await import("./memory/main.js")
    ).startMemoryService({
      http: requireHttp(host),
      logger: host.logger,
      modelCall: () => host.seams.modelCall,
    });
    host.seams.flashback = memory.flashback;
    return memory;
  },
  "llm-wiki": async (host: RoleHost) =>
    (await import("./llm-wiki/service.js")).startLlmWikiService({
      http: requireHttp(host),
      logger: host.logger,
      normalizer: host.normalizer,
      modelCall: () => host.seams.modelCall,
    }),
  agent: async (host: RoleHost) => {
    const http = requireHttp(host);
    const agent = await (
      await import("./agent/main.js")
    ).startAgentService({
      ...host,
      http,
      ...(host.seams.flashback ? { flashback: host.seams.flashback } : {}),
      ...(host.agentRoomRequestTimeoutMs
        ? { roomRequestTimeoutMs: host.agentRoomRequestTimeoutMs }
        : {}),
    });
    host.seams.modelCall = agent.modelCall;
    return {
      stop: async () => {
        host.seams.modelCall = undefined;
        await agent.stop();
      },
    };
  },
  voice: async (host: RoleHost) =>
    (await import("./voice/service.js")).startVoiceService({
      logger: host.logger,
      http: requireHttp(host),
    }),
  // The Document Runtime keeps its own port on its own worker thread and logs
  // from that thread; the host logger only records the thread's restarts.
  document: async (host: RoleHost) =>
    (await import("./document/main.js")).startDocumentService({
      logger: host.logger,
    }),
} satisfies Record<string, (host: RoleHost) => Promise<RunningRole>>;

type RoleName = keyof typeof roles;

/** Roles that serve requests on the shared HTTP listener. */
const HTTP_ROLES: ReadonlySet<RoleName> = new Set([
  "memory",
  "llm-wiki",
  "agent",
  "voice",
]);

/** Roles that contact TeamHub during startup and wait for it when gated. */
const TEAMHUB_DEPENDENT_ROLES: ReadonlySet<RoleName> = new Set([
  "agent",
  "voice",
]);

function defaultWaitForTeamHub(signal: AbortSignal): Promise<void> {
  return waitForTeamHubHealth(readTeamHubHealthUrl(), signal, {
    retryDelayMs: 100,
  });
}

export interface MainOverrides {
  agentRoomRequestTimeoutMs?: number;
  waitForTeamHub?: boolean;
  waitForTeamHubReady?: (signal: AbortSignal) => Promise<void>;
}

/** An unset or empty NODE_SERVICES_ROLES starts every role. */
export function selectRoles(value: string | undefined): RoleName[] {
  const names = (value ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const all = Object.keys(roles) as RoleName[];
  if (names.length === 0) return all;
  const unknown = names.filter((name) => !Object.hasOwn(roles, name));
  if (unknown.length > 0) {
    throw new Error(
      `NODE_SERVICES_ROLES contains unknown roles: ${unknown.join(", ")}; ` +
        `expected ${all.join(", ")}`,
    );
  }
  // Selected roles keep the host's start order.
  return all.filter((name) => names.includes(name));
}

/** The shared listener's address from NODE_SERVICES_HTTP_ADDRESS. */
export function readHttpAddress(environment: NodeJS.ProcessEnv): ListenAddress {
  // Tests bind an ephemeral port; a deployment always names its port.
  return readListenAddress(
    environment,
    "NODE_SERVICES_HTTP_ADDRESS",
    NODE_SERVICES_DEFAULT_ADDRESS,
    environment.NODE_ENV === "test",
  );
}

function requireHttp(host: RoleHost): HttpHost {
  if (!host.http) throw new Error("The shared HTTP listener is not running");
  return host.http;
}

/** Runs the selected roles; process tests start it with shorter timeouts. */
export async function main(overrides: MainOverrides = {}): Promise<void> {
  const logger = createJsonLogger({ service: "node-services" });
  const roleOverrides =
    overrides.agentRoomRequestTimeoutMs !== undefined
      ? { agentRoomRequestTimeoutMs: overrides.agentRoomRequestTimeoutMs }
      : {};
  const waitForTeamHub = overrides.waitForTeamHub ?? false;
  const waitForTeamHubReady =
    overrides.waitForTeamHubReady ?? defaultWaitForTeamHub;
  await runServiceProcess(async (control) => {
    const startupStartedAt = performance.now();
    const selected = selectRoles(process.env.NODE_SERVICES_ROLES);
    const http = selected.some((name) => HTTP_ROLES.has(name))
      ? await startHttpHost(readHttpAddress(process.env))
      : undefined;
    const normalizer = new WorkerDocumentNormalizer();
    void pruneModelPackages().then(
      (removed) => {
        if (removed.length)
          logger.log("info", "model_packages.pruned", { packages: removed });
      },
      (error: unknown) =>
        logger.log("warn", "model_packages.prune_failed", { error }),
    );
    const seams: RoleHost["seams"] = {};
    const running: { name: RoleName; role: RunningRole }[] = [];
    const roleTimingsMs: Partial<Record<RoleName, number>> = {};
    let documentStartedAt: number | undefined;
    let documentElapsedMs: number | undefined;
    let eagerDocument: Promise<RunningRole> | undefined;
    let eagerDocumentClaimed = false;
    const stopRoles = async (): Promise<void> => {
      const failures: unknown[] = [];
      const stopping = running.splice(0).reverse();
      for (const { role } of stopping) role.stopping?.();
      const voice = stopping.find(({ name }) => name === "voice");
      const voiceStopped = voice?.role.stop().catch((error) => {
        failures.push(error);
      });
      for (const { name, role } of stopping.filter(
        ({ name }) => name !== "voice",
      )) {
        control.progress(`role:${name}`, "started");
        try {
          await role.stop();
          control.progress(`role:${name}`, "completed");
        } catch (error) {
          control.progress(`role:${name}`, "failed");
          logger.log("error", "host.role_stop_failed", { error, role: name });
          failures.push(error);
        }
      }
      await voiceStopped;
      control.progress("http", "started");
      await http?.close();
      control.progress("http", "completed");
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "Node Services roles failed to stop",
        );
      }
    };
    const stopEagerDocument = async (): Promise<void> => {
      if (!eagerDocument || eagerDocumentClaimed) return;
      eagerDocumentClaimed = true;
      const pending = eagerDocument;
      eagerDocument = undefined;
      let role: RunningRole;
      try {
        role = await pending;
      } catch {
        // An eager startup failure is already surfaced or superseded by the
        // primary startup error; nothing to stop.
        return;
      }
      await role.stop();
    };
    let waitedForTeamHub = false;
    try {
      control.signal.throwIfAborted();
      if (selected.includes("document")) {
        const startedAt = performance.now();
        documentStartedAt = startedAt;
        eagerDocument = roles
          .document({
            ...control,
            http,
            logger: logger.child({ role: "document" }),
            normalizer,
            seams,
            ...roleOverrides,
          })
          .then((role) => {
            documentElapsedMs = Math.max(
              0,
              Math.round(performance.now() - startedAt),
            );
            return role;
          });
        // Prevent unhandledRejection when an earlier role fails or aborts
        // before the startup loop awaits eagerDocument.
        eagerDocument.catch(() => undefined);
      }
      for (const name of selected) {
        control.signal.throwIfAborted();
        if (
          waitForTeamHub &&
          !waitedForTeamHub &&
          TEAMHUB_DEPENDENT_ROLES.has(name)
        ) {
          waitedForTeamHub = true;
          await waitForTeamHubReady(control.signal);
          control.signal.throwIfAborted();
        }
        let role: RunningRole;
        let ms: number;
        if (name === "document" && eagerDocument) {
          eagerDocumentClaimed = true;
          role = await eagerDocument;
          eagerDocument = undefined;
          ms =
            documentElapsedMs ??
            Math.max(
              0,
              Math.round(
                performance.now() - (documentStartedAt ?? startupStartedAt),
              ),
            );
        } else {
          const roleStartedAt = performance.now();
          role = await roles[name]({
            ...control,
            http,
            logger: logger.child({ role: name }),
            normalizer,
            seams,
            ...roleOverrides,
          });
          ms = Math.max(0, Math.round(performance.now() - roleStartedAt));
        }
        running.push({ name, role });
        roleTimingsMs[name] = ms;
        logger.log("info", "host.role_started", { role: name, ms });
        control.signal.throwIfAborted();
      }
      for (const { role } of running) role.started?.();
      http?.finishStartup();
      if (http) logger.log("info", "host.listening", { url: http.url });
      logger.log("info", "host.startup_timings", {
        total_ms: Math.max(0, Math.round(performance.now() - startupStartedAt)),
        roles: roleTimingsMs,
      });
    } catch (error) {
      await Promise.allSettled([
        stopEagerDocument().catch((stopError: unknown) => {
          logger.log("error", "host.start_cleanup_failed", {
            error: stopError,
          });
        }),
        stopRoles().catch((stopError: unknown) => {
          logger.log("error", "host.start_cleanup_failed", {
            error: stopError,
          });
        }),
      ]);
      throw error;
    }
    return { close: stopRoles };
  }, SHUTDOWN_TIMEOUT_MS);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main({ waitForTeamHub: process.argv.includes("--wait-teamhub") });
}
