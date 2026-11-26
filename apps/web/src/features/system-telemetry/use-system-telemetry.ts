import { useCallback, useEffect, useState } from "react";

import type {
  EventSourceFactory,
  EventSourceLike,
} from "@/features/teamhub/event-stream";
import { reportTeamHubAuthenticationRequired } from "@/features/teamhub/teamhub-authentication";
import { teamHubData, teamHubUrl } from "@/features/teamhub/teamhub-api";
import { resolveTeamHubBaseUrl } from "@/features/teamhub/teamhub-base-url";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import { TeamHubError } from "@/features/teamhub/teamhub-error";

import { appendHistoryPoint } from "./telemetry-math";
import type {
  SystemTelemetryErrorCode,
  SystemTelemetryStreamStatus,
  SystemTelemetryView,
  TelemetryHistoryPoint,
  TelemetryStreamPhase,
} from "./telemetry-types";

const MAX_RECONNECT_DELAY_MS = 15_000;
const BASE_RECONNECT_DELAY_MS = 1_500;

export interface UseSystemTelemetryOptions {
  readonly baseUrl?: string;
  readonly client: Pick<TeamHubClient, "api">;
  readonly computerId?: string;
  readonly computerOnline: boolean;
  readonly eventSourceFactory?: EventSourceFactory;
  readonly paused: boolean;
  readonly tenantId: string;
}

export interface SystemTelemetryState {
  readonly errorCode: SystemTelemetryErrorCode | null;
  readonly errorMessage: string | null;
  readonly history: readonly TelemetryHistoryPoint[];
  readonly hiddenPaused: boolean;
  readonly phase: TelemetryStreamPhase;
  readonly retry: () => void;
  readonly view: SystemTelemetryView | null;
}

interface InternalTelemetryState {
  readonly computerKey: string | null;
  readonly errorCode: SystemTelemetryErrorCode | null;
  readonly errorMessage: string | null;
  readonly history: readonly TelemetryHistoryPoint[];
  readonly streamPhase: TelemetryStreamPhase;
  readonly view: SystemTelemetryView | null;
}

function defaultEventSourceFactory(
  url: string,
  init: { withCredentials: boolean },
): EventSourceLike {
  return new EventSource(url, init);
}

function classifyErrorCode(code: string | undefined): {
  errorCode: SystemTelemetryErrorCode | null;
  phase: TelemetryStreamPhase;
  terminal: boolean;
} {
  switch (code) {
    case "LOCAL_COMPUTER_OFFLINE":
      return {
        errorCode: "LOCAL_COMPUTER_OFFLINE",
        phase: "offline",
        terminal: true,
      };
    case "SYSTEM_TELEMETRY_UNSUPPORTED":
      return {
        errorCode: "SYSTEM_TELEMETRY_UNSUPPORTED",
        phase: "unsupported",
        terminal: true,
      };
    case "SYSTEM_TELEMETRY_FORBIDDEN":
      return {
        errorCode: "SYSTEM_TELEMETRY_FORBIDDEN",
        phase: "forbidden",
        terminal: true,
      };
    case "SYSTEM_TELEMETRY_TIMEOUT":
      return {
        errorCode: "SYSTEM_TELEMETRY_TIMEOUT",
        phase: "error",
        terminal: false,
      };
    case "SYSTEM_TELEMETRY_UNAVAILABLE":
      return {
        errorCode: "SYSTEM_TELEMETRY_UNAVAILABLE",
        phase: "error",
        terminal: false,
      };
    default:
      return { errorCode: null, phase: "error", terminal: false };
  }
}

function isDocumentHidden(): boolean {
  return (
    typeof document !== "undefined" && document.visibilityState === "hidden"
  );
}

/**
 * Subscribes to TeamHub's on-demand 1 Hz system telemetry SSE stream for one
 * Local Computer. The subscription effect depends strictly on resource identity
 * (`tenantId`, `computerId`, `computerOnline`, `paused`, document visibility,
 * and retry nonce) so unrelated UI rerenders never recreate the stream.
 */
export function useSystemTelemetry({
  baseUrl,
  client,
  computerId,
  computerOnline,
  eventSourceFactory,
  paused,
  tenantId,
}: UseSystemTelemetryOptions): SystemTelemetryState {
  const computerKey = computerId ? `${tenantId}:${computerId}` : null;
  const [hidden, setHidden] = useState<boolean>(isDocumentHidden);
  const [retryNonce, setRetryNonce] = useState(0);
  const [state, setState] = useState<InternalTelemetryState>(() => ({
    computerKey,
    errorCode: null,
    errorMessage: null,
    history: [],
    streamPhase: "loading",
    view: null,
  }));

  // Reset snapshot & history immediately when switching target Computers so
  // metrics from one host are never flashed under another host's header.
  if (state.computerKey !== computerKey) {
    setState({
      computerKey,
      errorCode: null,
      errorMessage: null,
      history: [],
      streamPhase: "loading",
      view: null,
    });
  }

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibilityChange = () => {
      setHidden(document.visibilityState === "hidden");
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  const retry = useCallback(() => {
    setState((previous) => ({
      ...previous,
      errorCode: null,
      errorMessage: null,
      streamPhase: previous.view ? "live" : "loading",
    }));
    setRetryNonce((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!computerId || !computerOnline || paused || hidden) return;
    return openSystemTelemetryStream({
      baseUrl,
      client,
      computerId,
      eventSourceFactory,
      onSnapshot: (view) => {
        setState((previous) => ({
          computerKey: `${tenantId}:${computerId}`,
          errorCode: null,
          errorMessage: null,
          history: appendHistoryPoint(previous.history, view),
          streamPhase: "live",
          view,
        }));
      },
      onStatus: (nextPhase, errorCode, errorMessage) => {
        setState((previous) => ({
          ...previous,
          errorCode,
          errorMessage,
          streamPhase: nextPhase,
        }));
      },
      tenantId,
    });
  }, [
    baseUrl,
    client,
    computerId,
    computerOnline,
    eventSourceFactory,
    hidden,
    paused,
    retryNonce,
    tenantId,
  ]);

  let phase: TelemetryStreamPhase;
  if (!computerOnline) {
    phase = "offline";
  } else if (paused || hidden) {
    phase = state.view ? "paused" : state.streamPhase;
  } else {
    phase = state.streamPhase;
  }

  return {
    errorCode: !computerOnline ? "LOCAL_COMPUTER_OFFLINE" : state.errorCode,
    errorMessage: state.errorMessage,
    history: state.history,
    hiddenPaused: hidden && !paused,
    phase,
    retry,
    view: state.view,
  };
}

interface OpenSystemTelemetryStreamOptions {
  readonly baseUrl?: string;
  readonly client: Pick<TeamHubClient, "api">;
  readonly computerId: string;
  readonly eventSourceFactory?: EventSourceFactory;
  readonly onSnapshot: (view: SystemTelemetryView) => void;
  readonly onStatus: (
    phase: TelemetryStreamPhase,
    errorCode: SystemTelemetryErrorCode | null,
    errorMessage: string | null,
  ) => void;
  readonly tenantId: string;
}

/**
 * Opens one credentialed SSE subscription for a Computer's system telemetry
 * stream, probing the REST snapshot endpoint on error to classify terminal
 * codes (`SYSTEM_TELEMETRY_UNSUPPORTED`, `LOCAL_COMPUTER_OFFLINE`,
 * `SYSTEM_TELEMETRY_FORBIDDEN`), and returns a cleanup disposer.
 */
function openSystemTelemetryStream({
  baseUrl,
  client,
  computerId,
  eventSourceFactory,
  onSnapshot,
  onStatus,
  tenantId,
}: OpenSystemTelemetryStreamOptions): () => void {
  let disposed = false;
  let source: EventSourceLike | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempt = 0;
  const probeController = new AbortController();
  const factory = eventSourceFactory ?? defaultEventSourceFactory;
  const resolvedBaseUrl = resolveTeamHubBaseUrl(baseUrl);
  const streamUrl = teamHubUrl(
    resolvedBaseUrl,
    "/v0/tenants/{tenantId}/local-computers/{computerId}/system-telemetry/stream",
    { path: { computerId, tenantId } },
  );

  const closeSource = () => {
    source?.close();
    source = undefined;
  };

  const clearReconnectTimer = () => {
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
  };

  const applySnapshot = (view: SystemTelemetryView) => {
    if (disposed) return;
    reconnectAttempt = 0;
    onSnapshot(view);
  };

  const scheduleReconnect = () => {
    if (disposed) return;
    clearReconnectTimer();
    const delay = Math.min(
      MAX_RECONNECT_DELAY_MS,
      BASE_RECONNECT_DELAY_MS * 2 ** Math.min(reconnectAttempt, 4),
    );
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      openStream();
    }, delay);
  };

  const probeAfterError = async () => {
    try {
      const snapshotView = await teamHubData(
        client.api.GET(
          "/v0/tenants/{tenantId}/local-computers/{computerId}/system-telemetry",
          {
            params: { path: { computerId, tenantId } },
            signal: probeController.signal,
          },
        ),
      );
      if (disposed) return;
      applySnapshot(snapshotView);
      scheduleReconnect();
    } catch (error: unknown) {
      if (disposed) return;
      if (error instanceof Error && error.name === "AbortError") return;
      if (error instanceof TeamHubError) {
        const classified = classifyErrorCode(error.code);
        onStatus(classified.phase, classified.errorCode, error.message);
        if (!classified.terminal) {
          scheduleReconnect();
        }
        return;
      }
      onStatus(
        "error",
        "SYSTEM_TELEMETRY_UNAVAILABLE",
        error instanceof Error ? error.message : null,
      );
      scheduleReconnect();
    }
  };

  const openStream = () => {
    if (disposed) return;
    closeSource();
    let candidate: EventSourceLike;
    try {
      candidate = factory(streamUrl.href, { withCredentials: true });
    } catch {
      void probeAfterError();
      return;
    }
    source = candidate;

    candidate.addEventListener("telemetry.snapshot", (event) => {
      if (disposed || source !== candidate) return;
      try {
        const payload = JSON.parse(String(event.data)) as SystemTelemetryView;
        applySnapshot(payload);
      } catch {
        // Ignore malformed frames rather than tearing down a healthy stream.
      }
    });

    candidate.addEventListener("telemetry.status", (event) => {
      if (disposed || source !== candidate) return;
      try {
        const status = JSON.parse(
          String(event.data),
        ) as SystemTelemetryStreamStatus;
        const classified = classifyErrorCode(status.code);
        closeSource();
        clearReconnectTimer();
        onStatus(
          status.status === "unsupported"
            ? "unsupported"
            : status.status === "offline"
              ? "offline"
              : classified.phase,
          status.code,
          status.message,
        );
        if (!classified.terminal && status.status === "unavailable") {
          scheduleReconnect();
        }
      } catch {
        // Ignore malformed status frame.
      }
    });

    candidate.addEventListener("session.expired", () => {
      if (disposed || source !== candidate) return;
      closeSource();
      clearReconnectTimer();
      reportTeamHubAuthenticationRequired("session-expired");
    });

    candidate.addEventListener("error", () => {
      if (disposed || source !== candidate) return;
      closeSource();
      void probeAfterError();
    });
  };

  openStream();

  return () => {
    disposed = true;
    probeController.abort();
    clearReconnectTimer();
    closeSource();
  };
}
