import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import {
  createWindowsPrivateClient,
  windowsPrivatePath,
  WINDOWS_PRIVATE_SCRIPT,
  WINDOWS_PRIVATE_WORKER_SCRIPT,
} from "./windows-private.js";
it("sends paths through stdin and runs a fixed encoded ACL program", async () => {
  const run = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  await windowsPrivatePath(
    "C:\\Users\\person\\private's",
    "directory",
    true,
    run,
  );
  expect(run.mock.calls[0]![1].join(" ")).not.toContain("person");
  expect(run.mock.calls[0]![2].input).toContain("person");
  expect(WINDOWS_PRIVATE_SCRIPT).toContain("[Console]::InputEncoding");
  expect(WINDOWS_PRIVATE_SCRIPT).toContain("ReparsePoint");
  expect(WINDOWS_PRIVATE_SCRIPT).toContain("GetCurrent().User");
  expect(WINDOWS_PRIVATE_SCRIPT).toContain("AccessControlSections]::Access");
});
it("fails closed without disclosing command diagnostics", async () => {
  const run = vi
    .fn()
    .mockResolvedValue({ code: 1, stdout: "", stderr: "sensitive path" });
  const error = await windowsPrivatePath("private", "file", false, run).catch(
    (failure: unknown) => failure as Error,
  );
  expect(error?.message).toMatch(/^Windows private path validation failed/);
  expect(error?.message).not.toContain("sensitive");
  expect(error).toMatchObject({
    code: "WINDOWS_PRIVATE_PATH_UNSAFE",
    reason: "UNCHECKED",
  });
});
it("names the path and why it is not private", async () => {
  const file =
    "C:\\Users\\person\\.simplexai\\instances\\desktop\\native.env.1.tmp";
  const owned = vi
    .fn()
    .mockResolvedValue({ code: 1, stdout: "UNSAFE_OWNER", stderr: "" });
  const error = await windowsPrivatePath(file, "file", false, owned).catch(
    (failure: unknown) => failure as Error,
  );
  expect(error).toMatchObject({
    code: "WINDOWS_PRIVATE_PATH_UNSAFE",
    reason: "UNSAFE_OWNER",
    path: path.resolve(file),
  });
  expect(error?.message).toContain(path.resolve(file));
  expect(error?.message).toContain("owned by another account");
  // Only the script's fixed codes pass; anything else is unchecked.
  const other = vi.fn().mockResolvedValue({
    code: 1,
    stdout: "Access denied to C:\\x",
    stderr: "",
  });
  await expect(
    windowsPrivatePath(file, "file", false, other),
  ).rejects.toMatchObject({ reason: "UNCHECKED" });
});
it("gives every failure in the ACL program a fixed reason code", () => {
  const thrown = [...WINDOWS_PRIVATE_SCRIPT.matchAll(/throw '([^']*)'/g)].map(
    (match) => match[1],
  );
  expect(thrown.length).toBeGreaterThan(5);
  for (const code of thrown) expect(code).toMatch(/^[A-Z][A-Z_]+$/);
});
it("ignores inherit-only ACEs only for effective ancestor permissions", () => {
  const ancestors = WINDOWS_PRIVATE_SCRIPT.slice(
    WINDOWS_PRIVATE_SCRIPT.indexOf("while ($parent)"),
    WINDOWS_PRIVATE_SCRIPT.indexOf("if ($request.repair)"),
  );
  const target = WINDOWS_PRIVATE_SCRIPT.slice(
    WINDOWS_PRIVATE_SCRIPT.indexOf("$currentAllowed = $false"),
  );
  expect(ancestors).toContain(
    "$rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly",
  );
  expect(target).not.toContain("PropagationFlags");
  expect(target).toContain("SHARED_ACCESS");
  expect(WINDOWS_PRIVATE_SCRIPT).toContain(
    "$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')",
  );
  expect(WINDOWS_PRIVATE_WORKER_SCRIPT).toContain(
    "$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')",
  );
  expect(WINDOWS_PRIVATE_WORKER_SCRIPT).toContain("ReparsePoint");
  expect(WINDOWS_PRIVATE_WORKER_SCRIPT).toContain("SHARED_ACCESS");
});

function fakeWorker(
  onLine: (line: string, stdout: PassThrough, emitClose: () => void) => void,
) {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let killed = false;
  let ended = false;
  let buffer = "";
  const emitClose = () => emitter.emit("close");
  stdin.setEncoding("utf8").on("data", (chunk: string) => {
    buffer += chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) onLine(part, stdout, emitClose);
  });
  stdin.on("finish", () => {
    ended = true;
    emitClose();
  });
  return {
    child: {
      stdin,
      stdout,
      kill: () => {
        killed = true;
        emitClose();
      },
      on: (event: "close" | "error", listener: () => void) =>
        emitter.on(event, listener),
    },
    wasKilled: () => killed,
    wasEnded: () => ended,
  };
}

it("reuses one persistent worker across concurrent requests and respawns cleanly after failures", async () => {
  const workers: Array<ReturnType<typeof fakeWorker>> = [];
  let count = 0;
  const client = createWindowsPrivateClient({
    idleMs: 10_000,
    timeoutMs: 200,
    spawnWorker: () => {
      const id = ++count;
      const w = fakeWorker((line, stdout, emitClose) => {
        const req = JSON.parse(line) as { path: string };
        if (req.path === "ok-1" || req.path === "ok-2")
          stdout.write("__LINGER_ACL_OK__\n");
        else if (req.path === "bad-owner")
          stdout.write("__LINGER_ACL_ERR__:UNSAFE_OWNER\n");
        else if (req.path === "crash") emitClose();
        else if (req.path === "desync") stdout.write("unexpected output\n");
        else if (req.path === "hang" && id > 0) {
          // Intentionally never replies so the request timeout fires.
        }
      });
      workers.push(w);
      return w.child;
    },
  });
  try {
    const [r1, r2, r3] = await Promise.all([
      client.execute(JSON.stringify({ path: "ok-1" })),
      client.execute(JSON.stringify({ path: "ok-2" })),
      client.execute(JSON.stringify({ path: "bad-owner" })),
    ]);
    expect(r1).toEqual({ code: 0, stdout: "" });
    expect(r2).toEqual({ code: 0, stdout: "" });
    expect(r3).toEqual({ code: 1, stdout: "UNSAFE_OWNER" });
    expect(workers).toHaveLength(1);

    // Unexpected close fails closed and respawns on the next request.
    expect(await client.execute(JSON.stringify({ path: "crash" }))).toEqual({
      code: 1,
      stdout: "",
    });
    expect(await client.execute(JSON.stringify({ path: "ok-1" }))).toEqual({
      code: 0,
      stdout: "",
    });
    expect(workers).toHaveLength(2);

    // Unexpected stdout kills the worker and fails closed.
    expect(await client.execute(JSON.stringify({ path: "desync" }))).toEqual({
      code: 1,
      stdout: "",
    });
    expect(workers[1]!.wasKilled()).toBe(true);

    // Timeout kills a hung worker and fails closed.
    expect(await client.execute(JSON.stringify({ path: "hang" }))).toEqual({
      code: 1,
      stdout: "",
    });
    expect(workers[2]!.wasKilled()).toBe(true);
  } finally {
    client.close();
  }
});

it("closes an idle persistent worker after the idle period", async () => {
  const workers: Array<ReturnType<typeof fakeWorker>> = [];
  const client = createWindowsPrivateClient({
    idleMs: 30,
    spawnWorker: () => {
      const w = fakeWorker((_line, stdout) => {
        stdout.write("__LINGER_ACL_OK__\n");
      });
      workers.push(w);
      return w.child;
    },
  });
  expect(await client.execute(JSON.stringify({ path: "ok" }))).toEqual({
    code: 0,
    stdout: "",
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(workers[0]!.wasEnded()).toBe(true);
});

it("respawns the persistent worker when PSModulePath changes", async () => {
  const workers: Array<ReturnType<typeof fakeWorker>> = [];
  const client = createWindowsPrivateClient({
    idleMs: 10_000,
    spawnWorker: () => {
      const w = fakeWorker((_line, stdout) => {
        stdout.write("__LINGER_ACL_OK__\n");
      });
      workers.push(w);
      return w.child;
    },
  });
  try {
    vi.stubEnv("PSModulePath", "C:\\first");
    expect(await client.execute(JSON.stringify({ path: "ok" }))).toEqual({
      code: 0,
      stdout: "",
    });
    expect(workers).toHaveLength(1);

    vi.stubEnv("PSModulePath", "C:\\second");
    expect(await client.execute(JSON.stringify({ path: "ok" }))).toEqual({
      code: 0,
      stdout: "",
    });
    expect(workers).toHaveLength(2);
    await vi.waitFor(() => expect(workers[0]!.wasEnded()).toBe(true));
  } finally {
    vi.unstubAllEnvs();
    client.close();
  }
});
