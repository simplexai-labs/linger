import { describe, expect, it } from "vitest";

import {
  WINDOWS_DRIVER_INSTALLER_SCRIPT,
  parseAuthenticodeOutput,
  parseWindowsInstallerRunOutput,
} from "./windows-driver-platform.js";

describe("parseAuthenticodeOutput", () => {
  it("accepts a Valid Authenticode signature whose CN is exactly NVIDIA Corporation", () => {
    expect(
      parseAuthenticodeOutput(
        JSON.stringify({
          Status: "Valid",
          Subject:
            "CN=NVIDIA Corporation, O=NVIDIA Corporation, L=Santa Clara, S=California, C=US",
          SimpleName: "NVIDIA Corporation",
        }),
      ),
    ).toEqual({
      valid: true,
      subject:
        "CN=NVIDIA Corporation, O=NVIDIA Corporation, L=Santa Clara, S=California, C=US",
    });

    expect(
      parseAuthenticodeOutput(
        JSON.stringify({
          Status: "Valid",
          Subject: 'CN="NVIDIA Corporation", O="NVIDIA Corporation", C=US',
        }),
      ),
    ).toEqual({
      valid: true,
      subject: 'CN="NVIDIA Corporation", O="NVIDIA Corporation", C=US',
    });
  });

  it("rejects non-Valid statuses, missing signers, and spoofed Subject attributes", () => {
    for (const payload of [
      {
        Status: "NotSigned",
        Subject: "CN=NVIDIA Corporation, O=NVIDIA Corporation, C=US",
        SimpleName: "NVIDIA Corporation",
      },
      {
        Status: "HashMismatch",
        Subject: "CN=NVIDIA Corporation, O=NVIDIA Corporation, C=US",
        SimpleName: "NVIDIA Corporation",
      },
      {
        Status: "Valid",
        Subject: "CN=Evil Corp, OU=NVIDIA Corporation, C=US",
        SimpleName: "Evil Corp",
      },
      {
        Status: "Valid",
        Subject: "CN=Evil Corp, OU=NVIDIA Corporation, C=US",
      },
      {
        Status: "Valid",
        Subject: "CN=Fake NVIDIA Corporation LLC, O=Fake, C=US",
        SimpleName: "Fake NVIDIA Corporation LLC",
      },
      {
        Status: "Valid",
        Subject: "CN=NVIDIA Corporation, O=NVIDIA Corporation, C=US",
        SimpleName: "Different Signer",
      },
      { Status: "Valid", Subject: "" },
    ]) {
      expect(parseAuthenticodeOutput(JSON.stringify(payload)).valid).toBe(
        false,
      );
    }

    expect(parseAuthenticodeOutput("not json")).toEqual({ valid: false });
    expect(parseAuthenticodeOutput("")).toEqual({ valid: false });
  });
});

describe("parseWindowsInstallerRunOutput", () => {
  it("classifies installer exit codes and locale-independent Win32 UAC cancellation", () => {
    expect(parseWindowsInstallerRunOutput('{"exitCode":0}\r\n')).toEqual({
      outcome: "completed",
    });
    expect(parseWindowsInstallerRunOutput('{"exitCode":1}')).toEqual({
      outcome: "reboot_required",
    });
    expect(parseWindowsInstallerRunOutput('{"exitCode":3010}')).toEqual({
      outcome: "reboot_required",
    });
    expect(parseWindowsInstallerRunOutput('{"exitCode":1603}')).toEqual({
      outcome: "failed",
      exitCode: 1603,
    });
    expect(parseWindowsInstallerRunOutput('{"win32Error":1223}')).toEqual({
      outcome: "uac_cancelled",
    });
  });

  it("fails cleanly on other Win32 errors, missing fields, or malformed stdout", () => {
    expect(parseWindowsInstallerRunOutput('{"win32Error":5}')).toEqual({
      outcome: "failed",
    });
    expect(parseWindowsInstallerRunOutput('{"win32Error":null}')).toEqual({
      outcome: "failed",
    });
    expect(parseWindowsInstallerRunOutput('{"exitCode":1.5}')).toEqual({
      outcome: "failed",
    });
    expect(parseWindowsInstallerRunOutput("{}")).toEqual({
      outcome: "failed",
    });
    expect(parseWindowsInstallerRunOutput("not json")).toEqual({
      outcome: "failed",
    });
    expect(parseWindowsInstallerRunOutput("")).toEqual({
      outcome: "failed",
    });
  });
});

describe("WINDOWS_DRIVER_INSTALLER_SCRIPT", () => {
  it("uses .NET ProcessStartInfo / Process::Start instead of Start-Process so UAC Win32Exception surfaces NativeErrorCode", () => {
    expect(WINDOWS_DRIVER_INSTALLER_SCRIPT).not.toContain("Start-Process");
    expect(WINDOWS_DRIVER_INSTALLER_SCRIPT).toContain(
      "[System.Diagnostics.ProcessStartInfo]::new($env:LINGER_DRIVER_EXE, '-s -noreboot -noeula')",
    );
    expect(WINDOWS_DRIVER_INSTALLER_SCRIPT).toContain(
      "$psi.UseShellExecute = $true",
    );
    expect(WINDOWS_DRIVER_INSTALLER_SCRIPT).toContain("$psi.Verb = 'runas'");
    expect(WINDOWS_DRIVER_INSTALLER_SCRIPT).toContain(
      "[System.Diagnostics.Process]::Start($psi)",
    );
    expect(WINDOWS_DRIVER_INSTALLER_SCRIPT).toContain("$p.WaitForExit()");
    expect(WINDOWS_DRIVER_INSTALLER_SCRIPT).toContain(
      "catch [System.ComponentModel.Win32Exception]",
    );
    expect(WINDOWS_DRIVER_INSTALLER_SCRIPT).toContain("NativeErrorCode");
  });
});
