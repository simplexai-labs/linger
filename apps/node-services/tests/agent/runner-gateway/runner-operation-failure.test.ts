import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
  formatRuntimeFailureDetail,
  formatRuntimeFailureDiagnostics,
  RuntimeExecutionError,
} from "../../../src/agent/executor/provider.js";
import { RunnerOperationState } from "../../../src/agent/runner-gateway/runner-operation.js";
import { parseDaemonToAgentEnvelope } from "@linger/wire-contracts/runner-gateway/validator";
import { setAgentLogOptions } from "../../../src/agent/observability/agent-log.js";

afterEach(() => {
  vi.unstubAllEnvs();
  setAgentLogOptions();
  vi.restoreAllMocks();
});

const fixture = parseDaemonToAgentEnvelope(
  JSON.parse(
    readFileSync(
      new URL(
        "../../../../../contracts/runner-gateway/fixtures/failure-diagnostics.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);
if (fixture.type !== "operation.failed")
  throw new Error("Expected failure fixture");

it.each([undefined, fixture.error.diagnostics, { signal: "SIGTERM" }])(
  "retains failure diagnostics through metadata logging: %j",
  async (diagnostics) => {
    vi.stubEnv("AGENT_LOG_LEVEL", "error");
    setAgentLogOptions({ format: "json" });
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    const ids = [
      "start-diag",
      fixture.operation_id,
      fixture.execution_lease_id,
    ];
    const operation = new RunnerOperationState({
      target: {
        tenantId: fixture.tenant_id,
        runnerId: fixture.runner_id,
        agentId: fixture.agent_id,
        executionContextKey: fixture.execution_context_key,
        runtimeInstanceId: fixture.runtime_instance_id,
        contextViewRef: fixture.context_view_ref,
        workspaceGrantId: fixture.workspace_grant_id,
        request: {
          kind: "run.start",
          runtime: { type: "codex" },
          session: { threadId: "missing" },
          session_options: {
            thread_name: "Test",
          },
          input: { type: "text", text: "hello" },
          run_context: { execution_run_ref: "run-1", source_inbox_ids: [] },
          run_resources: { mcp_servers: [] },
        },
      },
      connectionEpoch: fixture.connection_epoch,
      runnerRevision: fixture.runner_revision,
      createId: () => ids.shift() ?? randomUUID(),
      runtimeAssignment: {
        registrationId: fixture.registration_id,
        assignmentRevision: fixture.assignment_revision,
      },
      send: async () => {},
      cancelTimeoutMs: 1000,
    });
    const failure = fixture.error.failure;
    const envelope = parseDaemonToAgentEnvelope({
      ...fixture,
      error: { ...fixture.error, message: "codex process exited", diagnostics },
    });
    if (envelope.type !== "operation.failed")
      throw new Error("Unexpected envelope");
    const outcome = operation.handle().result.catch((error) => error);
    const { error: _failure, stage: _stage, ...identity } = fixture;
    const accepted = parseDaemonToAgentEnvelope({
      ...identity,
      type: "operation.accepted",
      command_id: operation.start.command_id,
      seq: 1,
      runner_pid: 123,
    });
    if (accepted.type !== "operation.accepted")
      throw new Error("Expected accepted");
    await operation.receive(accepted);
    await operation.receive(envelope);
    const error = await outcome;
    expect(error).toBeInstanceOf(RuntimeExecutionError);
    const expectedDetail = formatRuntimeFailureDiagnostics(diagnostics);
    expect(error.failure).toEqual({
      ...failure,
      ...(expectedDetail ? { detail: expectedDetail } : {}),
    });
    expect(error.diagnostics).toEqual(diagnostics);
    await operation.receive(envelope); // Duplicate delivery must not duplicate the failure event.
    const entries = output.mock.calls
      .map(([line]) => JSON.parse(String(line)))
      .filter((row) => row.event === "runner.operation.failed");
    expect(entries).toEqual([
      expect.objectContaining({
        operationId: operation.start.operation_id,
        agentId: fixture.agent_id,
        computerId: fixture.runner_id,
        errorCode: fixture.error.code,
        errorMessage: "codex process exited",
        ...(diagnostics ?? {}),
        failureCode: failure?.code,
        runtimeType: "codex",
      }),
    ]);
    expect(entries[0].errorMessage).toBe("codex process exited");
  },
);

it("redacts secrets and home paths cleanly via sensitive-text", () => {
  const detail = formatRuntimeFailureDetail(
    "\n\u26a0 FAILED_PRECONDITION (code 400): User location is not supported for the API use. File /Users/alice/work/run.log Authorization: Bearer sk-secret1234567890abcdefghij\n",
  );
  expect(detail).toBe(
    "\u26a0 FAILED_PRECONDITION (code 400): User location is not supported for the API use. File ~/work/run.log Authorization: Bearer [Redacted]",
  );
  expect(
    formatRuntimeFailureDetail(
      "Authorization: CustomScheme secret-val\nCookie: a=1; session=secret\nSet-Cookie: sid=xyz; HttpOnly",
    ),
  ).toBe("Authorization: [Redacted] Cookie: [Redacted] Set-Cookie: [Redacted]");
  expect(formatRuntimeFailureDetail("   \n\t  ")).toBeUndefined();
});

it("strips whitespace-only or control-only Daemon failure.detail instead of forwarding it", async () => {
  const operation = new RunnerOperationState({
    target: {
      tenantId: fixture.tenant_id,
      runnerId: fixture.runner_id,
      agentId: fixture.agent_id,
      executionContextKey: fixture.execution_context_key,
      runtimeInstanceId: fixture.runtime_instance_id,
      contextViewRef: fixture.context_view_ref,
      workspaceGrantId: fixture.workspace_grant_id,
      request: {
        kind: "run.start",
        runtime: { type: "codex" },
        session: { threadId: "missing" },
        session_options: { thread_name: "Test" },
        input: { type: "text", text: "hello" },
        run_context: { execution_run_ref: "run-3", source_inbox_ids: [] },
        run_resources: { mcp_servers: [] },
      },
    },
    connectionEpoch: fixture.connection_epoch,
    runnerRevision: fixture.runner_revision,
    createId: () => randomUUID(),
    runtimeAssignment: {
      registrationId: fixture.registration_id,
      assignmentRevision: fixture.assignment_revision,
    },
    send: async () => {},
    cancelTimeoutMs: 1000,
  });
  const outcome = operation.handle().result.catch((error) => error);
  const { error: _failure, stage: _stage, ...identity } = fixture;
  const accepted = parseDaemonToAgentEnvelope({
    ...identity,
    operation_id: operation.start.operation_id,
    execution_lease_id: operation.start.execution_lease_id,
    type: "operation.accepted",
    command_id: operation.start.command_id,
    seq: 1,
    runner_pid: 123,
  });
  const failed = parseDaemonToAgentEnvelope({
    ...fixture,
    operation_id: operation.start.operation_id,
    execution_lease_id: operation.start.execution_lease_id,
    error: {
      ...fixture.error,
      failure: {
        code: "execution_failed",
        runtime_type: "codex",
        detail: "   \n\t  ",
      },
    },
  });
  if (
    accepted.type !== "operation.accepted" ||
    failed.type !== "operation.failed"
  )
    throw new Error("Unexpected envelopes");
  await operation.receive(accepted);
  await operation.receive(failed);
  const error = await outcome;
  expect(error).toBeInstanceOf(RuntimeExecutionError);
  expect(error.failure).toEqual({
    code: "execution_failed",
    runtime_type: "codex",
  });
  expect("detail" in error.failure).toBe(false);
});

it("keeps Daemon-supplied failure.detail without re-appending diagnostics", async () => {
  const operation = new RunnerOperationState({
    target: {
      tenantId: fixture.tenant_id,
      runnerId: fixture.runner_id,
      agentId: fixture.agent_id,
      executionContextKey: fixture.execution_context_key,
      runtimeInstanceId: fixture.runtime_instance_id,
      contextViewRef: fixture.context_view_ref,
      workspaceGrantId: fixture.workspace_grant_id,
      request: {
        kind: "run.start",
        runtime: { type: "codex" },
        session: { threadId: "missing" },
        session_options: { thread_name: "Test" },
        input: { type: "text", text: "hello" },
        run_context: { execution_run_ref: "run-2", source_inbox_ids: [] },
        run_resources: { mcp_servers: [] },
      },
    },
    connectionEpoch: fixture.connection_epoch,
    runnerRevision: fixture.runner_revision,
    createId: () => randomUUID(),
    runtimeAssignment: {
      registrationId: fixture.registration_id,
      assignmentRevision: fixture.assignment_revision,
    },
    send: async () => {},
    cancelTimeoutMs: 1000,
  });
  const outcome = operation.handle().result.catch((error) => error);
  const { error: _failure, stage: _stage, ...identity } = fixture;
  const accepted = parseDaemonToAgentEnvelope({
    ...identity,
    operation_id: operation.start.operation_id,
    execution_lease_id: operation.start.execution_lease_id,
    type: "operation.accepted",
    command_id: operation.start.command_id,
    seq: 1,
    runner_pid: 123,
  });
  const failed = parseDaemonToAgentEnvelope({
    ...fixture,
    operation_id: operation.start.operation_id,
    execution_lease_id: operation.start.execution_lease_id,
    error: {
      ...fixture.error,
      failure: {
        code: "rate_limited",
        runtime_type: "codex",
        detail: "Quota exceeded (HTTP 429)",
      },
    },
  });
  if (
    accepted.type !== "operation.accepted" ||
    failed.type !== "operation.failed"
  )
    throw new Error("Unexpected envelopes");
  await operation.receive(accepted);
  await operation.receive(failed);
  const error = await outcome;
  expect(error).toBeInstanceOf(RuntimeExecutionError);
  expect(error.failure.detail).toBe("Quota exceeded (HTTP 429)");
});
