import { describe, expect, it } from "vitest";
import {
  formatWindowsSpawnError,
  windowsCommandLine,
  windowsLaunch,
} from "./replace-process.mjs";

describe("windowsCommandLine", () => {
  it("quotes paths with spaces and leaves plain arguments alone", () => {
    expect(
      windowsCommandLine("C:\\Program Files\\nodejs\\node.exe", [
        "C:\\Users\\Ada Lovelace\\linger\\scripts\\source-native.mjs",
        "--include",
        "apps/node-services/src/**/*",
        "-p=2",
      ]),
    ).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Ada Lovelace\\linger\\scripts\\source-native.mjs" --include "apps/node-services/src/**/*" -p=2',
    );
  });
  it("refuses characters cmd.exe would reinterpret", () => {
    for (const value of ['a"b', "%PATH%", "a\nb"])
      expect(() => windowsCommandLine("pnpm", [value])).toThrow(/Unsupported/);
  });
});

describe("windowsLaunch", () => {
  it("runs a program file as a direct child, so it ends with its supervisor", () => {
    expect(
      windowsLaunch("C:\\Users\\Ada Lovelace\\linger\\teamhub.exe", ["-x"]),
    ).toEqual({
      file: "C:\\Users\\Ada Lovelace\\linger\\teamhub.exe",
      args: ["-x"],
      shell: false,
    });
  });
  it("resolves launchers such as pnpm through cmd.exe", () => {
    expect(windowsLaunch("pnpm", ["dev"])).toEqual({
      file: "pnpm dev",
      args: [],
      shell: true,
    });
  });
});

describe("formatWindowsSpawnError", () => {
  it("logs executable basename, code, errno, and AV/SmartScreen hint on spawn UNKNOWN", () => {
    const error = Object.assign(new Error("spawn UNKNOWN"), {
      code: "UNKNOWN",
      errno: -4094,
    });
    const formatted = formatWindowsSpawnError(
      "C:\\Users\\Alice\\.simplexai\\bin\\migrate.exe",
      error,
    );
    expect(formatted).toContain("migrate.exe");
    expect(formatted).not.toContain("Alice");
    expect(formatted).toContain("code=UNKNOWN");
    expect(formatted).toContain("errno=-4094");
    expect(formatted).toMatch(/Windows Defender|antivirus|SmartScreen/i);
  });

  it("includes AV/SmartScreen hint on EACCES and omits it on ENOENT", () => {
    const denied = Object.assign(new Error("spawn EACCES"), {
      code: "EACCES",
      errno: -4092,
    });
    expect(formatWindowsSpawnError("C:\\linger\\teamhub.exe", denied)).toMatch(
      /teamhub\.exe.*code=EACCES.*errno=-4092.*SmartScreen/i,
    );

    const missing = Object.assign(new Error("spawn ENOENT"), {
      code: "ENOENT",
      errno: -4058,
    });
    const formattedMissing = formatWindowsSpawnError(
      "C:\\linger\\teamhub.exe",
      missing,
    );
    expect(formattedMissing).toContain("teamhub.exe");
    expect(formattedMissing).toContain("code=ENOENT");
    expect(formattedMissing).not.toMatch(/SmartScreen/);
  });
});
