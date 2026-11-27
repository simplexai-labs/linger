import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TERMINAL_MESSAGE_TYPES = new Set([
  "operation.completed",
  "operation.failed",
  "operation.cancelled",
]);

// Sequenced Operation frames emitted by the Daemon. Non-sequenced frames such
// as operation.prepared do not belong to the admitted Operation ledger.
const DAEMON_OPERATION_MESSAGE_TYPES = new Set([
  "operation.accepted",
  "operation.event",
  "operation.input_result",
  ...TERMINAL_MESSAGE_TYPES,
]);

export function parseProxyEvents(ndjsonText) {
  if (typeof ndjsonText !== "string" || ndjsonText.length === 0) return [];
  const events = [];
  for (const rawLine of ndjsonText.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        events.push(parsed);
      }
    } catch {
      // Ignore a truncated or malformed trailing line under concurrent appends.
    }
  }
  return events;
}

export function buildOperationLedger(events) {
  const internal = new Map();
  const ensure = (operationId) => {
    let entry = internal.get(operationId);
    if (!entry) {
      entry = {
        operation_id: operationId,
        agent_id: null,
        run_id: null,
        connection_epoch: null,
        request_kind: null,
        status: "unknown",
        max_emitted_seq: 0,
        max_forwarded_ack_seq: 0,
        max_blocked_ack_seq: 0,
        terminal: null,
        emittedConnections: new Set(),
        hasStart: false,
      };
      internal.set(operationId, entry);
    }
    return entry;
  };

  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const operationId =
      typeof event.operation_id === "string" && event.operation_id.length > 0
        ? event.operation_id
        : null;
    if (!operationId) continue;

    if (event.type === "agent_to_daemon") {
      if (event.message_type === "operation.start") {
        const entry = ensure(operationId);
        // Prefer operation.start metadata over backfilled downstream fields.
        if (!entry.hasStart) {
          if (typeof event.agent_id === "string")
            entry.agent_id = event.agent_id;
          if (typeof event.run_id === "string") entry.run_id = event.run_id;
          if (typeof event.connection_epoch === "number")
            entry.connection_epoch = event.connection_epoch;
          if (typeof event.request_kind === "string")
            entry.request_kind = event.request_kind;
          entry.hasStart = true;
        }
        if (entry.status !== "terminal") entry.status = "running";
      } else if (event.message_type === "operation.ack") {
        const entry = ensure(operationId);
        if (entry.agent_id === null && typeof event.agent_id === "string") {
          entry.agent_id = event.agent_id;
        }
        if (
          entry.connection_epoch === null &&
          typeof event.connection_epoch === "number"
        ) {
          entry.connection_epoch = event.connection_epoch;
        }
        if (
          typeof event.through_seq === "number" &&
          event.through_seq > entry.max_forwarded_ack_seq
        ) {
          entry.max_forwarded_ack_seq = event.through_seq;
        }
      }
      continue;
    }

    if (
      event.type === "blocked_agent_to_daemon" &&
      event.message_type === "operation.ack"
    ) {
      const entry = ensure(operationId);
      if (
        typeof event.through_seq === "number" &&
        event.through_seq > entry.max_blocked_ack_seq
      ) {
        entry.max_blocked_ack_seq = event.through_seq;
      }
      continue;
    }

    if (
      event.type === "daemon_to_agent" &&
      DAEMON_OPERATION_MESSAGE_TYPES.has(event.message_type)
    ) {
      const entry = ensure(operationId);
      if (entry.agent_id === null && typeof event.agent_id === "string") {
        entry.agent_id = event.agent_id;
      }
      if (
        entry.connection_epoch === null &&
        typeof event.connection_epoch === "number"
      ) {
        entry.connection_epoch = event.connection_epoch;
      }
      if (typeof event.seq === "number") {
        if (event.seq > entry.max_emitted_seq) {
          entry.max_emitted_seq = event.seq;
        }
        if (typeof event.connection_id === "number") {
          entry.emittedConnections.add(event.connection_id);
        }
      }
      if (TERMINAL_MESSAGE_TYPES.has(event.message_type)) {
        entry.status = "terminal";
        entry.terminal = {
          type: event.message_type,
          seq:
            typeof event.seq === "number" ? event.seq : entry.max_emitted_seq,
          connection_id:
            typeof event.connection_id === "number"
              ? event.connection_id
              : null,
        };
      } else if (
        event.message_type === "operation.accepted" &&
        entry.status !== "terminal"
      ) {
        entry.status = "running";
      }
    }
  }

  const ledger = new Map();
  for (const [operationId, entry] of internal) {
    ledger.set(operationId, {
      operation_id: entry.operation_id,
      agent_id: entry.agent_id,
      run_id: entry.run_id,
      connection_epoch: entry.connection_epoch,
      request_kind: entry.request_kind,
      status: entry.status,
      max_emitted_seq: entry.max_emitted_seq,
      max_forwarded_ack_seq: entry.max_forwarded_ack_seq,
      max_blocked_ack_seq: entry.max_blocked_ack_seq,
      terminal: entry.terminal,
      emitted_connections: [...entry.emittedConnections].sort(
        (left, right) => left - right,
      ),
    });
  }
  return ledger;
}

export function activeRunOwners(ledger, expectedCount) {
  const owners = [...ledger.values()]
    .filter(
      (entry) =>
        entry.request_kind === "run.start" && entry.status === "running",
    )
    .map((entry) => ({
      agent_id: entry.agent_id,
      operation_id: entry.operation_id,
    }))
    .sort((left, right) => left.operation_id.localeCompare(right.operation_id));
  return owners.length === expectedCount ? owners : null;
}

export function unacknowledgedRuns(ledger, expectedCount) {
  const rows = [...ledger.values()]
    .filter(
      (entry) =>
        entry.request_kind === "run.start" &&
        entry.max_emitted_seq > entry.max_forwarded_ack_seq &&
        entry.max_blocked_ack_seq > 0,
    )
    .map((entry) => ({
      operation_id: entry.operation_id,
      agent_id: entry.agent_id,
      last_emitted_seq: entry.max_emitted_seq,
      connection_id: entry.emitted_connections.at(-1) ?? null,
    }))
    .sort((left, right) => left.operation_id.localeCompare(right.operation_id));
  return rows.length === expectedCount ? rows : null;
}

export function verifyReplayedAcks(ledger, expectedRows, minConnectionId) {
  if (!Array.isArray(expectedRows) || expectedRows.length === 0) return false;
  return expectedRows.every(({ operation_id, last_emitted_seq }) => {
    const entry = ledger.get(operation_id);
    return (
      entry !== undefined &&
      entry.max_forwarded_ack_seq >= last_emitted_seq &&
      entry.emitted_connections.some((id) => id >= minConnectionId)
    );
  });
}

export function countRunStarts(ledger, agentId) {
  let count = 0;
  for (const entry of ledger.values()) {
    if (entry.request_kind !== "run.start") continue;
    if (agentId && entry.agent_id !== agentId) continue;
    count += 1;
  }
  return count;
}

export function assertTerminalSummary(ledger, expectedRunStartCount) {
  const unsettled = [...ledger.values()].filter(
    (entry) =>
      entry.status !== "terminal" ||
      entry.max_emitted_seq < 1 ||
      entry.max_forwarded_ack_seq < entry.max_emitted_seq,
  );
  if (unsettled.length > 0) {
    throw new Error(
      `Unsettled proxy ledger operations: ${JSON.stringify(unsettled)}`,
    );
  }
  const runStartCount = countRunStarts(ledger);
  if (runStartCount !== expectedRunStartCount) {
    throw new Error(
      `Unexpected run.start operation count: expected ${expectedRunStartCount}, observed ${runStartCount}`,
    );
  }
  return { run_start_count: runStartCount, total_operations: ledger.size };
}

function matchingReceipts(runtimeState, ledger, agentId, expectedEpoch) {
  return (runtimeState?.operation_receipts ?? []).filter((receipt) => {
    if (receipt.agent_id !== agentId) return false;
    if (expectedEpoch === undefined) return true;
    return ledger.get(receipt.operation_id)?.connection_epoch === expectedEpoch;
  });
}

export function checkReceiptTerminal(
  runtimeState,
  ledger,
  agentId,
  expectedCount,
  expectedEpoch,
) {
  const starts = matchingReceipts(runtimeState, ledger, agentId, expectedEpoch);
  if (starts.length < expectedCount) return false;
  const latest = starts.at(-1);
  if (!latest) return false;
  const operation = ledger.get(latest.operation_id);
  return Boolean(
    operation &&
    operation.status === "terminal" &&
    operation.terminal !== null &&
    operation.terminal.seq >= 1 &&
    operation.max_forwarded_ack_seq >= operation.terminal.seq,
  );
}

export function checkReceiptCount(
  runtimeState,
  ledger,
  agentId,
  expectedCount,
  expectedEpoch,
) {
  return (
    matchingReceipts(runtimeState, ledger, agentId, expectedEpoch).length ===
    expectedCount
  );
}

export function checkLiveReceipt(
  runtimeState,
  ledger,
  kind,
  agentId,
  runOrdinal,
  expectedTerminal,
) {
  const run = (runtimeState?.runs ?? []).filter(
    (candidate) => candidate.context_kind === kind,
  )[runOrdinal - 1];
  if (!run) return null;
  const starts = (runtimeState?.operation_receipts ?? []).filter(
    (receipt) => receipt.agent_id === agentId && receipt.run_id === run.run_id,
  );
  if (starts.length !== 1) return null;
  const receipt = starts[0];
  const operation = ledger.get(receipt.operation_id);
  if (!operation) return null;
  if (expectedTerminal === 1) {
    if (
      operation.status !== "terminal" ||
      operation.terminal === null ||
      operation.terminal.seq < 1 ||
      operation.max_forwarded_ack_seq < operation.terminal.seq
    ) {
      return null;
    }
  } else if (operation.status !== "running" || operation.terminal !== null) {
    return null;
  }
  return {
    operation_id: operation.operation_id,
    run_id: run.run_id,
    connection_epoch: operation.connection_epoch,
  };
}

export function checkActiveOperation(
  runtimeState,
  ledger,
  kind,
  agentId,
  runOrdinal,
) {
  const run = (runtimeState?.runs ?? []).filter(
    (candidate) => candidate.context_kind === kind,
  )[runOrdinal - 1];
  if (!run) return null;
  const operationIds = [
    ...new Set(
      (runtimeState?.operation_receipts ?? [])
        .filter(
          (receipt) =>
            receipt.agent_id === agentId && receipt.run_id === run.run_id,
        )
        .map((receipt) => receipt.operation_id),
    ),
  ];
  if (operationIds.length !== 1) return null;
  const operation = ledger.get(operationIds[0]);
  if (!operation || operation.status !== "running") return null;
  return {
    operation_id: operation.operation_id,
    run_id: run.run_id,
    connection_epoch: operation.connection_epoch,
  };
}

export function checkUnacknowledgedCancel(ledger, operationId) {
  const operation = ledger.get(operationId);
  if (
    !operation ||
    operation.terminal?.type !== "operation.cancelled" ||
    operation.terminal.seq < 1 ||
    operation.max_forwarded_ack_seq >= operation.terminal.seq
  ) {
    return null;
  }
  return {
    operation_id: operationId,
    through_seq: operation.terminal.seq,
  };
}

export function verifySoakLedger(runtimeState, ledger, agentId, expectedCount) {
  const runs = (runtimeState?.runs ?? []).filter(
    (run) => run.agent_id === agentId && run.context_kind === "meta",
  );
  if (
    runs.length !== expectedCount ||
    new Set(runs.map((run) => run.run_id)).size !== expectedCount ||
    runs.some(
      (run) => run.status !== "succeeded" || run.terminal_type !== "succeeded",
    )
  ) {
    throw new Error(`Unexpected soak Local Runs: ${JSON.stringify(runs)}`);
  }
  const runIds = new Set(runs.map((run) => run.run_id));
  const receipts = (runtimeState?.operation_receipts ?? []).filter(
    (receipt) => receipt.agent_id === agentId && runIds.has(receipt.run_id),
  );
  if (
    receipts.length !== expectedCount ||
    new Set(receipts.map((receipt) => receipt.operation_id)).size !==
      expectedCount ||
    runs.some(
      (run) =>
        receipts.filter((receipt) => receipt.run_id === run.run_id).length !==
        1,
    )
  ) {
    throw new Error(
      `Unexpected soak Operation receipts: ${JSON.stringify(receipts)}`,
    );
  }
  for (const receipt of receipts) {
    const operation = ledger.get(receipt.operation_id);
    if (
      !operation ||
      operation.status !== "terminal" ||
      operation.terminal === null ||
      operation.max_emitted_seq < 1 ||
      operation.max_forwarded_ack_seq !== operation.max_emitted_seq
    ) {
      throw new Error(
        `Operation ${receipt.operation_id} is not terminal and fully acknowledged`,
      );
    }
  }
  const unsettled = [...ledger.values()].filter(
    (operation) =>
      operation.status !== "terminal" ||
      operation.max_emitted_seq < 1 ||
      operation.max_forwarded_ack_seq !== operation.max_emitted_seq,
  );
  if (unsettled.length !== 0) {
    throw new Error(
      `Unsettled daemon ledger rows: ${JSON.stringify(unsettled)}`,
    );
  }
}

export function assertNoEnsureSince(events, agentId, minConnectionId) {
  const unexpected = events.filter(
    (event) =>
      event?.type === "agent_to_daemon" &&
      event.message_type === "agent_runner.ensure" &&
      event.agent_id === agentId &&
      typeof event.connection_id === "number" &&
      event.connection_id >= minConnectionId,
  );
  if (unexpected.length > 0) {
    throw new Error(
      `Unexpected agent_runner.ensure for revoked Agent ${agentId} since connection ${minConnectionId}: ${JSON.stringify(unexpected)}`,
    );
  }
}

function readProxyEventsFile(filename) {
  try {
    return parseProxyEvents(readFileSync(filename, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function readJsonFile(filename) {
  return JSON.parse(readFileSync(filename, "utf8"));
}

function parseOptionalNumber(text) {
  if (text === undefined || text === "") return undefined;
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Invalid integer argument: ${text}`);
  }
  return value;
}

function runCli(argv) {
  const [command, ...args] = argv;
  switch (command) {
    case "active-run-owners": {
      const [proxyEventsPath, expectedCountText, outputPath] = args;
      const ledger = buildOperationLedger(readProxyEventsFile(proxyEventsPath));
      const owners = activeRunOwners(ledger, Number(expectedCountText));
      if (!owners) return 1;
      writeFileSync(outputPath, JSON.stringify(owners));
      return 0;
    }
    case "unacknowledged-runs": {
      const [proxyEventsPath, expectedCountText, outputPath] = args;
      const ledger = buildOperationLedger(readProxyEventsFile(proxyEventsPath));
      const rows = unacknowledgedRuns(ledger, Number(expectedCountText));
      if (!rows) return 1;
      writeFileSync(outputPath, JSON.stringify(rows));
      return 0;
    }
    case "verify-replayed-acks": {
      const [proxyEventsPath, expectedPath, minConnectionIdText] = args;
      const ledger = buildOperationLedger(readProxyEventsFile(proxyEventsPath));
      const expected = readJsonFile(expectedPath);
      return verifyReplayedAcks(ledger, expected, Number(minConnectionIdText))
        ? 0
        : 1;
    }
    case "run-start-count": {
      const [proxyEventsPath, agentId] = args;
      const ledger = buildOperationLedger(readProxyEventsFile(proxyEventsPath));
      const count = countRunStarts(ledger, agentId || undefined);
      process.stdout.write(`${JSON.stringify(count)}\n`);
      return 0;
    }
    case "terminal-summary": {
      const [proxyEventsPath, expectedRunStartCountText] = args;
      const ledger = buildOperationLedger(readProxyEventsFile(proxyEventsPath));
      const summary = assertTerminalSummary(
        ledger,
        Number(expectedRunStartCountText),
      );
      process.stdout.write(`${JSON.stringify(summary)}\n`);
      return 0;
    }
    case "wait-receipt-terminal": {
      const [
        runtimeStatePath,
        proxyEventsPath,
        agentId,
        expectedCountText,
        expectedEpochText,
      ] = args;
      const runtimeState = readJsonFile(runtimeStatePath);
      const ledger = buildOperationLedger(readProxyEventsFile(proxyEventsPath));
      return checkReceiptTerminal(
        runtimeState,
        ledger,
        agentId,
        Number(expectedCountText),
        parseOptionalNumber(expectedEpochText),
      )
        ? 0
        : 1;
    }
    case "assert-receipt-count": {
      const [
        runtimeStatePath,
        proxyEventsPath,
        agentId,
        expectedCountText,
        expectedEpochText,
      ] = args;
      const runtimeState = readJsonFile(runtimeStatePath);
      const ledger = buildOperationLedger(readProxyEventsFile(proxyEventsPath));
      return checkReceiptCount(
        runtimeState,
        ledger,
        agentId,
        Number(expectedCountText),
        parseOptionalNumber(expectedEpochText),
      )
        ? 0
        : 1;
    }
    case "wait-live-receipt": {
      const [
        runtimeStatePath,
        proxyEventsPath,
        kind,
        agentId,
        runOrdinalText,
        expectedTerminalText,
        outputPath,
      ] = args;
      const runtimeState = readJsonFile(runtimeStatePath);
      const ledger = buildOperationLedger(readProxyEventsFile(proxyEventsPath));
      const result = checkLiveReceipt(
        runtimeState,
        ledger,
        kind,
        agentId,
        Number(runOrdinalText),
        Number(expectedTerminalText),
      );
      if (!result) return 1;
      writeFileSync(outputPath, JSON.stringify(result));
      return 0;
    }
    case "wait-active-operation": {
      const [
        runtimeStatePath,
        proxyEventsPath,
        kind,
        agentId,
        runOrdinalText,
        outputPath,
      ] = args;
      const runtimeState = readJsonFile(runtimeStatePath);
      const ledger = buildOperationLedger(readProxyEventsFile(proxyEventsPath));
      const result = checkActiveOperation(
        runtimeState,
        ledger,
        kind,
        agentId,
        Number(runOrdinalText),
      );
      if (!result) return 1;
      writeFileSync(outputPath, JSON.stringify(result));
      return 0;
    }
    case "wait-unacknowledged-cancel": {
      const [proxyEventsPath, operationId, outputPath] = args;
      const ledger = buildOperationLedger(readProxyEventsFile(proxyEventsPath));
      const result = checkUnacknowledgedCancel(ledger, operationId);
      if (!result) return 1;
      writeFileSync(outputPath, JSON.stringify(result));
      return 0;
    }
    case "verify-soak-ledger": {
      const [runtimeStatePath, proxyEventsPath, agentId, expectedCountText] =
        args;
      const runtimeState = readJsonFile(runtimeStatePath);
      const ledger = buildOperationLedger(readProxyEventsFile(proxyEventsPath));
      verifySoakLedger(
        runtimeState,
        ledger,
        agentId,
        Number(expectedCountText),
      );
      return 0;
    }
    case "assert-no-ensure-since": {
      const [proxyEventsPath, agentId, minConnectionIdText] = args;
      const events = readProxyEventsFile(proxyEventsPath);
      assertNoEnsureSince(events, agentId, Number(minConnectionIdText));
      return 0;
    }
    case "dump": {
      const [proxyEventsPath] = args;
      const ledger = buildOperationLedger(readProxyEventsFile(proxyEventsPath));
      process.stdout.write(`${JSON.stringify([...ledger.values()])}\n`);
      return 0;
    }
    default:
      throw new Error(`Unknown proxy ledger command: ${command ?? "(none)"}`);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
