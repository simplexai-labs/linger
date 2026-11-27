import type {
  CapabilityLocalAsrTranscribeFailed,
  CapabilityLocalAsrTranscribeSucceeded,
  CapabilityLocalSpeechActionAccepted,
  CapabilityLocalSpeechActionRefused,
  DaemonToAgentEnvelope,
  LocalAsrTranscribeSegment,
  LocalSpeechActionRefusal,
  LocalSpeechEffectiveDevice,
  LocalSpeechFallbackReason,
  LocalSpeechRequestedDevice,
  LocalSpeechSnapshot,
  RunnerLocalSpeech as RunnerLocalSpeechFrame,
} from "@linger/wire-contracts/runner-gateway/types";
import {
  RUNNER_GATEWAY_PROTOCOL_VERSION,
  parseAgentToDaemonEnvelope,
} from "@linger/wire-contracts/runner-gateway/validator";
import { logAgentEvent } from "../observability/agent-log.js";
import {
  FIRST_LOCAL_VOICE_ASR_COMPUTER_VERSION,
  isComputerVersionAtLeast,
  LocalComputerCapabilityError,
  LocalComputerNotFoundError,
  LocalComputerOfflineError,
} from "./local-computer-management.js";
import { isServingConnection } from "./runner-connections.js";
import type {
  ConnectedRunner,
  RunnerGatewayContext,
  RunnerGatewayControllers,
} from "./runner-gateway-context.js";
import { RunnerGatewayProtocolError } from "./runner-operation.js";
import { RunnerSnapshotRelay } from "./runner-snapshot-relay.js";

export type LocalSpeechActionKind =
  | "download"
  | "cancel"
  | "remove"
  | "load"
  | "unload"
  | "configure"
  | "refresh";

/** One action on an owned Computer's local speech library or runtime. */
export interface LocalSpeechActionCommand {
  readonly tenantId: string;
  readonly ownerActorId: string;
  readonly computerId: string;
  readonly action: LocalSpeechActionKind;
  readonly modelId?: string;
  readonly useGpu?: boolean;
  readonly keepLoadedSeconds?: number;
  readonly language?: string;
  readonly includeGpuEngine?: boolean;
  readonly expiresAt: string;
  readonly signal?: AbortSignal;
}

/** The Computer's immediate answer; progress arrives as snapshots. */
export type LocalSpeechActionAck =
  | { readonly outcome: "accepted" }
  | { readonly outcome: "refused"; readonly refusal: LocalSpeechActionRefusal };

/** One local ASR transcription request relayed to an owned Computer. */
export interface LocalAsrTranscribeCommand {
  readonly tenantId: string;
  readonly ownerActorId: string;
  readonly computerId: string;
  readonly modelId?: string;
  readonly language?: string;
  readonly useGpu?: boolean;
  readonly keepLoadedSeconds?: number;
  readonly audioWavBase64: string;
  readonly signal?: AbortSignal;
}

/** Transcription result returned from the Computer's local speech sidecar. */
export interface LocalAsrTranscribeResult {
  readonly text: string;
  readonly language?: string;
  readonly duration?: number;
  readonly model: string;
  readonly requestedDevice: LocalSpeechRequestedDevice;
  readonly effectiveDevice?: LocalSpeechEffectiveDevice;
  readonly fallbackReason?: LocalSpeechFallbackReason;
  readonly segments?: readonly LocalAsrTranscribeSegment[];
}

/** The Computer did not answer a local-speech action before it expired. */
export class LocalSpeechActionTimeoutError extends Error {
  constructor() {
    super("Local Computer did not answer the local-speech action");
    this.name = "LocalSpeechActionTimeoutError";
  }
}

/** The Computer did not answer a local ASR transcription request in time. */
export class LocalAsrTranscribeTimeoutError extends Error {
  constructor() {
    super("Local Computer did not finish local ASR transcription in time");
    this.name = "LocalAsrTranscribeTimeoutError";
  }
}

/** The Computer reported a local ASR transcription failure. */
export class LocalAsrTranscribeFailedError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "LocalAsrTranscribeFailedError";
  }
}

type LocalSpeechActionOutcome =
  | CapabilityLocalSpeechActionAccepted
  | CapabilityLocalSpeechActionRefused;

type LocalAsrTranscribeOutcome =
  | CapabilityLocalAsrTranscribeSucceeded
  | CapabilityLocalAsrTranscribeFailed;

interface ActionWaiter {
  readonly connection: ConnectedRunner;
  readonly action: LocalSpeechActionKind;
  readonly modelId: string | undefined;
  readonly resolve: (outcome: LocalSpeechActionOutcome) => void;
  readonly reject: (error: unknown) => void;
}

interface TranscribeWaiter {
  readonly connection: ConnectedRunner;
  readonly resolve: (outcome: LocalAsrTranscribeOutcome) => void;
  readonly reject: (error: unknown) => void;
}

const MAX_ACTION_ACK_WAIT_MS = 30_000;
const LOCAL_ASR_TRANSCRIBE_TIMEOUT_MS = 60_000;

/**
 * Relays a Computer's local speech snapshots to TeamHub, local speech library
 * actions to the Computer, and local ASR transcription requests over the
 * Runner Gateway WebSocket.
 */
export class RunnerLocalSpeech {
  readonly #actionWaiters = new Map<string, ActionWaiter>();

  readonly #transcribeWaiters = new Map<string, TranscribeWaiter>();

  readonly #snapshotRelay: RunnerSnapshotRelay<LocalSpeechSnapshot>;

  constructor(
    private readonly context: RunnerGatewayContext,
    private readonly owners: Pick<RunnerGatewayControllers, "connections">,
  ) {
    this.#snapshotRelay = new RunnerSnapshotRelay(
      "runner.local_speech.record_failed",
      async (computerId, snapshot) => {
        await this.context.computerRegistry?.recordLocalSpeech?.(
          computerId,
          snapshot,
        );
      },
    );
  }

  receiveSnapshot(
    connection: ConnectedRunner,
    frame: RunnerLocalSpeechFrame,
  ): void {
    if (frame.revision <= connection.localSpeechRevision) {
      logAgentEvent("warn", "runner.local_speech.stale", {
        runnerId: connection.runnerId,
        revision: frame.revision,
        currentRevision: connection.localSpeechRevision,
      });
      return;
    }
    connection.localSpeechRevision = frame.revision;
    connection.localSpeechSnapshot = frame.local_speech;
    this.#snapshotRelay.enqueue(connection.runnerId, frame.local_speech);
  }

  async act(command: LocalSpeechActionCommand): Promise<LocalSpeechActionAck> {
    command.signal?.throwIfAborted();
    const connection = this.#requireCapableConnection(
      command.computerId,
      command.tenantId,
      command.ownerActorId,
    );
    const commandId = this.context.createId();
    const envelope = parseAgentToDaemonEnvelope({
      type: "execute",
      kind: "local_speech_action",
      protocol_version: RUNNER_GATEWAY_PROTOCOL_VERSION,
      command_id: commandId,
      runner_id: command.computerId,
      tenant_id: command.tenantId,
      owner_actor_id: command.ownerActorId,
      connection_epoch: connection.connectionEpoch,
      expires_at: command.expiresAt,
      action: command.action,
      ...(command.modelId === undefined ? {} : { model_id: command.modelId }),
      ...(command.useGpu === undefined ? {} : { use_gpu: command.useGpu }),
      ...(command.keepLoadedSeconds === undefined
        ? {}
        : { keep_loaded_seconds: command.keepLoadedSeconds }),
      ...(command.language === undefined ? {} : { language: command.language }),
      ...(command.includeGpuEngine === undefined
        ? {}
        : { include_gpu_engine: command.includeGpuEngine }),
    });
    const signal = command.signal;
    let onAbort: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = new Promise<LocalSpeechActionOutcome>((resolve, reject) => {
      const waitMs = Math.min(
        MAX_ACTION_ACK_WAIT_MS,
        Math.max(0, Date.parse(command.expiresAt) - Date.now()),
      );
      timer = setTimeout(
        () => reject(new LocalSpeechActionTimeoutError()),
        waitMs,
      );
      timer.unref();
      onAbort = () => reject(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#actionWaiters.set(commandId, {
        connection,
        action: command.action,
        modelId: command.modelId,
        resolve,
        reject,
      });
    });
    let result: LocalSpeechActionOutcome;
    try {
      [, result] = await Promise.all([
        this.owners.connections().sendToCurrentRunner(envelope),
        outcome,
      ]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      this.#actionWaiters.delete(commandId);
    }
    return result.outcome === "accepted"
      ? { outcome: "accepted" }
      : { outcome: "refused", refusal: result.refusal };
  }

  async transcribe(
    command: LocalAsrTranscribeCommand,
  ): Promise<LocalAsrTranscribeResult> {
    command.signal?.throwIfAborted();
    const connection = this.#requireCapableConnection(
      command.computerId,
      command.tenantId,
      command.ownerActorId,
    );
    const commandId = this.context.createId();
    const expiresAt = new Date(
      Date.now() + LOCAL_ASR_TRANSCRIBE_TIMEOUT_MS,
    ).toISOString();
    const envelope = parseAgentToDaemonEnvelope({
      type: "execute",
      kind: "local_asr_transcribe",
      protocol_version: RUNNER_GATEWAY_PROTOCOL_VERSION,
      command_id: commandId,
      runner_id: command.computerId,
      tenant_id: command.tenantId,
      owner_actor_id: command.ownerActorId,
      connection_epoch: connection.connectionEpoch,
      expires_at: expiresAt,
      ...(command.modelId === undefined ? {} : { model_id: command.modelId }),
      ...(command.language === undefined ? {} : { language: command.language }),
      ...(command.useGpu === undefined ? {} : { use_gpu: command.useGpu }),
      ...(command.keepLoadedSeconds === undefined
        ? {}
        : { keep_loaded_seconds: command.keepLoadedSeconds }),
      audio_wav_base64: command.audioWavBase64,
    });
    const signal = command.signal;
    let onAbort: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = new Promise<LocalAsrTranscribeOutcome>(
      (resolve, reject) => {
        timer = setTimeout(
          () => reject(new LocalAsrTranscribeTimeoutError()),
          LOCAL_ASR_TRANSCRIBE_TIMEOUT_MS,
        );
        timer.unref();
        onAbort = () => reject(signal?.reason);
        signal?.addEventListener("abort", onAbort, { once: true });
        this.#transcribeWaiters.set(commandId, {
          connection,
          resolve,
          reject,
        });
      },
    );
    let result: LocalAsrTranscribeOutcome;
    try {
      [, result] = await Promise.all([
        this.owners.connections().sendToCurrentRunner(envelope),
        outcome,
      ]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      this.#transcribeWaiters.delete(commandId);
    }
    if (result.outcome === "failed") {
      throw new LocalAsrTranscribeFailedError(
        result.error_code,
        result.error_message || "Local ASR transcription failed",
        result.retryable === true,
      );
    }
    return {
      text: result.text,
      ...(result.language === undefined ? {} : { language: result.language }),
      ...(result.duration === undefined ? {} : { duration: result.duration }),
      model: result.model,
      requestedDevice: result.requested_device,
      ...(result.effective_device === undefined
        ? {}
        : { effectiveDevice: result.effective_device }),
      ...(result.fallback_reason === undefined
        ? {}
        : { fallbackReason: result.fallback_reason }),
      ...(result.segments === undefined ? {} : { segments: result.segments }),
    };
  }

  receiveActionOutcome(
    connection: ConnectedRunner,
    envelope: LocalSpeechActionOutcome,
  ): void {
    if (
      envelope.connection_epoch !== connection.connectionEpoch ||
      connection.tenantOwners.get(envelope.tenant_id) !==
        envelope.owner_actor_id
    ) {
      throw new RunnerGatewayProtocolError(
        "Runner local-speech outcome identity mismatch",
      );
    }
    const waiter = this.#actionWaiters.get(envelope.command_id);
    if (!waiter) {
      logAgentEvent("info", "runner.local_speech.late_outcome", {
        runnerId: connection.runnerId,
        commandId: envelope.command_id,
        outcome: envelope.outcome,
      });
      return;
    }
    if (
      waiter.connection !== connection ||
      waiter.action !== envelope.action ||
      waiter.modelId !== envelope.model_id
    ) {
      throw new RunnerGatewayProtocolError(
        "Runner local-speech command identity mismatch",
      );
    }
    this.#actionWaiters.delete(envelope.command_id);
    waiter.resolve(envelope);
  }

  receiveTranscribeOutcome(
    connection: ConnectedRunner,
    envelope: LocalAsrTranscribeOutcome,
  ): void {
    if (
      envelope.connection_epoch !== connection.connectionEpoch ||
      connection.tenantOwners.get(envelope.tenant_id) !==
        envelope.owner_actor_id
    ) {
      throw new RunnerGatewayProtocolError(
        "Runner local-asr outcome identity mismatch",
      );
    }
    const waiter = this.#transcribeWaiters.get(envelope.command_id);
    if (!waiter) {
      logAgentEvent("info", "runner.local_asr.late_outcome", {
        runnerId: connection.runnerId,
        commandId: envelope.command_id,
        outcome: envelope.outcome,
      });
      return;
    }
    if (waiter.connection !== connection) {
      throw new RunnerGatewayProtocolError(
        "Runner local-asr command identity mismatch",
      );
    }
    this.#transcribeWaiters.delete(envelope.command_id);
    waiter.resolve(envelope);
  }

  disconnected(connection: ConnectedRunner): void {
    for (const [commandId, waiter] of this.#actionWaiters) {
      if (waiter.connection !== connection) continue;
      this.#actionWaiters.delete(commandId);
      waiter.reject(new LocalComputerOfflineError());
    }
    for (const [commandId, waiter] of this.#transcribeWaiters) {
      if (waiter.connection !== connection) continue;
      this.#transcribeWaiters.delete(commandId);
      waiter.reject(new LocalComputerOfflineError());
    }
  }

  #requireCapableConnection(
    computerId: string,
    tenantId: string,
    ownerActorId: string,
  ): ConnectedRunner {
    const connection = this.owners.connections().getConnection(computerId);
    if (!isServingConnection(connection)) {
      throw new LocalComputerOfflineError();
    }
    if (connection.tenantOwners.get(tenantId) !== ownerActorId) {
      throw new LocalComputerNotFoundError();
    }
    if (
      !isComputerVersionAtLeast(
        connection.hello.daemon_version,
        FIRST_LOCAL_VOICE_ASR_COMPUTER_VERSION,
      )
    ) {
      throw new LocalComputerCapabilityError(
        "Local Computer does not support local speech",
      );
    }
    return connection;
  }
}

export function isLocalSpeechActionOutcome(
  envelope: DaemonToAgentEnvelope,
): envelope is LocalSpeechActionOutcome {
  return (
    envelope.type === "executed" && envelope.kind === "local_speech_action"
  );
}

export function isLocalAsrTranscribeOutcome(
  envelope: DaemonToAgentEnvelope,
): envelope is LocalAsrTranscribeOutcome {
  return (
    envelope.type === "executed" && envelope.kind === "local_asr_transcribe"
  );
}
