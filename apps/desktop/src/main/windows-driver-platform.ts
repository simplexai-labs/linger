import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type {
  AuthenticodeCheckResult,
  WindowsInstallerRunResult,
} from "./driver-updater.js";

const runFile = promisify(execFile);

const EXPECTED_SIGNER_CN = "NVIDIA Corporation";
const BASE_ARGS = ["-NoProfile", "-NonInteractive", "-Command"] as const;

function windowsPowerShellPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const systemRoot = env.SystemRoot?.trim() || "C:\\Windows";
  return path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

/**
 * Extracts the exact Common Name (CN) relative distinguished name from an X.509
 * subject string such as `CN=NVIDIA Corporation, O=NVIDIA Corporation, C=US`.
 * Prevents spoofing via OU/L attributes or substring matches like `CN=Fake NVIDIA Corporation`.
 */
function extractSubjectCommonName(subject: string): string | undefined {
  const match = /(?:^|,\s*)CN=(?:"([^"]+)"|([^,]+))(?=,|$)/i.exec(
    subject.trim(),
  );
  const raw = match?.[1] ?? match?.[2];
  return raw?.trim() || undefined;
}

/**
 * Parses the structured JSON emitted by `Get-AuthenticodeSignature` and
 * verifies both a `Valid` Windows trust-store status and an exact
 * `NVIDIA Corporation` signer Common Name.
 */
export function parseAuthenticodeOutput(
  stdout: string,
): AuthenticodeCheckResult {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    if (!parsed || typeof parsed !== "object") {
      return { valid: false };
    }
    const record = parsed as {
      Status?: unknown;
      Subject?: unknown;
      SimpleName?: unknown;
    };
    const status = typeof record.Status === "string" ? record.Status : "";
    const subject = typeof record.Subject === "string" ? record.Subject : "";
    const simpleName =
      typeof record.SimpleName === "string" ? record.SimpleName.trim() : "";
    const commonName = extractSubjectCommonName(subject);
    const signerMatches =
      commonName === EXPECTED_SIGNER_CN &&
      (!simpleName || simpleName === EXPECTED_SIGNER_CN);
    return {
      valid: status === "Valid" && signerMatches,
      subject,
    };
  } catch {
    return { valid: false };
  }
}

/**
 * Parses the structured JSON emitted by `runWindowsDriverInstaller`.
 * Classifies Win32 `ERROR_CANCELLED` (`1223`) directly from `NativeErrorCode`
 * so UAC cancellation works identically across all Windows locales without
 * matching localized error prose.
 */
export function parseWindowsInstallerRunOutput(
  stdout: string,
): WindowsInstallerRunResult {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    if (!parsed || typeof parsed !== "object") {
      return { outcome: "failed" };
    }
    const record = parsed as { exitCode?: unknown; win32Error?: unknown };
    if (record.win32Error === 1223) {
      return { outcome: "uac_cancelled" };
    }
    if (
      typeof record.exitCode === "number" &&
      Number.isInteger(record.exitCode)
    ) {
      if (record.exitCode === 0) return { outcome: "completed" };
      if (record.exitCode === 1 || record.exitCode === 3010) {
        return { outcome: "reboot_required" };
      }
      return { outcome: "failed", exitCode: record.exitCode };
    }
    return { outcome: "failed" };
  } catch {
    return { outcome: "failed" };
  }
}

/**
 * Probes the first NVIDIA graphics adapter display name on Windows via CIM.
 * Returns undefined when unavailable or on any command error.
 */
export async function detectWindowsNvidiaGpuName(): Promise<
  string | undefined
> {
  try {
    const { stdout } = await runFile(
      windowsPowerShellPath(),
      [
        ...BASE_ARGS,
        "Get-CimInstance -ClassName Win32_VideoController | Where-Object { $_.Name -match 'NVIDIA' } | Select-Object -First 1 -ExpandProperty Name",
      ],
      {
        timeout: 10_000,
        windowsHide: true,
      },
    );
    const name = stdout.trim();
    return name || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Verifies a downloaded Windows executable's Authenticode signature using
 * Windows' native trust store. Passes the file path through an environment
 * variable to avoid shell quoting hazards.
 */
export async function verifyWindowsAuthenticode(
  exePath: string,
): Promise<AuthenticodeCheckResult> {
  try {
    const { stdout } = await runFile(
      windowsPowerShellPath(),
      [
        ...BASE_ARGS,
        "$sig = Get-AuthenticodeSignature -LiteralPath $env:LINGER_DRIVER_EXE; [PSCustomObject]@{ Status = [string]$sig.Status; Subject = if ($sig.SignerCertificate) { [string]$sig.SignerCertificate.Subject } else { '' }; SimpleName = if ($sig.SignerCertificate) { [string]$sig.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) } else { '' } } | ConvertTo-Json -Compress",
      ],
      {
        env: { ...process.env, LINGER_DRIVER_EXE: exePath },
        timeout: 30_000,
        windowsHide: true,
      },
    );
    return parseAuthenticodeOutput(stdout);
  } catch {
    return { valid: false };
  }
}

/**
 * PowerShell snippet that launches the verified NVIDIA installer directly via
 * .NET `ProcessStartInfo` / `Process::Start` with `Verb = 'runas'` so a UAC
 * denial surfaces `System.ComponentModel.Win32Exception` with
 * `NativeErrorCode = 1223` (unlike `Start-Process -Verb RunAs`, whose
 * `StartWithShellExecute` swallows `Win32Exception` and rethrows an
 * `InvalidOperationException` with no inner exception). Walks `InnerException`
 * inside the `Win32Exception` catch block because PowerShell wraps .NET method
 * exceptions in `MethodInvocationException`.
 */
export const WINDOWS_DRIVER_INSTALLER_SCRIPT =
  "$ErrorActionPreference = 'Stop'; try { $psi = [System.Diagnostics.ProcessStartInfo]::new($env:LINGER_DRIVER_EXE, '-s -noreboot -noeula'); $psi.UseShellExecute = $true; $psi.Verb = 'runas'; $p = [System.Diagnostics.Process]::Start($psi); if ($null -eq $p) { [PSCustomObject]@{ win32Error = $null } | ConvertTo-Json -Compress } else { try { $p.WaitForExit(); [PSCustomObject]@{ exitCode = $p.ExitCode } | ConvertTo-Json -Compress } finally { $p.Dispose() } } } catch [System.ComponentModel.Win32Exception] { $e = $_.Exception; $win32 = $null; while ($e) { if ($e -is [System.ComponentModel.Win32Exception]) { $win32 = $e.NativeErrorCode; break }; $e = $e.InnerException }; [PSCustomObject]@{ win32Error = $win32 } | ConvertTo-Json -Compress } catch { [PSCustomObject]@{ win32Error = $null } | ConvertTo-Json -Compress }";

/**
 * Runs a verified NVIDIA Windows DCH installer with UAC elevation in silent,
 * non-rebooting mode (`-s -noreboot -noeula`) and classifies its structured
 * exit code or Win32 error code (`1223` = UAC cancelled).
 */
export async function runWindowsDriverInstaller(
  exePath: string,
): Promise<WindowsInstallerRunResult> {
  try {
    const { stdout } = await runFile(
      windowsPowerShellPath(),
      [...BASE_ARGS, WINDOWS_DRIVER_INSTALLER_SCRIPT],
      {
        env: { ...process.env, LINGER_DRIVER_EXE: exePath },
        timeout: 30 * 60_000,
        windowsHide: true,
      },
    );
    return parseWindowsInstallerRunOutput(stdout);
  } catch {
    return { outcome: "failed" };
  }
}
