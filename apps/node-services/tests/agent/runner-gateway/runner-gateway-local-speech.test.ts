import type {
  AgentToDaemonEnvelope,
  CapabilityLocalAsrTranscribeExecute,
  CapabilityLocalSpeechActionExecute,
  LocalSpeechSnapshot,
} from "@linger/wire-contracts/runner-gateway/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LocalComputerCapabilityError,
  LocalComputerNotFoundError,
  LocalComputerOfflineError,
} from "../../../src/agent/runner-gateway/local-computer-management.js";
import type { RunnerGatewayConnection } from "../../../src/agent/runner-gateway/runner-gateway.js";
import {
  LocalAsrTranscribeFailedError,
  LocalAsrTranscribeTimeoutError,
  LocalSpeechActionTimeoutError,
} from "../../../src/agent/runner-gateway/runner-local-speech.js";
import {
  createTestLocalComputerRegistry,
  type TestLocalComputerRegistry,
} from "../test-support/local-computer-registry.js";
import { createTestRunnerGateway } from "../test-support/runner-gateway.js";
import {
  CURRENT_RUNNER_CAPABILITIES,
  currentRunnerIdentity,
} from "../test-support/runner-capabilities.js";
import { runtimeDiagnostics } from "./runtime-diagnostics-fixture.js";

const connections: RunnerGatewayConnection[] = [];
afterEach(() => {
  for (const connection of connections.splice(0)) connection.disconnect();
});

const target = {
  computerId: "computer-speech",
  tenantId: "tenant-1",
  ownerActorId: "actor-1",
} as const;

const speechSnapshot = (revisionTag: string): LocalSpeechSnapshot => ({
  available: true,
  observed_at: new Date().toISOString(),
  tool_version: revisionTag,
  config: {
    use_gpu: true,
    keep_loaded_seconds: 900,
    language: "auto",
  },
  runtime: {
    running: true,
    state: "loaded",
    active_model: "sensevoice-small",
    engine: "sherpa-onnx",
    requested_device: "gpu",
    effective_device: "cpu",
    fallback_reason: "cpu_optimal_for_int8",
    vram_used_bytes: 0,
    ram_used_bytes: 450_000_000,
    keep_loaded_seconds: 900,
    active_sessions: 0,
  },
  models: [
    {
      id: "sensevoice-small",
      name: "SenseVoice Small",
      engine: "sherpa-onnx",
      languages: ["zh", "en"],
      language_count: 5,
      quality_rating: "fast-cjk",
      license: "MIT",
      license_url: "https://opensource.org/licenses/MIT",
      disk_size_bytes: 230_000_000,
      vram_estimate_bytes: 0,
      ram_estimate_bytes: 450_000_000,
      gpu_supported: false,
      state: "loaded",
      active: true,
    },
  ],
});

const connect = async (
  registry?: TestLocalComputerRegistry,
  daemonVersion = "0.68.0",
) => {
  const computerRegistry = registry ?? createTestLocalComputerRegistry();
  computerRegistry.enroll({ ...target });
  const gateway = createTestRunnerGateway({
    heartbeatIntervalMs: 60_000,
    computerRegistry,
  });
  const sent: AgentToDaemonEnvelope[] = [];
  const close = vi.fn();
  const connection = await gateway.acceptConnection(
    {
      runnerId: target.computerId,
      credentialGeneration: 0,
      tenantOwners: [
        { tenantId: target.tenantId, ownerActorId: target.ownerActorId },
      ],
    },
    {
      type: "runner.hello",
      platform: "linux",
      protocol_version: "2",
      daemon_version: daemonVersion,
      ...currentRunnerIdentity(),
      capabilities: [...CURRENT_RUNNER_CAPABILITIES],
      runner_id: target.computerId,
      display_name: "Studio",
      connection_nonce: "nonce-speech",
      sent_at: new Date().toISOString(),
      runtimes: ["codex"],
      runtime_diagnostics: runtimeDiagnostics(),
      workspace_grants: [],
      agent_runners: [],
      active_operations: [],
    },
    {
      send: vi.fn(async (envelope: AgentToDaemonEnvelope) => {
        sent.push(envelope);
      }),
      close,
    },
  );
  connections.push(connection);

  const report = (revision: number, tag = `v${revision}`) =>
    connection.receive({
      type: "runner.local_speech",
      protocol_version: "2",
      runner_id: target.computerId,
      sent_at: new Date().toISOString(),
      revision,
      local_speech: speechSnapshot(tag),
    });

  const nextActionCommand =
    async (): Promise<CapabilityLocalSpeechActionExecute> => {
      await vi.waitFor(() =>
        expect(sent.some(isLocalSpeechActionCommand)).toBe(true),
      );
      const value = [...sent].reverse().find(isLocalSpeechActionCommand);
      if (!value) throw new Error("Missing local_speech_action command");
      sent.splice(sent.indexOf(value), 1);
      return value;
    };

  const nextTranscribeCommand =
    async (): Promise<CapabilityLocalAsrTranscribeExecute> => {
      await vi.waitFor(() =>
        expect(sent.some(isLocalAsrTranscribeCommand)).toBe(true),
      );
      const value = [...sent].reverse().find(isLocalAsrTranscribeCommand);
      if (!value) throw new Error("Missing local_asr_transcribe command");
      sent.splice(sent.indexOf(value), 1);
      return value;
    };

  return {
    gateway,
    connection,
    computerRegistry,
    report,
    nextActionCommand,
    nextTranscribeCommand,
    close,
    sent,
  };
};

const isLocalSpeechActionCommand = (
  frame: AgentToDaemonEnvelope,
): frame is CapabilityLocalSpeechActionExecute =>
  frame.type === "execute" && frame.kind === "local_speech_action";

const isLocalAsrTranscribeCommand = (
  frame: AgentToDaemonEnvelope,
): frame is CapabilityLocalAsrTranscribeExecute =>
  frame.type === "execute" && frame.kind === "local_asr_transcribe";

const identityOf = (
  request:
    | CapabilityLocalSpeechActionExecute
    | CapabilityLocalAsrTranscribeExecute,
) => ({
  protocol_version: request.protocol_version,
  command_id: request.command_id,
  runner_id: request.runner_id,
  tenant_id: request.tenant_id,
  owner_actor_id: request.owner_actor_id,
  connection_epoch: request.connection_epoch,
  expires_at: request.expires_at,
});

const inSeconds = (seconds: number) =>
  new Date(Date.now() + seconds * 1_000).toISOString();

describe("Runner Gateway local speech", () => {
  it("records runner.local_speech snapshots in TeamHub and drops stale revisions", async () => {
    const { computerRegistry, report } = await connect();
    await report(1, "v1");
    await vi.waitFor(() =>
      expect(
        computerRegistry
          .localSpeech(target.computerId)
          .map((s) => s.tool_version),
      ).toEqual(["v1"]),
    );
    await report(1, "replayed");
    await report(2, "v2");
    await vi.waitFor(() =>
      expect(
        computerRegistry
          .localSpeech(target.computerId)
          .map((s) => s.tool_version),
      ).toEqual(["v1", "v2"]),
    );
  });

  it("enforces owner match, online state, and daemon version gate", async () => {
    const { gateway: oldGateway } = await connect(undefined, "0.67.0");
    await expect(
      oldGateway.actOnLocalSpeech({
        ...target,
        action: "refresh",
        expiresAt: inSeconds(10),
      }),
    ).rejects.toBeInstanceOf(LocalComputerCapabilityError);
    await expect(
      oldGateway.transcribeLocalAsr({
        ...target,
        audioWavBase64: "UklGRg==",
      }),
    ).rejects.toBeInstanceOf(LocalComputerCapabilityError);

    const { gateway, connection } = await connect(undefined, "0.68.0");
    await expect(
      gateway.actOnLocalSpeech({
        ...target,
        ownerActorId: "actor-other",
        action: "refresh",
        expiresAt: inSeconds(10),
      }),
    ).rejects.toBeInstanceOf(LocalComputerNotFoundError);
    await expect(
      gateway.transcribeLocalAsr({
        ...target,
        ownerActorId: "actor-other",
        audioWavBase64: "UklGRg==",
      }),
    ).rejects.toBeInstanceOf(LocalComputerNotFoundError);

    connection.disconnect();
    await expect(
      gateway.actOnLocalSpeech({
        ...target,
        action: "refresh",
        expiresAt: inSeconds(10),
      }),
    ).rejects.toBeInstanceOf(LocalComputerOfflineError);
    await expect(
      gateway.transcribeLocalAsr({
        ...target,
        audioWavBase64: "UklGRg==",
      }),
    ).rejects.toBeInstanceOf(LocalComputerOfflineError);
  });

  it("relays local_speech_action accept and refusal outcomes", async () => {
    const { gateway, connection, nextActionCommand } = await connect();
    const download = gateway.actOnLocalSpeech({
      ...target,
      action: "download",
      modelId: "sensevoice-small",
      includeGpuEngine: true,
      expiresAt: inSeconds(10),
    });
    const req1 = await nextActionCommand();
    expect(req1).toMatchObject({
      action: "download",
      model_id: "sensevoice-small",
      include_gpu_engine: true,
    });
    await connection.receive({
      type: "executed",
      kind: "local_speech_action",
      outcome: "accepted",
      ...identityOf(req1),
      action: "download",
      model_id: "sensevoice-small",
    });
    await expect(download).resolves.toEqual({ outcome: "accepted" });

    const load = gateway.actOnLocalSpeech({
      ...target,
      action: "load",
      modelId: "whisper-large-v3-turbo",
      useGpu: true,
      keepLoadedSeconds: 900,
      expiresAt: inSeconds(10),
    });
    const req2 = await nextActionCommand();
    await connection.receive({
      type: "executed",
      kind: "local_speech_action",
      outcome: "refused",
      ...identityOf(req2),
      action: "load",
      model_id: "whisper-large-v3-turbo",
      refusal: {
        code: "MODEL_FILES_MISSING",
        detail: "model not downloaded",
      },
    });
    await expect(load).resolves.toEqual({
      outcome: "refused",
      refusal: {
        code: "MODEL_FILES_MISSING",
        detail: "model not downloaded",
      },
    });
  });

  it("times out an unanswered local_speech_action cleanly", async () => {
    const { gateway, nextActionCommand } = await connect();
    const pending = gateway.actOnLocalSpeech({
      ...target,
      action: "refresh",
      expiresAt: new Date(Date.now() + 40).toISOString(),
    });
    await nextActionCommand();
    await expect(pending).rejects.toBeInstanceOf(LocalSpeechActionTimeoutError);
  });

  it("relays local_asr_transcribe success and structured failure", async () => {
    const { gateway, connection, nextTranscribeCommand } = await connect();
    const okPromise = gateway.transcribeLocalAsr({
      ...target,
      modelId: "sensevoice-small",
      language: "zh",
      useGpu: false,
      keepLoadedSeconds: 900,
      audioWavBase64: "UklGRg==",
    });
    const req1 = await nextTranscribeCommand();
    expect(req1).toMatchObject({
      model_id: "sensevoice-small",
      language: "zh",
      use_gpu: false,
      keep_loaded_seconds: 900,
      audio_wav_base64: "UklGRg==",
    });
    await connection.receive({
      type: "executed",
      kind: "local_asr_transcribe",
      outcome: "succeeded",
      ...identityOf(req1),
      text: "\u4f60\u597d",
      language: "zh",
      duration: 1.25,
      model: "sensevoice-small",
      requested_device: "cpu",
      effective_device: "cpu",
      segments: [{ start: 0, end: 1.25, text: "\u4f60\u597d" }],
    });
    await expect(okPromise).resolves.toEqual({
      text: "\u4f60\u597d",
      language: "zh",
      duration: 1.25,
      model: "sensevoice-small",
      requestedDevice: "cpu",
      effectiveDevice: "cpu",
      segments: [{ start: 0, end: 1.25, text: "\u4f60\u597d" }],
    });

    const failPromise = gateway.transcribeLocalAsr({
      ...target,
      audioWavBase64: "UklGRg==",
    });
    const req2 = await nextTranscribeCommand();
    await connection.receive({
      type: "executed",
      kind: "local_asr_transcribe",
      outcome: "failed",
      ...identityOf(req2),
      error_code: "ENGINE_START_FAILED",
      error_message: "sidecar crashed",
      retryable: true,
    });
    await expect(failPromise).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof LocalAsrTranscribeFailedError &&
        error.code === "ENGINE_START_FAILED" &&
        error.retryable === true,
    );
  });

  it("rejects in-flight local_asr_transcribe when the Computer disconnects", async () => {
    const { gateway, connection, nextTranscribeCommand } = await connect();
    const pending = gateway.transcribeLocalAsr({
      ...target,
      audioWavBase64: "UklGRg==",
    });
    await nextTranscribeCommand();
    connection.disconnect();
    await expect(pending).rejects.toBeInstanceOf(LocalComputerOfflineError);
  });

  it("exports LocalAsrTranscribeTimeoutError", () => {
    expect(new LocalAsrTranscribeTimeoutError()).toBeInstanceOf(Error);
  });
});
