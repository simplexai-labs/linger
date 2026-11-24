import { isRecord } from "@linger/service-kit";
import type { JsonLogger } from "@linger/service-kit/node";

import type { HttpHost } from "../http-host.js";
import { hasBearerToken } from "../service-bearer-auth.js";
import type { ChannelPairingProvider, PairingPollResult } from "./adapter.js";
import { readChannelsConfig, type ChannelsConfig } from "./config.js";
import { WeChatPairingManager } from "./providers/wechat-ilink.js";
import {
  ChannelSupervisor,
  isSupportedChannelProvider,
  type AdapterFactory,
} from "./supervisor.js";
import {
  HttpChannelsTeamHubClient,
  type ChannelsTeamHubClient,
} from "./teamhub-client.js";

const CHANNELS_PREFIX = "/v1/channels";
const RECONCILE_PATH = "/v1/channels:reconcile";
const WAKE_PATH = "/v1/channels:wake";
const PAIRINGS_PATH = "/v1/channels/pairings";

export interface ChannelsServiceOptions {
  readonly http: HttpHost;
  readonly logger: JsonLogger;
  readonly config?: ChannelsConfig;
  readonly teamHub?: ChannelsTeamHubClient;
  readonly pairingProviders?: readonly ChannelPairingProvider[];
  readonly createAdapter?: AdapterFactory;
  readonly fetchImpl?: typeof fetch;
}

export interface ChannelsServiceHandle {
  started(): void;
  stopping(): void;
  stop(): Promise<void>;
}

function errorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  return Response.json({ error: { code, message } }, { status });
}

function formatPairingResponse(
  result: PairingPollResult,
): Record<string, unknown> {
  return {
    pairing_id: result.pairingId,
    provider: result.provider,
    status: result.status,
    ...(result.qrCodeUrl ? { qr_code_url: result.qrCodeUrl } : {}),
    ...(result.errorCode ? { error_code: result.errorCode } : {}),
    ...(result.credentials ? { credentials: result.credentials } : {}),
    ...(result.config ? { config: result.config } : {}),
  };
}

/** Starts the network IM channels supervision role on the shared HTTP listener. */
export async function startChannelsService(
  options: ChannelsServiceOptions,
): Promise<ChannelsServiceHandle> {
  const config = options.config ?? readChannelsConfig(process.env);
  const pairingProviders = new Map<string, ChannelPairingProvider>();
  const providers = options.pairingProviders ?? [
    new WeChatPairingManager({
      logger: options.logger,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    }),
  ];
  for (const provider of providers) {
    pairingProviders.set(provider.provider, provider);
  }
  const pairingToProvider = new Map<string, ChannelPairingProvider>();

  const teamHub =
    options.teamHub ??
    (config.teamHubCredential
      ? new HttpChannelsTeamHubClient({
          baseUrl: config.teamHubBaseUrl,
          credential: config.teamHubCredential,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        })
      : undefined);

  const supervisor = teamHub
    ? new ChannelSupervisor({
        teamHub,
        logger: options.logger,
        ...(options.createAdapter
          ? { createAdapter: options.createAdapter }
          : {}),
      })
    : undefined;

  const handleRequest = async (request: Request): Promise<Response> => {
    if (
      !config.managementCredential ||
      !hasBearerToken(
        request.headers.get("authorization") ?? undefined,
        config.managementCredential,
      )
    ) {
      return errorResponse(401, "UNAUTHENTICATED", "Unauthorized");
    }
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === RECONCILE_PATH && request.method === "POST") {
      const activeBindings = supervisor ? await supervisor.reconcile() : 0;
      return Response.json({ active_bindings: activeBindings });
    }

    if (pathname === WAKE_PATH && request.method === "POST") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return errorResponse(400, "INVALID_REQUEST", "Invalid JSON body");
      }
      if (
        !isRecord(body) ||
        typeof body.room_id !== "string" ||
        !body.room_id
      ) {
        return errorResponse(400, "INVALID_REQUEST", "room_id is required");
      }
      supervisor?.wakeRoom(body.room_id);
      return new Response(null, { status: 204 });
    }

    if (pathname === PAIRINGS_PATH && request.method === "POST") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return errorResponse(400, "INVALID_REQUEST", "Invalid JSON body");
      }
      if (
        !isRecord(body) ||
        typeof body.provider !== "string" ||
        !isSupportedChannelProvider(body.provider)
      ) {
        return errorResponse(
          400,
          "CHANNEL_PROVIDER_UNSUPPORTED",
          "Unsupported IM channel provider",
        );
      }
      const provider = pairingProviders.get(body.provider);
      if (!provider) {
        return errorResponse(
          503,
          "CHANNEL_UNAVAILABLE",
          "Pairing provider is unavailable",
        );
      }
      const localTokens = Array.isArray(body.local_tokens)
        ? body.local_tokens.filter(
            (token): token is string => typeof token === "string",
          )
        : [];
      try {
        const started = await provider.startPairing(localTokens);
        pairingToProvider.set(started.pairingId, provider);
        return Response.json(formatPairingResponse(started), { status: 201 });
      } catch (err) {
        options.logger.log("warn", "channels.pairing_start_failed", {
          provider: body.provider,
          error: String(err),
        });
        return errorResponse(
          503,
          "CHANNEL_PAIRING_UNAVAILABLE",
          "Could not start IM channel pairing",
        );
      }
    }

    const verifyMatch = /^\/v1\/channels\/pairings\/([^/]+)\/verify-code$/.exec(
      pathname,
    );
    if (verifyMatch && request.method === "POST") {
      const pairingId = decodeURIComponent(verifyMatch[1]!);
      const provider = pairingToProvider.get(pairingId);
      if (!provider?.submitVerifyCode) {
        return errorResponse(
          404,
          "CHANNEL_PAIRING_NOT_FOUND",
          "Pairing session was not found",
        );
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return errorResponse(400, "INVALID_REQUEST", "Invalid JSON body");
      }
      if (
        !isRecord(body) ||
        typeof body.verify_code !== "string" ||
        !body.verify_code.trim()
      ) {
        return errorResponse(400, "INVALID_REQUEST", "verify_code is required");
      }
      const result = await provider.submitVerifyCode(
        pairingId,
        body.verify_code,
      );
      if (!result) {
        pairingToProvider.delete(pairingId);
        return errorResponse(
          404,
          "CHANNEL_PAIRING_NOT_FOUND",
          "Pairing session was not found",
        );
      }
      if (
        result.status === "confirmed" ||
        result.status === "expired" ||
        result.status === "failed" ||
        result.status === "already_connected"
      ) {
        pairingToProvider.delete(pairingId);
      }
      return Response.json(formatPairingResponse(result));
    }

    const pollMatch = /^\/v1\/channels\/pairings\/([^/]+)$/.exec(pathname);
    if (pollMatch && request.method === "GET") {
      const pairingId = decodeURIComponent(pollMatch[1]!);
      const provider = pairingToProvider.get(pairingId);
      if (!provider) {
        return errorResponse(
          404,
          "CHANNEL_PAIRING_NOT_FOUND",
          "Pairing session was not found",
        );
      }
      const result = await provider.pollPairing(pairingId);
      if (!result) {
        pairingToProvider.delete(pairingId);
        return errorResponse(
          404,
          "CHANNEL_PAIRING_NOT_FOUND",
          "Pairing session was not found",
        );
      }
      if (
        result.status === "confirmed" ||
        result.status === "expired" ||
        result.status === "failed" ||
        result.status === "already_connected"
      ) {
        pairingToProvider.delete(pairingId);
      }
      return Response.json(formatPairingResponse(result));
    }

    return errorResponse(404, "NOT_FOUND", "Channel route not found");
  };

  const unmount = options.http.mount({
    prefixes: [CHANNELS_PREFIX],
    fetch: handleRequest,
  });

  return {
    started() {
      supervisor?.startBackgroundLoops();
    },
    stopping() {
      void supervisor?.stop();
    },
    async stop() {
      unmount();
      await supervisor?.stop();
    },
  };
}
