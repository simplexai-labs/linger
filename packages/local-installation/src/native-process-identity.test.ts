import type { ExecFileException } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface ExecCall {
  file: string;
  args: string[];
  options: Record<string, unknown>;
}

const mockExec = vi.hoisted(() => ({
  calls: [] as ExecCall[],
  handler: null as
    | ((
        file: string,
        args: string[],
        options: Record<string, unknown>,
      ) => { error: ExecFileException | null; stdout: string; stderr: string })
    | null,
}));

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  const execFile = (
    file: string,
    args: string[],
    options: Record<string, unknown>,
    callback: (
      error: ExecFileException | null,
      stdout: string,
      stderr: string,
    ) => void,
  ) => {
    mockExec.calls.push({ file, args, options });
    const result = mockExec.handler
      ? mockExec.handler(file, args, options)
      : { error: null, stdout: JSON.stringify({ p: [] }), stderr: "" };
    queueMicrotask(() => callback(result.error, result.stdout, result.stderr));
    return undefined as never;
  };
  return { ...actual, execFile };
});

import {
  WINDOWS_PROCESSES,
  parseWindowsProcesses,
  sanitizeInspectionStderr,
  windowsPowerShellExecutable,
  windowsProcesses,
} from "./native-process-identity.js";

beforeEach(() => {
  mockExec.calls = [];
  mockExec.handler = null;
});

describe("WINDOWS_PROCESSES query", () => {
  it("projects only required Win32_Process properties and null-guards CreationDate", () => {
    expect(WINDOWS_PROCESSES).toContain(
      "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,CommandLine",
    );
    expect(WINDOWS_PROCESSES).toContain("$_.CreationDate -is [datetime]");
    expect(WINDOWS_PROCESSES).toContain("$_.CreationDate.ToFileTimeUtc()");
    expect(WINDOWS_PROCESSES).toContain(
      "$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')",
    );
  });
});

describe("parseWindowsProcesses", () => {
  it("accepts rows with zero or null creation timestamps alongside normal processes", () => {
    const parsed = parseWindowsProcesses(
      JSON.stringify({
        p: [
          { p: 0, q: 0, c: 0, l: "" },
          { p: 4, q: 0, c: null, l: null },
          {
            p: 1234,
            q: 4,
            c: 133800000000000000,
            l: "node.exe native-process-worker.mjs",
          },
        ],
      }),
    );
    expect(parsed).toEqual([
      { pid: 0, parent: 0, created: 0, command: "" },
      { pid: 4, parent: 0, created: 0, command: "" },
      {
        pid: 1234,
        parent: 4,
        created: 133800000000000000,
        command: "node.exe native-process-worker.mjs",
      },
    ]);
  });

  it("handles a single object row and rejects missing process lists", () => {
    expect(
      parseWindowsProcesses(
        JSON.stringify({ p: { p: 10, q: 1, c: 500, l: "app.exe" } }),
      ),
    ).toEqual([{ pid: 10, parent: 1, created: 500, command: "app.exe" }]);
    expect(() => parseWindowsProcesses(JSON.stringify({}))).toThrow(
      "Native processes could not be enumerated.",
    );
  });
});

describe("windowsPowerShellExecutable", () => {
  it("resolves the full WindowsPowerShell executable path from SystemRoot or default", () => {
    expect(windowsPowerShellExecutable("D:\\Windows")).toBe(
      "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(windowsPowerShellExecutable("")).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });
});

describe("sanitizeInspectionStderr", () => {
  it("decodes PowerShell CLIXML error streams, redacts secrets, and caps length", () => {
    const clixml =
      '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
      '<S S="Error">Get-CimInstance : Access denied token=super-secret-value Bearer abc123_x000D__x000A_</S>' +
      "</Objs>";
    const sanitized = sanitizeInspectionStderr(clixml);
    expect(sanitized).toContain("Get-CimInstance : Access denied");
    expect(sanitized).toContain("token=[REDACTED]");
    expect(sanitized).toContain("Bearer [REDACTED]");
    expect(sanitized).not.toContain("super-secret-value");
    expect(sanitized).not.toContain("abc123");
    expect(sanitized).not.toContain("<Objs");

    const longLine = "x".repeat(500);
    expect(sanitizeInspectionStderr(longLine).length).toBe(240);
  });
});

describe("windowsProcesses", () => {
  it("invokes the full PowerShell path with a 16 MiB buffer and parses large outputs", async () => {
    const entries = Array.from({ length: 15_000 }, (_, index) => ({
      p: index + 1,
      q: 0,
      c: index === 0 ? 0 : 133800000000000000 + index,
      l: `C:\\Program Files\\Example\\service-${index}.exe --arg=${"a".repeat(120)}`,
    }));
    const payload = JSON.stringify({ p: entries });
    expect(payload.length).toBeGreaterThan(2_000_000);

    mockExec.handler = () => ({ error: null, stdout: payload, stderr: "" });
    const result = await windowsProcesses("C:\\Windows");

    expect(result).toHaveLength(15_000);
    expect(result[0]?.created).toBe(0);
    expect(mockExec.calls).toHaveLength(1);
    expect(mockExec.calls[0]?.file).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(mockExec.calls[0]?.args.slice(0, 4)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
    ]);
    expect(mockExec.calls[0]?.options.maxBuffer).toBe(16 * 1024 * 1024);
  });

  it("reports sanitized cause and stderr when process inspection fails", async () => {
    mockExec.handler = () => {
      const error = Object.assign(new Error("maxBuffer exceeded"), {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      }) as ExecFileException;
      return { error, stdout: "", stderr: "" };
    };
    await expect(windowsProcesses("C:\\Windows")).rejects.toThrow(
      "Native process identity could not be inspected (ERR_CHILD_PROCESS_STDIO_MAXBUFFER).",
    );

    mockExec.handler = () => {
      const error = Object.assign(new Error("timed out"), {
        killed: true,
        signal: "SIGTERM",
      }) as ExecFileException;
      return { error, stdout: "", stderr: "WMI repository busy" };
    };
    await expect(windowsProcesses("C:\\Windows")).rejects.toThrow(
      "Native process identity could not be inspected (timed out (SIGTERM): WMI repository busy).",
    );

    mockExec.handler = () => {
      const error = Object.assign(new Error("Command failed"), {
        code: 1,
      }) as ExecFileException;
      return {
        error,
        stdout: "",
        stderr:
          "Get-CimInstance : Invalid class Win32_Process api_key=secret123",
      };
    };
    await expect(windowsProcesses("C:\\Windows")).rejects.toThrow(
      "Native processes could not be enumerated (exit 1: Get-CimInstance : Invalid class Win32_Process api_key=[REDACTED]).",
    );
  });
});
