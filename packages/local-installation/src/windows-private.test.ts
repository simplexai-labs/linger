import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import {
  createWindowsPrivateClient,
  parseWindowsPrivateFailure,
  windowsPrivateLocation,
  windowsPrivatePath,
  windowsPrivateRefusal,
  WINDOWS_PRIVATE_PATH_UNSAFE,
  WINDOWS_PRIVATE_PREAMBLE,
  WINDOWS_PRIVATE_SCRIPT,
  WINDOWS_PRIVATE_WORKER_SCRIPT,
} from "./windows-private.js";

it("sends paths through stdin and launches a fixed PowerShell command without Add-Type", async () => {
  const run = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  await windowsPrivatePath(
    "C:\\Users\\person\\private's",
    "directory",
    true,
    run,
  );
  expect(run.mock.calls[0]![1]).toEqual([
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    WINDOWS_PRIVATE_SCRIPT,
  ]);
  expect(JSON.parse(run.mock.calls[0]![2].input)).toEqual({
    path: path.resolve("C:\\Users\\person\\private's"),
    kind: "directory",
    repair: true,
  });
  expect(WINDOWS_PRIVATE_PREAMBLE).not.toContain("Add-Type");
  expect(WINDOWS_PRIVATE_PREAMBLE).not.toContain("$identity.Groups");
  expect(WINDOWS_PRIVATE_PREAMBLE).toContain("DefinePInvokeMethod");
  expect(WINDOWS_PRIVATE_SCRIPT).toContain("SessionState.LanguageMode");
  expect(WINDOWS_PRIVATE_SCRIPT).toContain("[Console]::InputEncoding");
  expect(WINDOWS_PRIVATE_SCRIPT).toContain("[Console]::OutputEncoding");
  expect(WINDOWS_PRIVATE_SCRIPT).toContain("ReparsePoint");
  expect(WINDOWS_PRIVATE_SCRIPT).toContain("GetCurrent().User");
  expect(WINDOWS_PRIVATE_SCRIPT).toContain("AccessControlSections]::Access");
});

it("checks candidate locations non-destructively with kind location and repair false", async () => {
  const run = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  await windowsPrivateLocation(
    "C:\\Users\\person\\AppData\\Roaming\\Linger\\computer",
    run,
  );
  expect(JSON.parse(run.mock.calls[0]![2].input)).toEqual({
    path: path.resolve("C:\\Users\\person\\AppData\\Roaming\\Linger\\computer"),
    kind: "location",
    repair: false,
  });
});

it("fails closed without disclosing raw command diagnostics", async () => {
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

it("names the path, offending ancestor, offending SID, and sanitized UNCHECKED diagnostics", async () => {
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

  const ancestorFail = vi.fn().mockResolvedValue({
    code: 1,
    stdout: JSON.stringify({
      code: "UNSAFE_PARENT_ACCESS",
      ancestor: "C:\\Users\\person\\AppData\\Roaming",
      sid: "S-1-5-21-1-2-3-1007",
    }),
    stderr: "",
  });
  const parentError = await windowsPrivateLocation(
    "C:\\Users\\person\\AppData\\Roaming\\Linger\\computer",
    ancestorFail,
  ).catch(
    (failure: unknown) =>
      failure as Error & { ancestor?: string; sid?: string },
  );
  expect(parentError).toMatchObject({
    code: "WINDOWS_PRIVATE_PATH_UNSAFE",
    reason: "UNSAFE_PARENT_ACCESS",
    ancestor: "C:\\Users\\person\\AppData\\Roaming",
    sid: "S-1-5-21-1-2-3-1007",
  });
  expect(parentError?.message).toContain(
    "ancestor: C:\\Users\\person\\AppData\\Roaming",
  );
  expect(parentError?.message).toContain("sid: S-1-5-21-1-2-3-1007");
  expect(windowsPrivateRefusal(parentError)).toEqual({
    code: WINDOWS_PRIVATE_PATH_UNSAFE,
    reason: "UNSAFE_PARENT_ACCESS",
  });

  const uncheckedFail = vi.fn().mockResolvedValue({
    code: 1,
    stdout: JSON.stringify({
      code: "UNCHECKED",
      stage: "ancestor",
      errorType: "UnauthorizedAccessException",
      hresult: "0x80070005",
    }),
    stderr: "",
  });
  const uncheckedError = await windowsPrivatePath(
    file,
    "file",
    false,
    uncheckedFail,
  ).catch((failure: unknown) => failure as Error & { diagnostic?: string });
  expect(uncheckedError).toMatchObject({
    code: "WINDOWS_PRIVATE_PATH_UNSAFE",
    reason: "UNCHECKED",
    diagnostic:
      "stage=ancestor, type=UnauthorizedAccessException, hresult=0x80070005",
  });
  expect(uncheckedError?.message).toContain(
    "stage=ancestor, type=UnauthorizedAccessException, hresult=0x80070005",
  );

  // Only the script's fixed codes pass; anything else is unchecked without leaking text.
  const other = vi.fn().mockResolvedValue({
    code: 1,
    stdout: "Access denied to C:\\x",
    stderr: "",
  });
  const otherError = await windowsPrivatePath(file, "file", false, other).catch(
    (failure: unknown) => failure as Error,
  );
  expect(otherError).toMatchObject({ reason: "UNCHECKED" });
  expect(otherError?.message).not.toContain("Access denied to C:\\x");
});

it("validates structured failure payloads including language mode checks", () => {
  expect(
    parseWindowsPrivateFailure(
      JSON.stringify({
        code: "UNCHECKED",
        stage: "language_mode",
        errorType: "ConstrainedLanguage",
      }),
    ),
  ).toEqual({
    reason: "UNCHECKED",
    diagnostic: "stage=language_mode, type=ConstrainedLanguage",
  });
  expect(
    parseWindowsPrivateFailure(
      JSON.stringify({
        code: "UNSAFE_PARENT_OWNER",
        ancestor: "C:\\Users\\person",
        sid: "not-a-sid",
      }),
    ),
  ).toEqual({
    reason: "UNSAFE_PARENT_OWNER",
    ancestor: "C:\\Users\\person",
  });
  expect(
    parseWindowsPrivateFailure(
      JSON.stringify({
        code: "UNCHECKED",
        stage: "bad;stage",
        errorType: "bad type with spaces",
        hresult: "not-hex",
      }),
    ),
  ).toEqual({ reason: "UNCHECKED" });
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
    WINDOWS_PRIVATE_SCRIPT.indexOf("if ($request.kind -ne 'location')"),
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
  expect(WINDOWS_PRIVATE_WORKER_SCRIPT).toContain("SessionState.LanguageMode");
  expect(WINDOWS_PRIVATE_WORKER_SCRIPT).toContain("ReparsePoint");
  expect(WINDOWS_PRIVATE_WORKER_SCRIPT).toContain("SHARED_ACCESS");
  expect(WINDOWS_PRIVATE_WORKER_SCRIPT).toContain("Test-Administrator");
  expect(WINDOWS_PRIVATE_WORKER_SCRIPT).toContain("Ensure-LingerWin32Native");
  expect(WINDOWS_PRIVATE_WORKER_SCRIPT).not.toContain("Add-Type");
  expect(WINDOWS_PRIVATE_WORKER_SCRIPT).toContain("$script:isAdministrator");
  expect(WINDOWS_PRIVATE_WORKER_SCRIPT).toContain(
    "$replace = 'DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'",
  );
});

it("hands on the code and reason of a refusal, and nothing else", async () => {
  const run = vi.fn().mockResolvedValue({
    code: 1,
    stdout: "UNSAFE_PARENT_ACCESS",
    stderr: "",
  });
  const error: unknown = await windowsPrivatePath(
    "D:\\Apps\\Linger",
    "directory",
    true,
    run,
  ).catch((error: unknown) => error);
  const refusal = {
    code: WINDOWS_PRIVATE_PATH_UNSAFE,
    reason: "UNSAFE_PARENT_ACCESS",
  };
  expect(windowsPrivateRefusal(error)).toEqual(refusal);
  // The copy another process receives as JSON reads the same.
  expect(windowsPrivateRefusal(JSON.parse(JSON.stringify(refusal)))).toEqual(
    refusal,
  );
  for (const other of [
    undefined,
    "UNSAFE_PARENT_ACCESS",
    new Error("is inside a folder"),
    { code: "EACCES", reason: "UNSAFE_PARENT_ACCESS" },
    { code: WINDOWS_PRIVATE_PATH_UNSAFE, reason: "SOMETHING_ELSE" },
    { code: WINDOWS_PRIVATE_PATH_UNSAFE, reason: "toString" },
  ])
    expect(windowsPrivateRefusal(other)).toBeUndefined();
});

function fakeWorker(
  onLine: (
    line: string,
    stdout: PassThrough,
    emitClose: (code?: number | null) => void,
    emitError: (error: Error) => void,
  ) => void,
) {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let killed = false;
  let ended = false;
  let buffer = "";
  stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl < 0) break;
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      onLine(
        line,
        stdout,
        (code = 1) => emitter.emit("close", code, null),
        (error) => emitter.emit("error", error),
      );
    }
  });
  stdin.on("finish", () => {
    ended = true;
  });
  return {
    child: {
      stdin,
      stdout,
      kill: () => {
        killed = true;
      },
      on: emitter.on.bind(emitter),
    },
    wasKilled: () => killed,
    wasEnded: () => ended,
  };
}

it("reuses one persistent worker across concurrent requests, captures sanitized worker diagnostics, and respawns cleanly", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const workers: Array<ReturnType<typeof fakeWorker>> = [];
  let count = 0;
  const client = createWindowsPrivateClient({
    idleMs: 10_000,
    timeoutMs: 200,
    spawnWorker: () => {
      const id = ++count;
      const w = fakeWorker((line, stdout, emitClose, emitError) => {
        const req = JSON.parse(line) as { path: string };
        if (req.path === "ok-1" || req.path === "ok-2")
          stdout.write("__LINGER_ACL_OK__\n");
        else if (req.path === "bad-owner")
          stdout.write("__LINGER_ACL_ERR__:UNSAFE_OWNER\n");
        else if (req.path === "clm") {
          stdout.write(
            '__LINGER_ACL_ERR__:{"code":"UNCHECKED","stage":"language_mode","errorType":"ConstrainedLanguage"}\n',
          );
          emitClose(1);
        } else if (req.path === "crash") {
          emitClose(5);
        } else if (req.path === "spawn-fail") {
          emitError(
            Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
          );
        } else if (req.path === "desync") stdout.write("unexpected output\n");
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

    // Structured Constrained Language Mode refusal passes through and respawns.
    const clm = await client.execute(JSON.stringify({ path: "clm" }));
    expect(
      parseWindowsPrivateFailure(clm.stdout, clm.workerDiagnostic),
    ).toEqual({
      reason: "UNCHECKED",
      diagnostic: "stage=language_mode, type=ConstrainedLanguage",
    });

    // Unexpected close fails closed with exit code, then respawns.
    const crashed = await client.execute(JSON.stringify({ path: "crash" }));
    expect(crashed).toEqual({
      code: 1,
      stdout: "",
      workerDiagnostic: "worker=exit:5",
    });
    expect(await client.execute(JSON.stringify({ path: "ok-1" }))).toEqual({
      code: 0,
      stdout: "",
    });
    expect(workers).toHaveLength(3);

    // Spawn error reports sanitized errno code.
    const spawnFailed = await client.execute(
      JSON.stringify({ path: "spawn-fail" }),
    );
    expect(spawnFailed).toEqual({
      code: 1,
      stdout: "",
      workerDiagnostic: "worker=spawn:ENOENT",
    });

    // Unexpected stdout kills the worker and fails closed with desync diagnostic.
    expect(await client.execute(JSON.stringify({ path: "desync" }))).toEqual({
      code: 1,
      stdout: "",
      workerDiagnostic: "worker=desync",
    });
    expect(workers[3]!.wasKilled()).toBe(true);

    // Timeout kills a hung worker and fails closed with timeout diagnostic.
    const timedOut = client.execute(JSON.stringify({ path: "hang" }));
    await vi.advanceTimersByTimeAsync(200);
    expect(await timedOut).toEqual({
      code: 1,
      stdout: "",
      workerDiagnostic: "worker=timeout",
    });
    expect(workers[4]!.wasKilled()).toBe(true);
  } finally {
    client.close();
    vi.useRealTimers();
  }
});

it("closes an idle persistent worker after the idle period", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
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
  try {
    expect(await client.execute(JSON.stringify({ path: "ok" }))).toEqual({
      code: 0,
      stdout: "",
    });
    await vi.advanceTimersByTimeAsync(30);
    expect(workers[0]!.wasEnded()).toBe(true);
  } finally {
    client.close();
    vi.useRealTimers();
  }
});
