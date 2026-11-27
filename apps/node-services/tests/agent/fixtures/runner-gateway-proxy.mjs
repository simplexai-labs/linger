import { appendFileSync, writeFileSync } from "node:fs";

import WebSocket, { WebSocketServer } from "ws";

const listenPort = Number(requiredArgument("--listen-port"));
const targetPort = Number(requiredArgument("--target-port"));
const readyFile = requiredArgument("--ready-file");
const eventsFile = requiredArgument("--events-file");
const maxBytes = 16 * 1024 * 1024;
const sockets = new Set();
let nextConnectionId = 0;
let blockAcknowledgements = false;

const handshakes = new WeakMap();
const server = new WebSocketServer({
  host: "127.0.0.1",
  port: listenPort,
  maxPayload: maxBytes,
  // Complete the upstream upgrade first so a refused upgrade reaches the Daemon.
  verifyClient(info, done) {
    const request = info.req;
    const headers = {};
    for (const name of ["authorization", "origin"]) {
      if (typeof request.headers[name] === "string")
        headers[name] = request.headers[name];
    }
    const upstream = new WebSocket(
      `ws://127.0.0.1:${targetPort}${request.url}`,
      {
        headers,
        maxPayload: maxBytes,
        handshakeTimeout: 10_000,
      },
    );
    const handshake = { upstream };
    handshakes.set(request, handshake);
    sockets.add(upstream);
    let settled = false;
    const reject = () => {
      if (settled) return;
      settled = true;
      sockets.delete(upstream);
      upstream.terminate();
      done(false, 502);
    };
    upstream.once("error", reject);
    upstream.once("unexpected-response", (_request, response) => {
      response.resume();
      reject();
    });
    upstream.once("open", () => {
      settled = true;
      upstream.pause();
      done(true);
    });
  },
});
server.on("connection", (downstream, request) => {
  const { upstream } = handshakes.get(request);
  handshakes.delete(request);
  sockets.add(downstream);
  const connectionId = ++nextConnectionId;
  record({ type: "connection", connection_id: connectionId, at: Date.now() });
  const closePair = () => {
    sockets.delete(downstream);
    sockets.delete(upstream);
    downstream.terminate();
    upstream.terminate();
  };
  const forward = (target, data, binary) => {
    if (
      target.readyState !== WebSocket.OPEN ||
      target.bufferedAmount + data.length > maxBytes
    ) {
      closePair();
      return false;
    }
    target.send(data, { binary }, (error) => {
      if (error) closePair();
    });
    return true;
  };
  for (const socket of [downstream, upstream]) {
    socket.once("error", closePair);
    socket.once("close", closePair);
  }
  downstream.on("message", (data, binary) => {
    if (!forward(upstream, data, binary)) return;
    const envelope = parseEnvelope(data, binary);
    if (
      typeof envelope?.type === "string" &&
      (envelope.type.startsWith("operation.") ||
        envelope.type === "agent_runner.state")
    ) {
      record(
        summarizeEnvelope("daemon_to_agent", connectionId, envelope, {
          ...(typeof envelope.seq === "number" ? { seq: envelope.seq } : {}),
          ...(typeof envelope.event?.type === "string"
            ? { event_type: envelope.event.type }
            : {}),
          ...(typeof envelope.state === "string"
            ? { state: envelope.state }
            : {}),
        }),
      );
    }
  });
  upstream.on("message", (data, binary) => {
    const envelope = parseEnvelope(data, binary);
    if (envelope?.type === "operation.ack") {
      if (blockAcknowledgements) {
        record({
          type: "blocked_agent_to_daemon",
          connection_id: connectionId,
          message_type: "operation.ack",
          at: Date.now(),
          bytes: data.length,
          operation_id: envelope.operation_id,
          through_seq: envelope.through_seq,
        });
        return;
      }
      if (!forward(downstream, data, binary)) return;
      record(
        summarizeEnvelope("agent_to_daemon", connectionId, envelope, {
          ...(typeof envelope.through_seq === "number"
            ? { through_seq: envelope.through_seq }
            : {}),
        }),
      );
      return;
    }
    if (!forward(downstream, data, binary)) return;
    if (
      envelope?.type === "operation.start" ||
      envelope?.type === "agent_runner.ensure" ||
      envelope?.type === "agent_runner.remove"
    ) {
      record(
        summarizeEnvelope("agent_to_daemon", connectionId, envelope, {
          ...(typeof envelope.request?.kind === "string"
            ? { request_kind: envelope.request.kind }
            : {}),
          ...(typeof envelope.request?.run_context?.execution_run_ref ===
          "string"
            ? { run_id: envelope.request.run_context.execution_run_ref }
            : {}),
        }),
      );
    }
  });
  upstream.resume();
});

server.on("listening", () => {
  writeFileSync(
    readyFile,
    JSON.stringify({ pid: process.pid, port: server.address().port }),
  );
});
process.on("SIGUSR1", () => {
  record({ type: "drop", at: Date.now(), socket_count: sockets.size });
  blockAcknowledgements = false;
  for (const socket of [...sockets]) socket.terminate();
});
process.on("SIGUSR2", () => {
  blockAcknowledgements = true;
  record({
    type: "block_agent_to_daemon",
    mode: "operation_ack_only",
    at: Date.now(),
  });
});
let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  for (const socket of [...sockets]) socket.terminate();
  server.close(() => process.exit(0));
};
process.once("SIGINT", close);
process.once("SIGTERM", close);

function summarizeEnvelope(type, connectionId, envelope, extra = {}) {
  return {
    type,
    connection_id: connectionId,
    message_type: envelope.type,
    at: Date.now(),
    ...(typeof envelope.operation_id === "string"
      ? { operation_id: envelope.operation_id }
      : {}),
    ...(typeof envelope.agent_id === "string"
      ? { agent_id: envelope.agent_id }
      : {}),
    ...(typeof envelope.connection_epoch === "number"
      ? { connection_epoch: envelope.connection_epoch }
      : {}),
    ...extra,
  };
}
function parseEnvelope(data, binary) {
  if (binary) return null;
  try {
    const parsed = JSON.parse(data.toString());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}
function requiredArgument(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function record(value) {
  appendFileSync(eventsFile, `${JSON.stringify(value)}\n`);
}
