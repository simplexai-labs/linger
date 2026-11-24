import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { runProcess } from "./process.js";

const TRUSTED_INSTALLER_SID =
  "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";

export const WINDOWS_PRIVATE_PREAMBLE = String.raw`$ErrorActionPreference = 'Stop'
# This fixed Windows PowerShell script uses only its own built-in modules.
# A caller's PowerShell 7 modules can prevent Get-Acl from loading.
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$script:isAdministrator = $null
function Test-Uint32Token([string]$Token) {
  if ($Token -cnotmatch '^(0|[1-9][0-9]{0,9})$') { return $false }
  $n = [uint32]0
  return [uint32]::TryParse($Token, [Globalization.NumberStyles]::None, [Globalization.CultureInfo]::InvariantCulture, [ref]$n)
}
# Canonical built-in Administrator (RID 500), Domain Admins (RID 512), and
# Enterprise Admins (RID 519). Ordinary accounts start at RID 1000.
function Test-BuiltinAdminSid([string]$Value) {
  $parts = $Value -split '-'
  if ($parts.Count -ne 8 -or ($parts[0..3] -join '-') -cne 'S-1-5-21') { return $false }
  foreach ($p in $parts[4..6]) { if (-not (Test-Uint32Token $p)) { return $false } }
  return $parts[7] -in @('500', '512', '519')
}
# Individual/domain (RID >= 1000) or Entra ID SIDs eligible when listed as
# direct members of BUILTIN\Administrators. Broad groups are never admitted.
function Test-EligibleAdminMemberSid([string]$Value) {
  $parts = $Value -split '-'
  if ($parts.Count -ne 8) { return $false }
  $prefix = $parts[0..3] -join '-'
  if ($prefix -ceq 'S-1-5-21') {
    foreach ($p in $parts[4..7]) { if (-not (Test-Uint32Token $p)) { return $false } }
    return [uint32]$parts[7] -ge 1000
  }
  if ($prefix -ceq 'S-1-12-1') {
    foreach ($p in $parts[4..7]) { if (-not (Test-Uint32Token $p)) { return $false } }
    return $true
  }
  return $false
}
function Test-CodexCapSid([string]$Value) {
  $parts = $Value -split '-'
  if ($parts.Count -ne 8 -or ($parts[0..3] -join '-') -cne 'S-1-5-21') { return $false }
  foreach ($p in $parts[4..7]) { if (-not (Test-Uint32Token $p)) { return $false } }
  return [uint32]$parts[7] -ge 1000
}
# Emit Win32 P/Invoke stubs directly in memory without invoking csc.exe or
# writing temporary assemblies that AV/WDAC/AppLocker may block.
function Ensure-LingerWin32Native {
  if ('LingerWin32Native' -as [type]) { return }
  $asm = [Reflection.Emit.AssemblyBuilder]::DefineDynamicAssembly(
    [Reflection.AssemblyName]::new('LingerWin32'),
    [Reflection.Emit.AssemblyBuilderAccess]::Run
  )
  $mod = $asm.DefineDynamicModule('LingerWin32')
  $tb = $mod.DefineType('LingerWin32Native', [Reflection.TypeAttributes]'Public,Abstract,Sealed')
  $ma = [Reflection.MethodAttributes]'Public,Static,HideBySig,PinvokeImpl'
  $cc = [Runtime.InteropServices.CallingConvention]::Winapi
  $cs = [Runtime.InteropServices.CharSet]::Unicode
  foreach ($def in @(
    @('OpenProcessToken', 'advapi32.dll', [bool], @([IntPtr], [uint32], [IntPtr].MakeByRefType())),
    @('GetTokenInformation', 'advapi32.dll', [bool], @([IntPtr], [int], [IntPtr].MakeByRefType(), [int], [int].MakeByRefType())),
    @('CheckTokenMembership', 'advapi32.dll', [bool], @([IntPtr], [byte[]], [bool].MakeByRefType())),
    @('GetCurrentProcess', 'kernel32.dll', [IntPtr], [Type]::EmptyTypes),
    @('CloseHandle', 'kernel32.dll', [bool], @([IntPtr])),
    @('NetLocalGroupGetMembers', 'netapi32.dll', [uint32], @([IntPtr], [string], [uint32], [IntPtr].MakeByRefType(), [uint32], [uint32].MakeByRefType(), [uint32].MakeByRefType(), [IntPtr].MakeByRefType())),
    @('NetApiBufferFree', 'netapi32.dll', [uint32], @([IntPtr]))
  )) {
    $m = $tb.DefinePInvokeMethod($def[0], $def[1], $ma, [Reflection.CallingConventions]::Standard, $def[2], [Type[]]$def[3], $cc, $cs)
    $m.SetImplementationFlags($m.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
  }
  $null = $tb.CreateType()
}
function Test-LinkedTokenAdministrator {
  Ensure-LingerWin32Native
  $administrators = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  $binary = [byte[]]::new($administrators.BinaryLength)
  $administrators.GetBinaryForm($binary, 0)
  $token = [IntPtr]::Zero
  if (-not [LingerWin32Native]::OpenProcessToken([LingerWin32Native]::GetCurrentProcess(), [uint32]0x0008, [ref]$token)) { return $false }
  $linked = [IntPtr]::Zero
  $returned = 0
  try {
    if (-not [LingerWin32Native]::GetTokenInformation($token, 19, [ref]$linked, [IntPtr]::Size, [ref]$returned)) { return $false }
  } finally {
    $null = [LingerWin32Native]::CloseHandle($token)
  }
  try {
    $member = $false
    $checked = [LingerWin32Native]::CheckTokenMembership($linked, $binary, [ref]$member)
    return [bool]($checked -and $member)
  } finally {
    $null = [LingerWin32Native]::CloseHandle($linked)
  }
}
# Administrators enabled in this token, or in the elevated token UAC links to
# it (an administrator running without elevation). Standard users lack a linked
# token, so GetTokenInformation(TokenLinkedToken) fails and returns false.
function Test-Administrator {
  if ($null -ne $script:isAdministrator) { return $script:isAdministrator }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  if ([Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $script:isAdministrator = $true
    return $true
  }
  $script:isAdministrator = Test-LinkedTokenAdministrator
  return $script:isAdministrator
}
function Get-LocalAdminMemberSids {
  $sids = @{}
  try {
    Ensure-LingerWin32Native
    $groupName = ([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')).Translate([Security.Principal.NTAccount]).Value
    $slash = $groupName.IndexOf('\')
    if ($slash -ge 0) { $groupName = $groupName.Substring($slash + 1) }
    $resume = [IntPtr]::Zero
    for ($page = 0; $page -lt 16; $page++) {
      $buf = [IntPtr]::Zero
      $read = [uint32]0
      $total = [uint32]0
      $status = [LingerWin32Native]::NetLocalGroupGetMembers([IntPtr]::Zero, $groupName, [uint32]0, [ref]$buf, [uint32]::MaxValue, [ref]$read, [ref]$total, [ref]$resume)
      try {
        if ($buf -ne [IntPtr]::Zero -and ($status -eq 0 -or $status -eq 234)) {
          for ($i = 0; $i -lt [int]$read; $i++) {
            $sidPtr = [Runtime.InteropServices.Marshal]::ReadIntPtr($buf, $i * [IntPtr]::Size)
            if ($sidPtr -ne [IntPtr]::Zero) {
              $memberSid = [Security.Principal.SecurityIdentifier]::new($sidPtr).Value
              if (Test-EligibleAdminMemberSid $memberSid) { $sids[$memberSid] = $true }
            }
          }
        }
      } finally {
        if ($buf -ne [IntPtr]::Zero) { $null = [LingerWin32Native]::NetApiBufferFree($buf) }
      }
      if ($status -ne 234) { break }
    }
  } catch {}
  return $sids
}
function Get-CodexSandboxSids {
  $sids = @{}
  try {
    $groupSid = ([Security.Principal.NTAccount]::new('CodexSandboxUsers')).Translate([Security.Principal.SecurityIdentifier]).Value
    if ($groupSid) { $sids[$groupSid] = $true }
  } catch {}
  $capFiles = @()
  $profile = [Environment]::GetFolderPath('UserProfile')
  if ($profile) { $capFiles += [IO.Path]::Combine($profile, '.codex', 'cap_sid') }
  if ($env:CODEX_HOME -and [IO.Path]::IsPathRooted($env:CODEX_HOME)) { $capFiles += [IO.Path]::Combine($env:CODEX_HOME, 'cap_sid') }
  foreach ($capFile in $capFiles) {
    try {
      if (-not (Test-Path -LiteralPath $capFile -PathType Leaf)) { continue }
      $caps = [IO.File]::ReadAllText($capFile) | ConvertFrom-Json
      $values = @([string]$caps.workspace)
      foreach ($roots in @($caps.workspace_by_cwd, $caps.writable_root_by_path)) {
        if ($roots) { $values += @($roots.PSObject.Properties | ForEach-Object { [string]$_.Value }) }
      }
      foreach ($value in $values) {
        if (Test-CodexCapSid $value) { $sids[$value] = $true }
      }
    } catch {}
  }
  return $sids
}
function Format-PrivateFailure([string]$Code, [string]$Stage, [string]$Ancestor, [string]$Sid, $Exception) {
  try {
    if ($Code -cmatch '^[A-Z][A-Z_]+$') {
      if (-not $Ancestor -and -not $Sid) { return $Code }
      $out = [ordered]@{ code = $Code }
      if ($Ancestor) { $out.ancestor = $Ancestor }
      if ($Sid) { $out.sid = $Sid }
      return ($out | ConvertTo-Json -Compress)
    }
    $out = [ordered]@{ code = 'UNCHECKED' }
    if ($Stage) { $out.stage = $Stage }
    if ($null -ne $Exception) {
      $out.errorType = $Exception.GetType().Name
      $out.hresult = ('0x{0:X8}' -f $Exception.HResult)
    }
    return ($out | ConvertTo-Json -Compress)
  } catch {
    return 'UNCHECKED'
  }
}`;

const WINDOWS_PRIVATE_CHECK_BODY = String.raw`  $stage = 'target'
  $failAncestor = ''
  $failSid = ''
  $adminMembers = $null
  $codexSids = $null
  if ([string]$request.path -like '\\*') { throw 'UNSAFE_TYPE' }
  if ($request.kind -eq 'location') {
    if (Test-Path -LiteralPath $request.path) {
      $item = Get-Item -LiteralPath $request.path -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or !$item.PSIsContainer -or !$item.Parent) { throw 'UNSAFE_TYPE' }
      $stage = 'owner'
      $acl = Get-Acl -LiteralPath $item.FullName
      $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
      if ($owner -ne $sid.Value -and !($owner -eq $admins -and (Test-Administrator))) { $failSid = $owner; throw 'UNSAFE_OWNER' }
      $parent = $item.Parent
    } else {
      $probe = [IO.Path]::GetDirectoryName($request.path)
      while ($probe -and !(Test-Path -LiteralPath $probe)) {
        $next = [IO.Path]::GetDirectoryName($probe)
        if ($next -eq $probe) { $probe = $null; break }
        $probe = $next
      }
      if (!$probe) { throw 'UNSAFE_TYPE' }
      $parent = Get-Item -LiteralPath $probe -Force
      if (!$parent.PSIsContainer) { throw 'UNSAFE_TYPE' }
    }
  } else {
    $item = Get-Item -LiteralPath $request.path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($item.PSIsContainer -ne ($request.kind -eq 'directory'))) { throw 'UNSAFE_TYPE' }
    $stage = 'owner'
    $acl = Get-Acl -LiteralPath $item.FullName
    # What an elevated process (Run as administrator, the built-in
    # Administrator) creates is owned by Administrators. For an administrator
    # that owner counts as the user, as in Git for Windows: the ancestor check
    # below already lets the group own and replace every parent folder, and an
    # administrator can take ownership of any file, so it trusts no one new.
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($owner -ne $sid.Value -and !($owner -eq $admins -and (Test-Administrator))) { $failSid = $owner; throw 'UNSAFE_OWNER' }
    $parent = $item.Directory
    if ($item.PSIsContainer) { $parent = $item.Parent }
  }
  $stage = 'ancestor'
  while ($parent) {
    if ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) { $failAncestor = $parent.FullName; throw 'UNSAFE_PARENT_LINK' }
    $parentAcl = Get-Acl -LiteralPath $parent.FullName
    $owner = $parentAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($owner -notin @($sid.Value, $system, $admins, $trustedInstaller) -and -not (Test-BuiltinAdminSid $owner)) {
      if ($null -eq $adminMembers) { $adminMembers = Get-LocalAdminMemberSids }
      if (-not $adminMembers.ContainsKey($owner)) { $failAncestor = $parent.FullName; $failSid = $owner; throw 'UNSAFE_PARENT_OWNER' }
    }
    # An ancestor is unsafe when another account can put a different folder
    # where the private one is. Delete lets its holder rename or remove the
    # folder that grants it; a volume root can be neither, and its stock ACL
    # grants Delete to Authenticated Users. Replacing a child of the root or
    # rewriting the root's ACL stays refused.
    $replace = 'DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'
    if ($parent.Parent) { $replace = "Delete,$replace" }
    foreach ($rule in $parentAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      # InheritOnly ACEs do not authorize mutation of this ancestor. They are
      # still checked below when present on the private target itself.
      if ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) { continue }
      if ($rule.AccessControlType -ne 'Allow') { continue }
      if (-not ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]$replace)) { continue }
      $ruleSid = $rule.IdentityReference.Value
      if ($ruleSid -in @($sid.Value, $system, $admins, 'S-1-3-0', 'S-1-3-4', $trustedInstaller) -or (Test-BuiltinAdminSid $ruleSid)) { continue }
      if ($null -eq $adminMembers) { $adminMembers = Get-LocalAdminMemberSids }
      if ($adminMembers.ContainsKey($ruleSid)) { continue }
      if ($null -eq $codexSids) { $codexSids = Get-CodexSandboxSids }
      if ($codexSids.ContainsKey($ruleSid)) { continue }
      $failAncestor = $parent.FullName
      $failSid = $ruleSid
      throw 'UNSAFE_PARENT_ACCESS'
    }
    $parent = $parent.Parent
  }
  if ($request.kind -ne 'location') {
  $stage = 'repair'
  if ($request.repair) {
    # Only the DACL that repair would install can skip propagation. Compare
    # the rules because Windows may add flags to the persisted descriptor.
    $inheritance = if ($item.PSIsContainer) { 'ContainerInherit, ObjectInherit' } else { 'None' }
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    $fullControl = @($rules | Where-Object {
      !$_.IsInherited -and $_.AccessControlType -eq 'Allow' -and $_.FileSystemRights -eq 'FullControl' -and
      $_.InheritanceFlags -eq $inheritance -and $_.PropagationFlags -eq 'None'
    } | ForEach-Object { $_.IdentityReference.Value })
    $alreadyRepaired = $acl.AreAccessRulesProtected -and $rules.Count -eq 2 -and
      $fullControl -contains $sid.Value -and $fullControl -contains $system
    if (!$alreadyRepaired) {
      $acl = if ($item.PSIsContainer) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
      $acl.SetAccessRuleProtection($true, $false)
      foreach ($principal in @($sid, [Security.Principal.SecurityIdentifier]::new($system))) {
        $rule = if ($item.PSIsContainer) {
          [Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        } else { [Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', 'Allow') }
        $acl.AddAccessRule($rule)
      }
      # DACL-only persistence avoids Set-Acl's SACL privilege requirement.
      $null = $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
      if ($PSVersionTable.PSEdition -eq 'Core') { [IO.FileSystemAclExtensions]::SetAccessControl($item, $acl) } else { $item.SetAccessControl($acl) }
      $acl = Get-Acl -LiteralPath $item.FullName
    }
  }
  $stage = 'verify'
  if ($request.kind -eq 'directory' -and !$acl.AreAccessRulesProtected) { throw 'INHERITED_ACCESS' }
  $currentAllowed = $false
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow') {
      if ($rule.IdentityReference.Value -notin @($sid.Value, $system)) { $failSid = $rule.IdentityReference.Value; throw 'SHARED_ACCESS' }
      if ($rule.IdentityReference.Value -eq $sid.Value) { $currentAllowed = $true }
    }
  }
  if (!$currentAllowed) { throw 'MISSING_OWNER_ACCESS' }
  }`;

// The program is fixed. Only a path and operation travel over stdin; no file
// contents, user-controlled PowerShell, or credentials appear in argv/output.
export const WINDOWS_PRIVATE_SCRIPT = `
if ("$($ExecutionContext.SessionState.LanguageMode)" -ne 'FullLanguage') {
  Write-Output ('{"code":"UNCHECKED","stage":"language_mode","errorType":"' + "$($ExecutionContext.SessionState.LanguageMode)" + '"}')
  exit 1
}
${WINDOWS_PRIVATE_PREAMBLE}
$stage = 'init'
$failAncestor = ''
$failSid = ''
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $system = 'S-1-5-18'; $admins = 'S-1-5-32-544'; $trustedInstaller = '${TRUSTED_INSTALLER_SID}'
${WINDOWS_PRIVATE_CHECK_BODY}
  exit 0
} catch {
  # Only allowlisted reason codes, offending ancestor/SID, or exception
  # type/HRESULT leave the script; never raw system error prose.
  [Console]::Out.Write((Format-PrivateFailure ([string]$_.Exception.Message) $stage $failAncestor $failSid $_.Exception))
  exit 1
}
`;

const WORKER_OK = "__LINGER_ACL_OK__";
const WORKER_ERR = "__LINGER_ACL_ERR__:";

// Reuses one PowerShell process across sequential ACL checks instead of paying
// a full .NET CLR startup (~1s) for every private directory and file.
export const WINDOWS_PRIVATE_WORKER_SCRIPT = `
if ("$($ExecutionContext.SessionState.LanguageMode)" -ne 'FullLanguage') {
  Write-Output ('${WORKER_ERR}{"code":"UNCHECKED","stage":"language_mode","errorType":"' + "$($ExecutionContext.SessionState.LanguageMode)" + '"}')
  exit 1
}
${WINDOWS_PRIVATE_PREAMBLE}
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = 'S-1-5-18'; $admins = 'S-1-5-32-544'; $trustedInstaller = '${TRUSTED_INSTALLER_SID}'
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Length -eq 0) { continue }
  $stage = 'init'
  $failAncestor = ''
  $failSid = ''
  try {
    $request = $line | ConvertFrom-Json
${WINDOWS_PRIVATE_CHECK_BODY}
    [Console]::Out.WriteLine('${WORKER_OK}')
  } catch {
    [Console]::Out.WriteLine('${WORKER_ERR}' + (Format-PrivateFailure ([string]$_.Exception.Message) $stage $failAncestor $failSid $_.Exception))
  }
  [Console]::Out.Flush()
}
`;

const REQUEST_TIMEOUT_MS = 30_000;
const WORKER_IDLE_MS = 5_000;

const SID_PATTERN = /^S-1-\d+(?:-\d+)*$/;
const STAGE_PATTERN = /^[a-z_]{1,32}$/;
const ERROR_TYPE_PATTERN = /^[A-Za-z0-9_.]{1,80}$/;
const HRESULT_PATTERN = /^0x[0-9A-Fa-f]{8}$/;
const WORKER_DIAGNOSTIC_PATTERN = /^[a-z0-9_:=., -]{1,160}$/i;

export interface ParsedWindowsPrivateFailure {
  readonly reason: WindowsPrivateReason;
  readonly ancestor?: string;
  readonly sid?: string;
  readonly diagnostic?: string;
}

function sanitizeAncestor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512) return undefined;
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return undefined;
  }
  return trimmed;
}

/**
 * Parses the fixed ACL script's structured stdout and worker lifecycle
 * diagnostics, admitting only allowlisted reason codes, validated SIDs,
 * offending ancestor paths, and sanitized exception/worker tokens.
 */
export function parseWindowsPrivateFailure(
  stdout: string,
  workerDiagnostic?: string,
): ParsedWindowsPrivateFailure {
  const trimmed = stdout.trim();
  if (Object.hasOwn(WINDOWS_PRIVATE_REASONS, trimmed)) {
    return { reason: trimmed as WindowsPrivateReason };
  }
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const rawCode = typeof parsed.code === "string" ? parsed.code.trim() : "";
      const reason: WindowsPrivateReason = Object.hasOwn(
        WINDOWS_PRIVATE_REASONS,
        rawCode,
      )
        ? (rawCode as WindowsPrivateReason)
        : "UNCHECKED";
      const sid =
        typeof parsed.sid === "string" && SID_PATTERN.test(parsed.sid)
          ? parsed.sid
          : undefined;
      const ancestor = reason.startsWith("UNSAFE_PARENT_")
        ? sanitizeAncestor(parsed.ancestor)
        : undefined;
      const diagParts: string[] = [];
      if (
        typeof parsed.stage === "string" &&
        STAGE_PATTERN.test(parsed.stage)
      ) {
        diagParts.push(`stage=${parsed.stage}`);
      }
      if (
        typeof parsed.errorType === "string" &&
        ERROR_TYPE_PATTERN.test(parsed.errorType)
      ) {
        diagParts.push(`type=${parsed.errorType}`);
      }
      if (
        typeof parsed.hresult === "string" &&
        HRESULT_PATTERN.test(parsed.hresult)
      ) {
        diagParts.push(`hresult=${parsed.hresult}`);
      }
      const diagnostic =
        diagParts.length > 0 ? diagParts.join(", ") : undefined;
      return {
        reason,
        ...(ancestor ? { ancestor } : {}),
        ...(sid ? { sid } : {}),
        ...(diagnostic ? { diagnostic } : {}),
      };
    } catch {
      // Fall through to fail-closed UNCHECKED with sanitized worker info.
    }
  }
  const diagnostic =
    workerDiagnostic && WORKER_DIAGNOSTIC_PATTERN.test(workerDiagnostic.trim())
      ? workerDiagnostic.trim()
      : undefined;
  return {
    reason: "UNCHECKED",
    ...(diagnostic ? { diagnostic } : {}),
  };
}

interface WorkerResponse {
  code: number;
  stdout: string;
  workerDiagnostic?: string;
}

interface Refable {
  ref?(): unknown;
  unref?(): unknown;
}

interface WorkerProcess extends Refable {
  stdin: NodeJS.WritableStream & Refable & { end(): void };
  stdout: NodeJS.ReadableStream & Refable;
  kill(): void;
  on(
    event: "close",
    listener: (code?: number | null, signal?: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: "error", listener: (error?: Error) => void): unknown;
}

export interface WindowsPrivateWorkerOptions {
  spawnWorker?: () => WorkerProcess;
  timeoutMs?: number;
  idleMs?: number;
}

function setWorkerRef(child: WorkerProcess, active: boolean): void {
  const method = active ? "ref" : "unref";
  child[method]?.();
  child.stdin[method]?.();
  child.stdout[method]?.();
}

function powershellPath(): string {
  return path.win32.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

// Both launch sites and the native test share these arguments, so the test
// covers how Node's Windows argv quoting carries the script's double quotes.
export function windowsPowerShellArguments(script: string): string[] {
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script];
}

function spawnDefaultWorker(): WorkerProcess {
  return spawn(
    powershellPath(),
    windowsPowerShellArguments(WINDOWS_PRIVATE_WORKER_SCRIPT),
    {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    },
  );
}

function sanitizeErrnoCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,32}$/.test(code)
    ? code
    : "unknown";
}

export function createWindowsPrivateClient(
  options: WindowsPrivateWorkerOptions = {},
) {
  const spawnWorker = options.spawnWorker ?? spawnDefaultWorker;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const idleMs = options.idleMs ?? WORKER_IDLE_MS;

  let active: {
    child: WorkerProcess;
    lines: ReturnType<typeof createInterface>;
    pending?: (response: WorkerResponse) => void;
    onExit: () => void;
  } | null = null;
  let idleTimer: NodeJS.Timeout | undefined;
  let tail: Promise<void> = Promise.resolve();
  let inFlight = 0;

  const clearIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  const reset = (kill: boolean, workerDiagnostic?: string) => {
    clearIdle();
    const current = active;
    if (!current) return;
    active = null;
    process.off("exit", current.onExit);
    current.lines.close();
    const pending = current.pending;
    current.pending = undefined;
    try {
      if (kill) current.child.kill();
      else current.child.stdin.end();
    } catch {
      // The worker has already exited.
    }
    pending?.({
      code: 1,
      stdout: "",
      ...(workerDiagnostic ? { workerDiagnostic } : {}),
    });
  };

  const scheduleIdle = () => {
    clearIdle();
    if (!active || inFlight > 0) return;
    setWorkerRef(active.child, false);
    idleTimer = setTimeout(() => reset(false), idleMs);
    idleTimer.unref();
  };

  const ensureWorker = () => {
    if (active) {
      setWorkerRef(active.child, true);
      return active;
    }
    const child = spawnWorker();
    const lines = createInterface({ input: child.stdout });
    const onExit = () => {
      try {
        child.kill();
      } catch {
        // The worker has already exited.
      }
    };
    const instance = {
      child,
      lines,
      pending: undefined as ((response: WorkerResponse) => void) | undefined,
      onExit,
    };
    child.stdin.on("error", (error?: Error) => {
      if (active?.child === child)
        reset(true, `worker=stdin:${sanitizeErrnoCode(error)}`);
    });
    lines.on("line", (raw) => {
      const line = raw.trim().replace(/^\ufeff/, "");
      const pending = instance.pending;
      if (!pending) {
        if (active === instance) reset(true, "worker=desync");
        return;
      }
      instance.pending = undefined;
      if (line === WORKER_OK) {
        pending({ code: 0, stdout: "" });
        return;
      }
      if (line.startsWith(WORKER_ERR)) {
        pending({ code: 1, stdout: line.slice(WORKER_ERR.length) });
        return;
      }
      // Unexpected output indicates stream desynchronization; fail closed.
      if (active === instance) reset(true, "worker=desync");
      pending({
        code: 1,
        stdout: "",
        workerDiagnostic: "worker=desync",
      });
    });
    child.on("close", (code, signal) => {
      if (active === instance) {
        const diag =
          typeof code === "number"
            ? `worker=exit:${code}`
            : signal
              ? `worker=signal:${signal}`
              : "worker=closed";
        reset(false, diag);
      }
    });
    child.on("error", (error) => {
      if (active === instance)
        reset(true, `worker=spawn:${sanitizeErrnoCode(error)}`);
    });
    process.once("exit", onExit);
    active = instance;
    return instance;
  };

  const execute = (payload: string): Promise<WorkerResponse> => {
    inFlight += 1;
    clearIdle();
    const runTask = tail.then(
      () =>
        new Promise<WorkerResponse>((resolve) => {
          const instance = ensureWorker();
          let settled = false;
          const finish = (response: WorkerResponse) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            inFlight -= 1;
            scheduleIdle();
            resolve(response);
          };
          const timer = setTimeout(() => {
            if (active === instance) reset(true, "worker=timeout");
            finish({
              code: 1,
              stdout: "",
              workerDiagnostic: "worker=timeout",
            });
          }, timeoutMs);
          timer.unref();
          instance.pending = finish;
          try {
            instance.child.stdin.write(`${payload}\n`);
          } catch (error) {
            const diag = `worker=write:${sanitizeErrnoCode(error)}`;
            if (active === instance) reset(true, diag);
            finish({ code: 1, stdout: "", workerDiagnostic: diag });
          }
        }),
    );
    tail = runTask.then(
      () => undefined,
      () => undefined,
    );
    return runTask;
  };

  return { execute, close: () => reset(false) };
}

const defaultWorker = createWindowsPrivateClient();

/** Closes the default persistent PowerShell worker if one is running. */
export function closeWindowsPrivateWorker(): void {
  defaultWorker.close();
}

function privatePathError(file: string, response: WorkerResponse): Error {
  const parsed = parseWindowsPrivateFailure(
    response.stdout,
    response.workerDiagnostic,
  );
  const target = path.resolve(file);
  const details: string[] = [];
  if (parsed.ancestor) details.push(`ancestor: ${parsed.ancestor}`);
  if (parsed.sid) details.push(`sid: ${parsed.sid}`);
  if (parsed.reason === "UNCHECKED" && parsed.diagnostic)
    details.push(parsed.diagnostic);
  const detailSuffix = details.length > 0 ? ` (${details.join(", ")})` : "";
  return Object.assign(
    new Error(
      `Windows private path validation failed: ${target} ${WINDOWS_PRIVATE_REASONS[parsed.reason]}${detailSuffix}. Use a current-user owned local directory without links or shared access.`,
    ),
    {
      code: WINDOWS_PRIVATE_PATH_UNSAFE,
      reason: parsed.reason,
      path: target,
      ...(parsed.ancestor ? { ancestor: parsed.ancestor } : {}),
      ...(parsed.sid ? { sid: parsed.sid } : {}),
      ...(parsed.diagnostic ? { diagnostic: parsed.diagnostic } : {}),
    },
  );
}

export async function windowsPrivatePath(
  file: string,
  kind: "file" | "directory",
  repair = false,
  run?: typeof runProcess,
): Promise<void> {
  const payload = JSON.stringify({ path: path.resolve(file), kind, repair });
  const result: WorkerResponse = run
    ? await run(
        powershellPath(),
        windowsPowerShellArguments(WINDOWS_PRIVATE_SCRIPT),
        {
          input: payload,
          timeoutMs: REQUEST_TIMEOUT_MS,
        },
      )
    : await defaultWorker.execute(payload);
  if (result.code !== 0) throw privatePathError(file, result);
}

/**
 * Checks whether a candidate Windows install or state directory can host
 * private state without creating it or changing any ACLs. When the directory
 * already exists, verifies its type, owner, and ancestors; otherwise verifies
 * the nearest existing ancestor and every directory above it.
 */
export async function windowsPrivateLocation(
  directory: string,
  run?: typeof runProcess,
): Promise<void> {
  const payload = JSON.stringify({
    path: path.resolve(directory),
    kind: "location",
    repair: false,
  });
  const result: WorkerResponse = run
    ? await run(
        powershellPath(),
        windowsPowerShellArguments(WINDOWS_PRIVATE_SCRIPT),
        {
          input: payload,
          timeoutMs: REQUEST_TIMEOUT_MS,
        },
      )
    : await defaultWorker.execute(payload);
  if (result.code !== 0) throw privatePathError(directory, result);
}

/** The code of an error from windowsPrivatePath; its reason says why. */
export const WINDOWS_PRIVATE_PATH_UNSAFE = "WINDOWS_PRIVATE_PATH_UNSAFE";
// The ACL program's reason codes, worded for the error message.
const WINDOWS_PRIVATE_REASONS = {
  UNSAFE_TYPE: "is a link, or not the expected file or folder",
  UNSAFE_OWNER: "is owned by another account",
  UNSAFE_PARENT_LINK: "is inside a linked folder",
  UNSAFE_PARENT_OWNER: "is inside a folder another account owns",
  UNSAFE_PARENT_ACCESS:
    "is inside a folder other accounts on this computer can rename or replace",
  INHERITED_ACCESS: "takes its permissions from its parent folder",
  SHARED_ACCESS: "is shared with other accounts",
  MISSING_OWNER_ACCESS: "does not give your account access",
  UNCHECKED: "could not be checked",
} as const;
export type WindowsPrivateReason = keyof typeof WINDOWS_PRIVATE_REASONS;
/** The code and reason of a windowsPrivatePath refusal. */
export interface WindowsPrivateRefusal {
  readonly code: typeof WINDOWS_PRIVATE_PATH_UNSAFE;
  readonly reason: WindowsPrivateReason;
}
/**
 * The code and reason of a refusal from windowsPrivatePath, from the error
 * itself or from a copy of the two passed between processes; undefined for
 * anything else.
 */
export function windowsPrivateRefusal(
  value: unknown,
): WindowsPrivateRefusal | undefined {
  const { code, reason } = (value ?? {}) as {
    code?: unknown;
    reason?: unknown;
  };
  return code === WINDOWS_PRIVATE_PATH_UNSAFE &&
    typeof reason === "string" &&
    Object.hasOwn(WINDOWS_PRIVATE_REASONS, reason)
    ? { code, reason: reason as WindowsPrivateReason }
    : undefined;
}
