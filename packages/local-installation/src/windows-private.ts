import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { runProcess } from "./process.js";

const WINDOWS_PRIVATE_CHECK_BODY = String.raw`  $item = Get-Item -LiteralPath $request.path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($item.PSIsContainer -ne ($request.kind -eq 'directory'))) { throw 'UNSAFE_TYPE' }
  $acl = Get-Acl -LiteralPath $item.FullName
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'UNSAFE_OWNER' }
  $parent = $item.Directory
  if ($item.PSIsContainer) { $parent = $item.Parent }
  while ($parent) {
    if ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'UNSAFE_PARENT_LINK' }
    $parentAcl = Get-Acl -LiteralPath $parent.FullName
    $owner = $parentAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($owner -notin @($sid.Value, $system, $admins, 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')) { throw 'UNSAFE_PARENT_OWNER' }
    foreach ($rule in $parentAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      # InheritOnly ACEs do not authorize mutation of this ancestor. They are
      # still checked below when present on the private target itself.
      if ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) { continue }
      if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($sid.Value, $system, $admins, 'S-1-3-0', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464') -and
          ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]'Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership')) { throw 'UNSAFE_PARENT_ACCESS' }
    }
    $parent = $parent.Parent
  }
  if ($request.repair) {
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
  if ($request.kind -eq 'directory' -and !$acl.AreAccessRulesProtected) { throw 'INHERITED_ACCESS' }
  $currentAllowed = $false
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow') {
      if ($rule.IdentityReference.Value -notin @($sid.Value, $system)) { throw 'SHARED_ACCESS' }
      if ($rule.IdentityReference.Value -eq $sid.Value) { $currentAllowed = $true }
    }
  }
  if (!$currentAllowed) { throw 'MISSING_OWNER_ACCESS' }`;

// The program is fixed. Only a path and operation travel over stdin; no file
// contents, user-controlled PowerShell, or credentials appear in argv/output.
export const WINDOWS_PRIVATE_SCRIPT = `
$ErrorActionPreference = 'Stop'
# This fixed Windows PowerShell script uses only its own built-in modules.
# A caller's PowerShell 7 modules can prevent Get-Acl from loading.
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $system = 'S-1-5-18'; $admins = 'S-1-5-32-544'
${WINDOWS_PRIVATE_CHECK_BODY}
  exit 0
} catch {
  # Only this program's own reason codes leave it; never a system message.
  $code = [string]$_.Exception.Message
  if ($code -cmatch '^[A-Z][A-Z_]+$') { [Console]::Out.Write($code) }
  exit 1
}
`;

const WORKER_OK = "__LINGER_ACL_OK__";
const WORKER_ERR = "__LINGER_ACL_ERR__:";

// Reuses one PowerShell process across sequential ACL checks instead of paying
// a full .NET CLR startup (~1s) for every private directory and file.
export const WINDOWS_PRIVATE_WORKER_SCRIPT = `
$ErrorActionPreference = 'Stop'
# This fixed Windows PowerShell script uses only its own built-in modules.
# A caller's PowerShell 7 modules can prevent Get-Acl from loading.
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = 'S-1-5-18'; $admins = 'S-1-5-32-544'
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Length -eq 0) { continue }
  try {
    $request = $line | ConvertFrom-Json
${WINDOWS_PRIVATE_CHECK_BODY}
    [Console]::Out.WriteLine('${WORKER_OK}')
  } catch {
    $code = [string]$_.Exception.Message
    if ($code -cmatch '^[A-Z][A-Z_]+$') { [Console]::Out.WriteLine('${WORKER_ERR}' + $code) }
    else { [Console]::Out.WriteLine('${WORKER_ERR}UNCHECKED') }
  }
  [Console]::Out.Flush()
}
`;

const REQUEST_TIMEOUT_MS = 30_000;
const WORKER_IDLE_MS = 5_000;

interface WorkerResponse {
  code: number;
  stdout: string;
}

interface Refable {
  ref?(): unknown;
  unref?(): unknown;
}

interface WorkerProcess extends Refable {
  stdin: NodeJS.WritableStream & Refable & { end(): void };
  stdout: NodeJS.ReadableStream & Refable;
  kill(): void;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: () => void): unknown;
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

function spawnDefaultWorker(): WorkerProcess {
  return spawn(
    powershellPath(),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(WINDOWS_PRIVATE_WORKER_SCRIPT, "utf16le").toString("base64"),
    ],
    {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    },
  );
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
    psModulePath: string | undefined;
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

  const reset = (kill: boolean) => {
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
    pending?.({ code: 1, stdout: "" });
  };

  const scheduleIdle = () => {
    clearIdle();
    if (!active || inFlight > 0) return;
    setWorkerRef(active.child, false);
    idleTimer = setTimeout(() => reset(false), idleMs);
    idleTimer.unref();
  };

  const ensureWorker = () => {
    const psModulePath = process.env.PSModulePath;
    if (active && active.psModulePath === psModulePath) {
      setWorkerRef(active.child, true);
      return active;
    }
    if (active) reset(false);
    const child = spawnWorker();
    child.stdin.on("error", () => {
      if (active?.child === child) reset(true);
    });
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
      psModulePath,
    };
    lines.on("line", (raw) => {
      const line = raw.trim().replace(/^\ufeff/, "");
      const pending = instance.pending;
      if (!pending) {
        if (active === instance) reset(true);
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
      if (active === instance) reset(true);
      pending({ code: 1, stdout: "" });
    });
    child.on("close", () => {
      if (active === instance) reset(false);
    });
    child.on("error", () => {
      if (active === instance) reset(true);
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
            if (active === instance) reset(true);
            finish({ code: 1, stdout: "" });
          }, timeoutMs);
          timer.unref();
          instance.pending = finish;
          try {
            instance.child.stdin.write(`${payload}\n`);
          } catch {
            if (active === instance) reset(true);
            finish({ code: 1, stdout: "" });
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

function privatePathError(file: string, stdout: string): Error {
  const reason: WindowsPrivateReason = Object.hasOwn(
    WINDOWS_PRIVATE_REASONS,
    stdout.trim(),
  )
    ? (stdout.trim() as WindowsPrivateReason)
    : "UNCHECKED";
  const target = path.resolve(file);
  return Object.assign(
    new Error(
      `Windows private path validation failed: ${target} ${WINDOWS_PRIVATE_REASONS[reason]}. Use a current-user owned local directory without links or shared access.`,
    ),
    { code: WINDOWS_PRIVATE_PATH_UNSAFE, reason, path: target },
  );
}

export async function windowsPrivatePath(
  file: string,
  kind: "file" | "directory",
  repair = false,
  run?: typeof runProcess,
): Promise<void> {
  const payload = JSON.stringify({ path: path.resolve(file), kind, repair });
  const result = run
    ? await run(
        powershellPath(),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(WINDOWS_PRIVATE_SCRIPT, "utf16le").toString("base64"),
        ],
        {
          input: payload,
          timeoutMs: REQUEST_TIMEOUT_MS,
        },
      )
    : await defaultWorker.execute(payload);
  if (result.code !== 0) throw privatePathError(file, result.stdout);
}
/** The code of an error from windowsPrivatePath; its reason says why. */
export const WINDOWS_PRIVATE_PATH_UNSAFE = "WINDOWS_PRIVATE_PATH_UNSAFE";
// The ACL program's reason codes, worded for the error message.
const WINDOWS_PRIVATE_REASONS = {
  UNSAFE_TYPE: "is a link, or not the expected file or folder",
  UNSAFE_OWNER:
    "is owned by another account, such as Administrators after Linger ran as administrator",
  UNSAFE_PARENT_LINK: "is inside a linked folder",
  UNSAFE_PARENT_OWNER: "is inside a folder another account owns",
  UNSAFE_PARENT_ACCESS: "is inside a folder other accounts may change",
  INHERITED_ACCESS: "takes its permissions from its parent folder",
  SHARED_ACCESS: "is shared with other accounts",
  MISSING_OWNER_ACCESS: "does not give your account access",
  UNCHECKED: "could not be checked",
} as const;
export type WindowsPrivateReason = keyof typeof WINDOWS_PRIVATE_REASONS;
