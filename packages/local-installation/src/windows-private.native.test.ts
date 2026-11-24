import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  closeWindowsPrivateWorker,
  parseWindowsPrivateFailure,
  WINDOWS_PRIVATE_PREAMBLE,
  WINDOWS_PRIVATE_SCRIPT,
  windowsPowerShellArguments,
  windowsPrivateLocation,
  windowsPrivatePath,
} from "./windows-private.js";
import { runProcess } from "./process.js";
import {
  WITHOUT_ADMINISTRATORS_SCRIPT,
  windowsCommandLine,
} from "./windows-restricted-token.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "linger-private-acl-"));
  roots.push(root);
  await windowsPrivatePath(root, "directory", true);
  return root;
}
it.skipIf(process.platform !== "win32")(
  "passes a literal path through stdin to both PowerShell launch modes",
  { timeout: 60_000 },
  async () => {
    const root = await fixture();
    const target = path.join(root, "spaces and 'quotes' \u6587");
    await mkdir(target);
    await windowsPrivatePath(target, "directory", true);
    await windowsPrivatePath(target, "directory", false, runProcess);
  },
);
it.skipIf(process.platform !== "win32")(
  "restores write access to a private directory with a read-only owner rule",
  { timeout: 30_000 },
  async () => {
    const root = await fixture();
    const script = [
      "$ErrorActionPreference='Stop'",
      "$item = Get-Item -LiteralPath ([Console]::In.ReadToEnd())",
      "$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User",
      "$acl = [Security.AccessControl.DirectorySecurity]::new()",
      "$acl.SetAccessRuleProtection($true, $false)",
      "$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))",
      "$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-18'), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))",
      "$item.SetAccessControl($acl)",
    ].join("\n");
    const changed = await runProcess(
      path.win32.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { input: root, timeoutMs: 30_000 },
    );
    expect(changed.code, changed.stderr).toBe(0);
    await expect(
      windowsPrivatePath(root, "directory"),
    ).resolves.toBeUndefined();
    const file = path.join(root, "settings.json");
    await expect(writeFile(file, "{}")).rejects.toMatchObject({
      code: expect.stringMatching(/^(EACCES|EPERM)$/),
    });
    await windowsPrivatePath(root, "directory", true);
    await writeFile(file, "{}");
  },
);
it.skipIf(process.platform !== "win32")(
  "skips the DACL write for an already repaired directory",
  { timeout: 30_000 },
  async () => {
    const root = await fixture();
    const needsRepair = path.join(root, "needs-repair");
    await mkdir(needsRepair);

    const writeDacl = "if ($PSVersionTable.PSEdition -eq 'Core')";
    expect(WINDOWS_PRIVATE_SCRIPT).toContain(writeDacl);
    // Fail at the persistence boundary after inspecting a real NTFS DACL.
    const script = WINDOWS_PRIVATE_SCRIPT.replace(
      writeDacl,
      "throw 'UNEXPECTED_DACL_WRITE'; " + writeDacl,
    );
    const powershell = path.win32.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    );
    const probe = (directory: string) =>
      runProcess(
        powershell,
        // The full script as -EncodedCommand is the long command line that
        // stalls behind some endpoint security; launch it as production does.
        windowsPowerShellArguments(script),
        {
          input: JSON.stringify({
            path: directory,
            kind: "directory",
            repair: true,
          }),
          timeoutMs: 15_000,
        },
      );
    const repaired = await probe(root);
    expect(repaired.code, repaired.stdout || repaired.stderr).toBe(0);
    const inherited = await probe(needsRepair);
    expect(inherited.code).toBe(1);
    expect(inherited.stdout.trim()).toBe("UNEXPECTED_DACL_WRITE");
  },
);
it.skipIf(process.platform !== "win32")(
  "creates a protected user/SYSTEM DACL and accepts inherited private files",
  async () => {
    const root = await fixture();
    const file = path.join(root, "settings.json");
    await writeFile(file, "{}");
    await expect(windowsPrivatePath(file, "file")).resolves.toBeUndefined();
    await expect(
      windowsPrivatePath(root, "directory"),
    ).resolves.toBeUndefined();
  },
);
it.skipIf(process.platform !== "win32")(
  "uses the native Get-Acl despite the caller's module path",
  { timeout: 30_000 },
  async () => {
    const root = await fixture();
    const modules = path.join(root, "modules");
    const name = "Microsoft.PowerShell.Security";
    await mkdir(path.join(modules, name), { recursive: true });
    await writeFile(
      path.join(modules, name, name + ".psm1"),
      "function Get-Acl { throw 'UNEXPECTED_ACL_MODULE' }; Export-ModuleMember -Function Get-Acl",
    );
    const foreignModules = [modules, process.env.PSModulePath]
      .filter(Boolean)
      .join(path.delimiter);
    vi.stubEnv("PSModulePath", foreignModules);
    // Start a fresh worker so it inherits the stubbed PSModulePath.
    closeWindowsPrivateWorker();
    try {
      const privateFile = path.join(root, "settings.json");
      await writeFile(privateFile, "{}");
      await expect(
        windowsPrivatePath(privateFile, "file"),
      ).resolves.toBeUndefined();
      expect(process.env.PSModulePath).toBe(foreignModules);
    } finally {
      vi.unstubAllEnvs();
      closeWindowsPrivateWorker();
    }
  },
);
it.skipIf(process.platform !== "win32")(
  "accepts private paths that Administrators own, as an elevated Linger creates them",
  async (context) => {
    const root = await fixture();
    const file = path.join(root, "manager.sqlite");
    await writeFile(file, "");
    const script =
      "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); $p=[Console]::In.ReadToEnd(); foreach ($path in @($p, [IO.Path]::GetDirectoryName($p))) { $a=Get-Acl -LiteralPath $path; $a.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')); Set-Acl -LiteralPath $path -AclObject $a }";
    const changed = await runProcess(
      path.win32.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { input: file, timeoutMs: 30000 },
    );
    // Only an elevated process may hand a file to Administrators.
    if (changed.code !== 0) return context.skip();
    await expect(windowsPrivatePath(file, "file")).resolves.toBeUndefined();
    await expect(
      windowsPrivatePath(root, "directory", true),
    ).resolves.toBeUndefined();
    // A token with Administrators disabled and no elevated token linked to
    // it, like a standard user's, does not accept that owner.
    const powershell = path.win32.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const encoded = (text: string) =>
      Buffer.from(text, "utf16le").toString("base64");
    const program = path.join(root, "check.ps1");
    const request = path.join(root, "request.json");
    const output = path.join(root, "output.txt");
    await writeFile(program, WINDOWS_PRIVATE_SCRIPT);
    await writeFile(
      request,
      JSON.stringify({ path: file, kind: "file", repair: false }),
    );
    // The program reads its request from a real stdin, as windowsPrivatePath
    // sends it; a PowerShell pipe into powershell.exe would send CLIXML.
    const check = [
      `$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes((Get-Content -Raw -LiteralPath '${program}')))`,
      `$p = Start-Process -FilePath '${powershell}' -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand',$encoded -RedirectStandardInput '${request}' -RedirectStandardOutput '${output}' -NoNewWindow -Wait -PassThru`,
      `[Console]::Out.Write((Get-Content -Raw -LiteralPath '${output}'))`,
      "exit $p.ExitCode",
    ].join("; ");
    const restricted = await runProcess(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        encoded(WITHOUT_ADMINISTRATORS_SCRIPT),
      ],
      {
        input: JSON.stringify(
          windowsCommandLine(powershell, [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            encoded(check),
          ]),
        ),
        timeoutMs: 60000,
      },
    );
    expect(restricted.code).toBe(1);
    expect(parseWindowsPrivateFailure(restricted.stdout)).toMatchObject({
      reason: "UNSAFE_OWNER",
      sid: "S-1-5-32-544",
    });
  },
);
it.skipIf(process.platform !== "win32")(
  "rejects a junction as either the target or an ancestor",
  async () => {
    const root = await fixture();
    const junction = path.join(root, "link");
    await symlink(root, junction, "junction");
    await writeFile(path.join(root, "settings.json"), "{}");
    await expect(
      windowsPrivatePath(junction, "directory"),
    ).rejects.toMatchObject({ reason: "UNSAFE_TYPE", path: junction });
    await expect(
      windowsPrivatePath(path.join(junction, "settings.json"), "file"),
    ).rejects.toMatchObject({ reason: "UNSAFE_PARENT_LINK" });
  },
);
it.skipIf(process.platform !== "win32")(
  "rejects an ACL allowing another identity to read private state",
  async () => {
    const root = await fixture();
    const file = path.join(root, "settings.json");
    await writeFile(file, "{}");
    const script =
      "$ErrorActionPreference='Stop'; $p=[Console]::In.ReadToEnd(); $item=[IO.FileInfo]::new($p); $a=$item.GetAccessControl([Security.AccessControl.AccessControlSections]::Access); $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Read','Allow')); $item.SetAccessControl($a)";
    const changed = await runProcess(
      path.win32.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { input: file, timeoutMs: 30000 },
    );
    expect(changed.code).toBe(0);
    await expect(windowsPrivatePath(file, "file")).rejects.toMatchObject({
      reason: "SHARED_ACCESS",
      path: file,
    });
  },
);
it.skipIf(process.platform !== "win32")(
  "accepts inherit-only ancestor Modify ACEs but rejects effective ancestor access and broad private target inheritance",
  async () => {
    const root = await fixture();
    const child = path.join(root, "private");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(child);
    await windowsPrivatePath(child, "directory", true);
    const mutate = async (propagation: "InheritOnly" | "None") => {
      const script = `$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); $p=[Console]::In.ReadToEnd(); $item=[IO.DirectoryInfo]::new($p); $a=$item.GetAccessControl([Security.AccessControl.AccessControlSections]::Access); $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-11'),'Modify','ContainerInherit,ObjectInherit','${propagation}','Allow')); $item.SetAccessControl($a)`;
      const changed = await runProcess(
        path.win32.join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        { input: root, timeoutMs: 30000 },
      );
      expect(changed.code).toBe(0);
    };
    await mutate("InheritOnly");
    await expect(
      windowsPrivatePath(child, "directory"),
    ).resolves.toBeUndefined();
    // A private target also owns future descendants, so broad inheritance on
    // the target remains forbidden even when it is inherit-only.
    await expect(windowsPrivatePath(root, "directory")).rejects.toMatchObject({
      reason: "SHARED_ACCESS",
    });
    await mutate("None");
    await expect(windowsPrivatePath(child, "directory")).rejects.toMatchObject({
      reason: "UNSAFE_PARENT_ACCESS",
    });
  },
);

// Elevated runners return from Test-Administrator before the linked-token
// check, so this builds and calls both Test-Administrator and
// Test-LinkedTokenAdministrator directly, plus the PowerShell SID classifiers.
it.skipIf(process.platform !== "win32")(
  "runs Test-Administrator, the in-memory linked-token check without Add-Type, and the PowerShell SID classifiers",
  async () => {
    expect(WINDOWS_PRIVATE_PREAMBLE).not.toContain("Add-Type");
    expect(WINDOWS_PRIVATE_PREAMBLE).toContain("DefinePInvokeMethod");
    const powershell = path.win32.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    );
    const probe = [
      WINDOWS_PRIVATE_PREAMBLE,
      "$res = [ordered]@{",
      "  admin = (Test-Administrator).GetType().FullName",
      "  linked = (Test-LinkedTokenAdministrator).GetType().FullName",
      "  rid500 = Test-BuiltinAdminSid 'S-1-5-21-3623811015-3361044348-30300820-500'",
      "  rid512 = Test-BuiltinAdminSid 'S-1-5-21-3623811015-3361044348-30300820-512'",
      "  rid513 = Test-BuiltinAdminSid 'S-1-5-21-3623811015-3361044348-30300820-513'",
      "  everyone = Test-EligibleAdminMemberSid 'S-1-1-0'",
      "  member1006 = Test-EligibleAdminMemberSid 'S-1-5-21-3623811015-3361044348-30300820-1006'",
      "  entra = Test-EligibleAdminMemberSid 'S-1-12-1-11-22-33-44'",
      "}",
      "[Console]::Out.Write(($res | ConvertTo-Json -Compress))",
    ].join("\n");
    const result = await runProcess(
      powershell,
      windowsPowerShellArguments(probe),
      { timeoutMs: 30_000 },
    );
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      admin: "System.Boolean",
      linked: "System.Boolean",
      rid500: true,
      rid512: true,
      rid513: false,
      everyone: false,
      member1006: true,
      entra: true,
    });
  },
  60_000,
);
it.skipIf(process.platform !== "win32")(
  "validates existing and missing candidate directories with windowsPrivateLocation without creating them",
  async () => {
    const root = await fixture();
    const pending = path.join(root, "not-created-yet", "computer");
    await expect(windowsPrivateLocation(root)).resolves.toBeUndefined();
    await expect(windowsPrivateLocation(pending)).resolves.toBeUndefined();
  },
  30_000,
);
