import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  fileTimeStringToWindowsCreated,
  windowsLeaseTree,
} from "./native-process-identity.js";
import {
  createWindowsPlatformWorkerClient,
  type PlatformWorkerProcess,
} from "./windows-platform-worker.js";

function createFakeWorker(
  onRequest: (
    line: string,
    stdout: PassThrough,
    emitClose: (code?: number | null) => void,
  ) => void,
) {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let killed = false;
  let buffer = "";
  const emitClose = (code: number | null = 0) => {
    stdout.end();
    emitter.emit("close", code, null);
  };
  stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let idx = buffer.indexOf("\n");
    while (idx >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      onRequest(line, stdout, emitClose);
      idx = buffer.indexOf("\n");
    }
  });
  stdin.on("end", () => emitClose(0));
  const worker: PlatformWorkerProcess = {
    stdin,
    stdout,
    kill() {
      killed = true;
      emitClose(1);
    },
    on: emitter.on.bind(emitter) as PlatformWorkerProcess["on"],
  };
  return { worker, isKilled: () => killed, emitClose };
}

describe("createWindowsPlatformWorkerClient", () => {
  it("returns unavailable without spawning when no daemon binary is resolved", async () => {
    const spawnWorker = vi.fn();
    const client = createWindowsPlatformWorkerClient({
      resolveExecutable: () => null,
      spawnWorker,
    });
    const result = await client.call(
      { action: "process-snapshot", includeListeners: false },
      (value) => value,
    );
    expect(result).toEqual({ kind: "unavailable", reason: "daemon_not_found" });
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it("reuses one persistent worker across sequential and concurrent calls", async () => {
    let spawns = 0;
    const seen: string[] = [];
    const client = createWindowsPlatformWorkerClient({
      resolveExecutable: () => "C:\\Linger\\linger-computer-daemon.exe",
      spawnWorker: () => {
        spawns += 1;
        return createFakeWorker((line, stdout) => {
          seen.push(line);
          const req = JSON.parse(line) as { action: string; id?: number };
          stdout.write(
            `${JSON.stringify({ ok: true, result: { action: req.action, id: req.id } })}\n`,
          );
        }).worker;
      },
      idleMs: 10_000,
    });

    try {
      const [a, b] = await Promise.all([
        client.call({ action: "process-snapshot", id: 1 }, (v) => v),
        client.call({ action: "validate-private-path", id: 2 }, (v) => v),
      ]);
      expect(a).toEqual({
        kind: "ok",
        result: { action: "process-snapshot", id: 1 },
      });
      expect(b).toEqual({
        kind: "ok",
        result: { action: "validate-private-path", id: 2 },
      });
      expect(spawns).toBe(1);
      expect(seen).toHaveLength(2);
    } finally {
      client.close();
    }
  });

  it("caches unsupported older binaries that exit before producing a valid envelope", async () => {
    let spawns = 0;
    const client = createWindowsPlatformWorkerClient({
      resolveExecutable: () => "C:\\Old\\linger-computer-daemon.exe",
      spawnWorker: () => {
        spawns += 1;
        return createFakeWorker((_line, _stdout, emitClose) => {
          emitClose(2);
        }).worker;
      },
    });

    const first = await client.call(
      { action: "process-snapshot" },
      (value) => value,
    );
    const second = await client.call(
      { action: "process-snapshot" },
      (value) => value,
    );
    expect(first).toEqual({ kind: "unavailable", reason: "worker_exit_2" });
    expect(second).toEqual({
      kind: "unavailable",
      reason: "daemon_unsupported",
    });
    expect(spawns).toBe(1);
  });

  it("caches unsupported actions per binary while allowing supported actions", async () => {
    let requests = 0;
    const client = createWindowsPlatformWorkerClient({
      resolveExecutable: () => "C:\\Linger\\linger-computer-daemon.exe",
      spawnWorker: () =>
        createFakeWorker((line, stdout) => {
          requests += 1;
          const req = JSON.parse(line) as { action: string };
          if (req.action === "future-action") {
            stdout.write(
              `${JSON.stringify({ ok: false, error: "unknown platform action" })}\n`,
            );
            return;
          }
          stdout.write(
            `${JSON.stringify({ ok: true, result: { ok: true } })}\n`,
          );
        }).worker,
      idleMs: 10_000,
    });

    try {
      const first = await client.call({ action: "future-action" }, (v) => v);
      const second = await client.call({ action: "future-action" }, (v) => v);
      const supported = await client.call(
        { action: "validate-private-path" },
        (v) => v,
      );
      expect(first).toEqual({
        kind: "unavailable",
        reason: "unknown platform action",
      });
      expect(second).toEqual({
        kind: "unavailable",
        reason: "daemon_unsupported",
      });
      expect(supported).toEqual({ kind: "ok", result: { ok: true } });
      expect(requests).toBe(2);
    } finally {
      client.close();
    }
  });

  it("handles request timeouts without permanently blacklisting the binary", async () => {
    let spawns = 0;
    const client = createWindowsPlatformWorkerClient({
      resolveExecutable: () => "C:\\Linger\\linger-computer-daemon.exe",
      spawnWorker: () => {
        spawns += 1;
        const current = spawns;
        return createFakeWorker((_line, stdout) => {
          if (current === 1) return; // Hang first spawn to trigger timeout.
          stdout.write(
            `${JSON.stringify({ ok: true, result: { ok: true } })}\n`,
          );
        }).worker;
      },
      timeoutMs: 40,
      idleMs: 10_000,
    });

    try {
      const timedOut = await client.call(
        { action: "validate-private-path" },
        (v) => v,
      );
      expect(timedOut).toEqual({
        kind: "unavailable",
        reason: "worker_timeout",
      });

      const recovered = await client.call(
        { action: "validate-private-path" },
        (v) => v,
      );
      expect(recovered).toEqual({ kind: "ok", result: { ok: true } });
      expect(spawns).toBe(2);
    } finally {
      client.close();
    }
  });

  it("catches synchronous spawnWorker errors cleanly without leaking inFlight state", async () => {
    let attempts = 0;
    const client = createWindowsPlatformWorkerClient({
      resolveExecutable: () => "C:\\Linger\\linger-computer-daemon.exe",
      spawnWorker: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("spawn EACCES");
        return createFakeWorker((_line, stdout) => {
          stdout.write(
            `${JSON.stringify({ ok: true, result: { ok: true } })}\n`,
          );
        }).worker;
      },
      idleMs: 30,
    });

    try {
      const first = await client.call({ action: "process-snapshot" }, (v) => v);
      expect(first).toEqual({
        kind: "unavailable",
        reason: "worker_spawn_error",
      });
      const second = await client.call(
        { action: "process-snapshot" },
        (v) => v,
      );
      expect(second).toEqual({ kind: "ok", result: { ok: true } });
      expect(attempts).toBe(2);
    } finally {
      client.close();
    }
  });

  it("recovers from malformed JSON or unexpected desync lines after a healthy reply", async () => {
    let spawns = 0;
    const client = createWindowsPlatformWorkerClient({
      resolveExecutable: () => "C:\\Linger\\linger-computer-daemon.exe",
      spawnWorker: () => {
        spawns += 1;
        let count = 0;
        return createFakeWorker((_line, stdout) => {
          count += 1;
          if (spawns === 1 && count === 1) {
            stdout.write(
              `${JSON.stringify({ ok: true, result: { ok: true } })}\n`,
            );
            return;
          }
          if (spawns === 1 && count === 2) {
            stdout.write("not-json-line\n");
            return;
          }
          stdout.write(
            `${JSON.stringify({ ok: true, result: { ok: true } })}\n`,
          );
        }).worker;
      },
      idleMs: 10_000,
    });

    try {
      expect(
        await client.call({ action: "validate-private-path" }, (v) => v),
      ).toEqual({ kind: "ok", result: { ok: true } });
      expect(
        await client.call({ action: "validate-private-path" }, (v) => v),
      ).toEqual({ kind: "unavailable", reason: "worker_invalid_json" });
      expect(
        await client.call({ action: "validate-private-path" }, (v) => v),
      ).toEqual({ kind: "ok", result: { ok: true } });
      expect(spawns).toBe(2);
    } finally {
      client.close();
    }
  });

  it("marks older binaries unsupported even when stdin EPIPE fires before non-zero close", async () => {
    let spawns = 0;
    const client = createWindowsPlatformWorkerClient({
      resolveExecutable: () => "C:\\Older\\linger-computer-daemon.exe",
      spawnWorker: () => {
        spawns += 1;
        const fake = createFakeWorker(() => {});
        // Simulate EPIPE arriving on stdin before child 'close' with exit code 2.
        fake.worker.stdin.on("data", () => {
          fake.worker.stdin.emit(
            "error",
            Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
          );
          fake.emitClose(2);
        });
        return fake.worker;
      },
    });

    const first = await client.call({ action: "process-snapshot" }, (v) => v);
    expect(first).toEqual({
      kind: "unavailable",
      reason: "worker_stdin_error",
    });
    const second = await client.call({ action: "process-snapshot" }, (v) => v);
    expect(second).toEqual({
      kind: "unavailable",
      reason: "daemon_unsupported",
    });
    expect(spawns).toBe(1);
  });

  it("shuts down idle workers after idleMs and respawns cleanly on next call", async () => {
    let spawns = 0;
    const client = createWindowsPlatformWorkerClient({
      resolveExecutable: () => "C:\\Linger\\linger-computer-daemon.exe",
      spawnWorker: () => {
        spawns += 1;
        return createFakeWorker((_line, stdout) => {
          stdout.write(
            `${JSON.stringify({ ok: true, result: { n: spawns } })}\n`,
          );
        }).worker;
      },
      idleMs: 30,
    });

    try {
      expect(
        await client.call({ action: "process-snapshot" }, (v) => v),
      ).toEqual({ kind: "ok", result: { n: 1 } });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(
        await client.call({ action: "process-snapshot" }, (v) => v),
      ).toEqual({ kind: "ok", result: { n: 2 } });
      expect(spawns).toBe(2);
    } finally {
      client.close();
    }
  });
});

describe("Windows Go snapshot compatibility helpers", () => {
  it("truncates Win32 FILETIME strings to microsecond numbers matching CIM CreationDate", () => {
    expect(fileTimeStringToWindowsCreated("134402242877866569")).toBe(
      Number(134402242877866560n),
    );
    expect(fileTimeStringToWindowsCreated("134402576393497235")).toBe(
      Number(134402576393497230n),
    );
    expect(fileTimeStringToWindowsCreated("")).toBe(0);
    expect(fileTimeStringToWindowsCreated("0")).toBe(0);
    expect(fileTimeStringToWindowsCreated("invalid")).toBe(0);
  });

  it("excludes linger-computer-daemon platform workers from lease trees", () => {
    const lease = "lease-abc";
    const tree = windowsLeaseTree(
      [
        {
          pid: 100,
          parent: 1,
          created: 1000,
          command: `node.exe worker.mjs .${lease}.job`,
        },
        {
          pid: 101,
          parent: 100,
          created: 1010,
          command: '"C:\\Linger\\linger-computer-daemon.exe" platform --worker',
        },
        {
          pid: 102,
          parent: 100,
          created: 1020,
          command: 'powershell.exe -Command "Get-CimInstance Win32_Process"',
        },
      ],
      lease,
    );
    expect(tree.map((entry) => entry.pid)).toEqual([100]);
  });
});
