#requires -Version 5.1
<#
.SYNOPSIS
Guided Linger and local model installer for Windows 10/11 (x64).
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$env:PYTHONUTF8 = '1'
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch {
}
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
}

if (-not ('LingerProcessRunner' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using System.Threading;

public sealed class LingerProcessResult {
    public int ExitCode;
    public string StdOut;
    public string StdErr;
}

public sealed class LingerStreamChunk {
    public bool IsErr;
    public string Line;
}

public static class LingerProcessRunner {
    public static LingerProcessResult Run(
        string fileName,
        string arguments,
        string workingDirectory,
        Dictionary<string, string> envOverrides,
        string stdInText
    ) {
        return RunWithPump(fileName, arguments, workingDirectory, envOverrides, stdInText, null);
    }

    public static LingerProcessResult RunWithPump(
        string fileName,
        string arguments,
        string workingDirectory,
        Dictionary<string, string> envOverrides,
        string stdInText,
        Action<LingerStreamChunk[]> onBatch
    ) {
        var psi = new ProcessStartInfo();
        psi.FileName = fileName;
        psi.Arguments = arguments ?? "";
        if (!string.IsNullOrEmpty(workingDirectory)) {
            psi.WorkingDirectory = workingDirectory;
        }
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.RedirectStandardInput = stdInText != null;
        psi.StandardOutputEncoding = Encoding.UTF8;
        psi.StandardErrorEncoding = Encoding.UTF8;

        if (envOverrides != null) {
            foreach (var kv in envOverrides) {
                if (kv.Value == null) {
                    psi.EnvironmentVariables.Remove(kv.Key);
                } else {
                    psi.EnvironmentVariables[kv.Key] = kv.Value;
                }
            }
        }

        using (var proc = Process.Start(psi)) {
            if (stdInText != null) {
                using (var sw = new System.IO.StreamWriter(proc.StandardInput.BaseStream, new UTF8Encoding(false))) {
                    sw.Write(stdInText);
                }
            }

            var outLines = new List<string>();
            var errLines = new List<string>();
            var liveQueue = new Queue();

            var outThread = new Thread(() => {
                string line;
                while ((line = proc.StandardOutput.ReadLine()) != null) {
                    lock (outLines) { outLines.Add(line); }
                    if (onBatch != null) {
                        lock (liveQueue) {
                            liveQueue.Enqueue(new LingerStreamChunk { IsErr = false, Line = line });
                        }
                    }
                }
            });

            var errThread = new Thread(() => {
                string line;
                while ((line = proc.StandardError.ReadLine()) != null) {
                    lock (errLines) { errLines.Add(line); }
                    if (onBatch != null) {
                        lock (liveQueue) {
                            liveQueue.Enqueue(new LingerStreamChunk { IsErr = true, Line = line });
                        }
                    }
                }
            });

            outThread.IsBackground = true;
            errThread.IsBackground = true;
            outThread.Start();
            errThread.Start();

            if (onBatch != null) {
                while (!proc.WaitForExit(25)) {
                    FlushQueue(liveQueue, onBatch);
                }
                outThread.Join();
                errThread.Join();
                FlushQueue(liveQueue, onBatch);
            } else {
                proc.WaitForExit();
                outThread.Join();
                errThread.Join();
            }

            var res = new LingerProcessResult();
            res.ExitCode = proc.ExitCode;
            res.StdOut = string.Join("\n", outLines.ToArray());
            res.StdErr = string.Join("\n", errLines.ToArray());
            return res;
        }
    }

    private static void FlushQueue(Queue liveQueue, Action<LingerStreamChunk[]> onBatch) {
        LingerStreamChunk[] batch = null;
        lock (liveQueue) {
            if (liveQueue.Count > 0) {
                batch = new LingerStreamChunk[liveQueue.Count];
                for (int i = 0; i < batch.Length; i++) {
                    batch[i] = (LingerStreamChunk)liveQueue.Dequeue();
                }
            }
        }
        if (batch != null && batch.Length > 0) {
            onBatch(batch);
        }
    }
}
'@
}

$script:CliArgs = @($args)
$script:ScriptPath = $MyInvocation.MyCommand.Path
$script:ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $script:ScriptPath }
$script:PowerShellExe = (Get-Process -Id $PID).Path
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$script:TempDirsToClean = New-Object System.Collections.Generic.List[string]
# >>> stack release pin
$script:StackPinNpmVersion = '0.1.0-dev.57'
$script:StackPinSha256 = '20cfeb6885e07698f46a71252b7f69e88ab104f72ac55b02e4e1a15db14bfe23'
# <<< stack release pin
$script:StackScriptPath = ''
$script:KitHome = ''
$script:KitHomeResolved = $false

function Detect-RepoLayout {
    $leaf = Split-Path -Leaf $script:ScriptDir
    $parentDir = Split-Path -Parent $script:ScriptDir
    $parentLeaf = if ($parentDir) { Split-Path -Leaf $parentDir } else { '' }
    if ($leaf -eq 'install' -and $parentLeaf -eq 'scripts') {
        $candidate = Split-Path -Parent $parentDir
        $hasCompose = Test-Path -LiteralPath (Join-Path $candidate 'docker-compose.yml')
        $hasStack = Test-Path -LiteralPath (Join-Path $candidate 'scripts\installs\stack.ps1')
        if ($hasCompose -or $hasStack) {
            $script:InRepo = $true
            $script:RepoRoot = $candidate
            $script:HasCompose = $hasCompose
            $script:DisplayCmd = '.\scripts\install\install.ps1'
            return
        }
    }
    $script:InRepo = $false
    $script:RepoRoot = ''
    $script:HasCompose = $false
    $script:DisplayCmd = '.\install.ps1'
}

Detect-RepoLayout

function Write-OutLine([string]$Text = '') {
    [Console]::Out.WriteLine($Text)
}

function Write-ErrLine([string]$Text = '') {
    [Console]::Error.WriteLine($Text)
}

function Exit-Fail([string]$Message, [int]$Code = 1) {
    Write-ErrLine ("install.ps1: " + $Message)
    exit $Code
}

function Cleanup-TempDirs {
    foreach ($dir in $script:TempDirsToClean) {
        if ($dir -and (Test-Path -LiteralPath $dir)) {
            try {
                Get-ChildItem -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object {
                    try {
                        $_.Attributes = $_.Attributes -band (-bnot [IO.FileAttributes]::ReadOnly)
                    } catch {
                    }
                }
                Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
            } catch {
            }
        }
    }
}

function Quote-Arg([string]$Arg) {
    if ($null -eq $Arg) { return '""' }
    if ($Arg.Length -eq 0) { return '""' }
    if ($Arg -notmatch '[\s"\\]') { return $Arg }
    $sb = New-Object System.Text.StringBuilder
    $null = $sb.Append('"')
    $backslashes = 0
    for ($i = 0; $i -lt $Arg.Length; $i++) {
        $ch = $Arg[$i]
        if ($ch -eq '\') {
            $backslashes++
        } elseif ($ch -eq '"') {
            $null = $sb.Append('\', $backslashes * 2 + 1)
            $null = $sb.Append('"')
            $backslashes = 0
        } else {
            if ($backslashes -gt 0) {
                $null = $sb.Append('\', $backslashes)
                $backslashes = 0
            }
            $null = $sb.Append($ch)
        }
    }
    if ($backslashes -gt 0) {
        $null = $sb.Append('\', $backslashes * 2)
    }
    $null = $sb.Append('"')
    return $sb.ToString()
}

function Join-CommandArgs([string[]]$Arguments) {
    if (-not $Arguments -or $Arguments.Count -eq 0) { return '' }
    $parts = New-Object System.Collections.Generic.List[string]
    foreach ($a in $Arguments) {
        $null = $parts.Add((Quote-Arg $a))
    }
    return ($parts -join ' ')
}

function ConvertTo-EnvDict([hashtable]$Overrides) {
    $dict = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
    if ($Overrides) {
        foreach ($k in $Overrides.Keys) {
            $dict[[string]$k] = if ($null -eq $Overrides[$k]) { $null } else { [string]$Overrides[$k] }
        }
    }
    return $dict
}

function Read-PromptLine([string]$PromptText) {
    [Console]::Out.Write($PromptText)
    [Console]::Out.Flush()
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) {
        return $null
    }
    return $line.Trim()
}

function Read-YesNoPrompt([string]$PromptText, [bool]$DefaultYes, [bool]$AssumeYes) {
    if ($AssumeYes) {
        Write-OutLine ($PromptText + 'y')
        return $true
    }
    while ($true) {
        $ans = Read-PromptLine $PromptText
        if ($null -eq $ans -or $ans -eq '') {
            return $DefaultYes
        }
        $lower = $ans.ToLowerInvariant()
        if ($lower -eq 'y' -or $lower -eq 'yes') { return $true }
        if ($lower -eq 'n' -or $lower -eq 'no') { return $false }
        Write-OutLine "  Please answer y or n."
    }
}

function Read-PasswordPrompt([string]$PromptText) {
    if ([Console]::IsInputRedirected) {
        return (Read-PromptLine $PromptText)
    }
    try {
        [Console]::Out.Write($PromptText)
        [Console]::Out.Flush()
        $sec = Read-Host -AsSecureString
        if ($null -eq $sec) { return '' }
        $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
        try {
            return [Runtime.InteropServices.Marshal]::PtrToStringAuto($ptr)
        } finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
        }
    } catch {
        return (Read-PromptLine $PromptText)
    }
}

function Show-Usage {
    $cmd = $script:DisplayCmd
    $lines = @(
        "Usage: $cmd [OPTIONS]"
        ""
        "Guided setup for Linger and a local model runtime on Windows."
        ""
        "Options:"
        "  --web-url <url>     Linger server URL (default: http://localhost:3000)"
        "  --update            Replan and update an already configured local model setup"
        "  --connect           Connect this computer to Linger without changing models"
        "  --up                Start already configured local models"
        "  --status            Show local model and computer connection status"
        "  --remove            Stop and remove local model services (keeps downloads)"
        "  --purge             With --remove, also delete downloaded model files"
        "  -y, --yes           Accept confirmation prompts automatically"
        "  -h, --help          Show this help message and exit"
        ""
        "Day-2 examples:"
        "  $cmd --status"
        "  $cmd --up"
        "  $cmd --connect --web-url http://localhost:3000"
        "  $cmd --remove --purge"
    )
    Write-OutLine ($lines -join "`n")
}

function Normalize-Origin([string]$Raw) {
    if ([string]::IsNullOrWhiteSpace($Raw)) { return $null }
    $trimmed = $Raw.Trim().TrimEnd('/')
    if ($trimmed -notmatch '^https?://[^/\s?#]+$') {
        return $null
    }
    $uri = $null
    if (-not [Uri]::TryCreate($trimmed, [UriKind]::Absolute, [ref]$uri)) {
        return $null
    }
    if ($uri.Scheme -ne 'http' -and $uri.Scheme -ne 'https') {
        return $null
    }
    if ([string]::IsNullOrWhiteSpace($uri.Host)) {
        return $null
    }
    if ($uri.IsDefaultPort) {
        return ($uri.Scheme + '://' + $uri.Host).ToLowerInvariant()
    }
    return ($uri.Scheme + '://' + $uri.Host + ':' + $uri.Port).ToLowerInvariant()
}

function Get-ComputerEnvironmentName([string]$Origin) {
    $uri = [Uri]$Origin
    $hostName = $uri.Host.ToLowerInvariant()
    $name = ''
    if ($hostName -eq 'localhost' -or $hostName -eq '127.0.0.1' -or $hostName -eq '[::1]' -or $hostName -eq '::1' -or $hostName.EndsWith('.localhost')) {
        $name = 'local'
    } elseif ($hostName.StartsWith('[')) {
        $inner = $hostName.Substring(1, $hostName.Length - 2)
        $name = 'ip-' + ($inner -replace '[:.]', '-')
    } elseif ($hostName.Contains(':')) {
        $name = 'ip-' + ($hostName -replace '[:.]', '-')
    } elseif ($hostName -match '^[0-9.]+$') {
        $name = 'ip-' + ($hostName.Replace('.', '-'))
    } else {
        $firstLabel = $hostName.Split('.')[0]
        if ($firstLabel -cne 'linger') {
            $firstLabel = $firstLabel -replace '-linger$', ''
        }
        $name = $firstLabel
    }
    if (-not $uri.IsDefaultPort) {
        return "$name-$($uri.Port)"
    }
    return $name
}

function Get-UserHome {
    if ($env:USERPROFILE) { return $env:USERPROFILE }
    if ($env:HOME) { return $env:HOME }
    return [Environment]::GetFolderPath('UserProfile')
}

function Get-LocalAppDataRoot {
    if ($env:LOCALAPPDATA) { return $env:LOCALAPPDATA }
    return (Join-Path (Get-UserHome) 'AppData\Local')
}

function Test-IsElevated {
    $override = $env:LINGER_INSTALL_TEST_ELEVATED
    if ($override -eq '1') { return $true }
    if ($override -eq '0') { return $false }
    try {
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($id)
        return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch {
        return $false
    }
}

function Format-Size([double]$Bytes) {
    if ($Bytes -ge 1GB) {
        return ('{0:F1} GiB' -f ($Bytes / 1GB))
    }
    if ($Bytes -ge 1MB) {
        return ('{0:F1} MiB' -f ($Bytes / 1MB))
    }
    return ('{0:F0} B' -f $Bytes)
}

function Format-ContextWindow([long]$Window) {
    if ($Window -le 0) { return 'auto' }
    if ($Window -ge 1024) {
        return ('{0}K' -f [int][Math]::Floor($Window / 1024))
    }
    return "$Window"
}

function Format-SanitizedLine([string]$Line) {
    if ($null -eq $Line) { return '' }
    $cmd = $script:DisplayCmd
    $out = $Line
    $out = [regex]::Replace($out, '(?i)^stack\.ps1:\s*using npm mirror.*$', '  Preparing local model runtime package...')
    $out = [regex]::Replace($out, '(?i)^stack\.ps1:\s*downloading localmodels.*$', '  Downloading local model runtime package...')
    $out = [regex]::Replace($out, '(?i)python(?:3)?\s+-m\s+localmodels\s+stack\s+up', "$cmd --up")
    $out = [regex]::Replace($out, '(?i)stack\s+remove\s+--purge', "$cmd --remove --purge")
    $out = [regex]::Replace($out, '(?i)stack\s+remove', "$cmd --remove")
    $out = [regex]::Replace($out, '(?i)stack\s+up', "$cmd --up")
    $out = [regex]::Replace($out, '(?i)stack\s+plan\s+--update', "$cmd --update")
    $out = [regex]::Replace($out, '(?i)rerun\s+stack\s+plan', "rerun $cmd")
    $out = [regex]::Replace($out, '(?i),?\s*or\s+plan\s+another\s+--llm-port\b[^.\n]*', '')
    $out = [regex]::Replace($out, '(?i),?\s*or\s+stop\s+one\s+with\s+''stack\s+service[^'']*''', '')
    $out = [regex]::Replace($out, '(?i)\bstack\.(?:ps1|sh)\s+settings\b', 'installer settings')
    $out = [regex]::Replace($out, '(?i)\bstack\s+settings\b', 'installer settings')
    $out = [regex]::Replace($out, '(?i)\bstack\.(?:ps1|sh)\b', 'install.ps1')
    $out = [regex]::Replace($out, '(?m)^stack:\s*', 'install.ps1: ')
    $out = [regex]::Replace($out, '\bPI_CODING_AGENT_DIR\b', 'agent runtime configuration')
    $out = [regex]::Replace($out, '\bgateway-home\b', 'local model agent')
    $out = [regex]::Replace($out, '(?i)\blocalmodels\b', 'local model runtime')
    return $out
}

function Set-PrivateWindowsDirectoryAcl([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        $null = New-Item -ItemType Directory -Path $Path -Force
    }
    $item = Get-Item -LiteralPath $Path -Force
    $userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $systemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
    $inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    $prop = [Security.AccessControl.PropagationFlags]::None
    $allow = [Security.AccessControl.AccessControlType]::Allow
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    try {
        $acl.SetOwner($userSid)
        $acl.SetAccessRuleProtection($true, $false)
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($userSid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, $prop, $allow)))
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($systemSid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, $prop, $allow)))
        if ($PSVersionTable.PSEdition -eq 'Core') {
            [IO.FileSystemAclExtensions]::SetAccessControl($item, $acl)
        } else {
            $item.SetAccessControl($acl)
        }
    } catch {
        $acl2 = Get-Acl -LiteralPath $Path
        $acl2.SetAccessRuleProtection($true, $false)
        foreach ($existing in @($acl2.Access)) { $null = $acl2.RemoveAccessRule($existing) }
        $acl2.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($userSid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, $prop, $allow)))
        $acl2.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($systemSid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, $prop, $allow)))
        if ($PSVersionTable.PSEdition -eq 'Core') {
            [IO.FileSystemAclExtensions]::SetAccessControl($item, $acl2)
        } else {
            $item.SetAccessControl($acl2)
        }
    }
}

function Test-SafeAncestors([string]$Path) {
    try {
        $current = [IO.Path]::GetFullPath($Path).TrimEnd('\')
        $root = [IO.Path]::GetPathRoot($current).TrimEnd('\')
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        $userSidVal = $id.User.Value
        $allowedParentOwners = @($userSidVal, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
        $allowedParentAces = @($userSidVal, 'S-1-5-18', 'S-1-5-32-544', 'S-1-3-0', 'S-1-3-4', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
        $unsafeRights = [Security.AccessControl.FileSystemRights]'Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'

        $probe = Split-Path -Parent $current
        while ($probe -and $probe.TrimEnd('\') -ne $root) {
            $pTrim = $probe.TrimEnd('\')
            if (Test-Path -LiteralPath $pTrim) {
                if (([IO.File]::GetAttributes($pTrim) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
                $parentAcl = Get-Acl -LiteralPath $pTrim
                $pOwner = $parentAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value
                if ($allowedParentOwners -notcontains $pOwner) { return $false }
                foreach ($rule in $parentAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
                    if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
                    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
                        ($allowedParentAces -notcontains $rule.IdentityReference.Value) -and
                        (($rule.FileSystemRights -band $unsafeRights) -ne 0)) {
                        return $false
                    }
                }
            }
            $probe = Split-Path -Parent $pTrim
        }
        return $true
    } catch {
        return $false
    }
}

function Test-PrivateWindowsDirectory([string]$Path) {
    try {
        if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $false }
        $current = [IO.Path]::GetFullPath($Path).TrimEnd('\')
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        $userSidVal = $id.User.Value

        if (([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
        $leafSec = Get-Acl -LiteralPath $current
        if (-not $leafSec.AreAccessRulesProtected) { return $false }
        $leafOwner = $leafSec.GetOwner([Security.Principal.SecurityIdentifier]).Value
        if ($leafOwner -ne $userSidVal -and $leafOwner -ne 'S-1-5-18') { return $false }
        foreach ($rule in $leafSec.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
            if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
            $sid = $rule.IdentityReference.Value
            if ($sid -ne $userSidVal -and $sid -ne 'S-1-5-18') {
                return $false
            }
        }
        return (Test-SafeAncestors $current)
    } catch {
        return $false
    }
}

function Read-TarAsciiField([byte[]]$Buffer, [int]$Start, [int]$MaxLen) {
    $end = $Start
    $limit = [Math]::Min($Buffer.Length, ($Start + $MaxLen))
    while ($end -lt $limit -and $Buffer[$end] -ne 0) {
        $end++
    }
    if ($end -eq $Start) { return '' }
    return [Text.Encoding]::ASCII.GetString($Buffer, $Start, ($end - $Start))
}

function Extract-TarGzEntryBytes([string]$TgzPath, [string]$EntryPath) {
    $maxBytes = 16777216
    if ((Get-Item -LiteralPath $TgzPath).Length -gt $maxBytes) {
        return @{ ArchiveValid = $false; Found = $false; Bytes = $null }
    }
    $tarBytes = $null
    try {
        $fs = [IO.File]::OpenRead($TgzPath)
        try {
            $gz = New-Object IO.Compression.GZipStream($fs, [IO.Compression.CompressionMode]::Decompress)
            try {
                $ms = New-Object IO.MemoryStream
                try {
                    $buf = New-Object byte[] 65536
                    $total = 0
                    while ($true) {
                        $read = $gz.Read($buf, 0, $buf.Length)
                        if ($read -le 0) { break }
                        $total += $read
                        if ($total -gt $maxBytes) {
                            return @{ ArchiveValid = $false; Found = $false; Bytes = $null }
                        }
                        $ms.Write($buf, 0, $read)
                    }
                    $tarBytes = $ms.ToArray()
                } finally {
                    $ms.Dispose()
                }
            } finally {
                $gz.Dispose()
            }
        } finally {
            $fs.Dispose()
        }
    } catch {
        return @{ ArchiveValid = $false; Found = $false; Bytes = $null }
    }

    $offset = 0
    while (($offset + 512) -le $tarBytes.Length) {
        $allZero = $true
        for ($i = 0; $i -lt 512; $i++) {
            if ($tarBytes[$offset + $i] -ne 0) {
                $allZero = $false
                break
            }
        }
        if ($allZero) { break }

        $rawName = Read-TarAsciiField $tarBytes $offset 100
        $magic = Read-TarAsciiField $tarBytes ($offset + 257) 5
        $prefix = if ($magic -eq 'ustar') { Read-TarAsciiField $tarBytes ($offset + 345) 155 } else { '' }
        $fullName = if ($prefix) { "$prefix/$rawName" } else { $rawName }
        $normalized = ($fullName -replace '^\./', '').Replace('\', '/')
        $sizeRaw = (Read-TarAsciiField $tarBytes ($offset + 124) 12).Trim()
        $entrySize = 0
        if ($sizeRaw) {
            try {
                $entrySize = [Convert]::ToInt32($sizeRaw, 8)
            } catch {
                return @{ ArchiveValid = $false; Found = $false; Bytes = $null }
            }
        }
        $typeByte = $tarBytes[$offset + 156]
        $dataStart = $offset + 512
        if ($entrySize -lt 0 -or ($dataStart + $entrySize) -gt $tarBytes.Length) {
            return @{ ArchiveValid = $false; Found = $false; Bytes = $null }
        }
        if (($typeByte -eq 0 -or $typeByte -eq 48) -and $normalized -eq $EntryPath) {
            $entryBytes = New-Object byte[] $entrySize
            if ($entrySize -gt 0) {
                [Buffer]::BlockCopy($tarBytes, $dataStart, $entryBytes, 0, $entrySize)
            }
            return @{ ArchiveValid = $true; Found = $true; Bytes = $entryBytes }
        }
        $padded = [int]([Math]::Ceiling($entrySize / 512.0) * 512)
        $offset = $dataStart + $padded
    }
    return @{ ArchiveValid = $true; Found = $false; Bytes = $null }
}

function Get-BytesSha256Hex([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $digest = $sha.ComputeHash($Bytes)
        return ([BitConverter]::ToString($digest) -replace '-', '').ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

function Download-PinnedStackScript([string]$DestinationPath, [string]$TempDir) {
    if (-not $script:StackPinNpmVersion -or -not $script:StackPinSha256) {
        Exit-Fail 'Local model runtime release pin is missing.'
    }

    $registries = @()
    $override = $env:SIMPLEX_NPM_REGISTRY
    if ($override) {
        $trimmed = $override.TrimEnd('/')
        if ($trimmed -notmatch '^https://[^/\s]+' -and $trimmed -notmatch '^http://(127\.0\.0\.1|localhost)(:\d+)?(/.*)?$') {
            Exit-Fail 'SIMPLEX_NPM_REGISTRY must use https or loopback http.'
        }
        $registries = @($trimmed)
    } else {
        $region = if ($env:SIMPLEX_REGION) { $env:SIMPLEX_REGION } else { 'auto' }
        if ($region -notin @('auto', 'global', 'cn')) {
            Exit-Fail 'SIMPLEX_REGION must be auto, global, or cn.'
        }
        if ($region -eq 'cn') {
            $registries = @('https://registry.npmmirror.com', 'https://registry.npmjs.org')
        } else {
            $registries = @('https://registry.npmjs.org', 'https://registry.npmmirror.com')
        }
    }

    $tgzPath = Join-Path $TempDir 'localmodels-launcher.tgz'
    $lastError = 'download failed'
    foreach ($base in $registries) {
        $tarUrl = "$base/@simplexai/localmodels/-/localmodels-$($script:StackPinNpmVersion).tgz"
        if (Test-Path -LiteralPath $tgzPath) {
            Remove-Item -LiteralPath $tgzPath -Force -ErrorAction SilentlyContinue
        }
        try {
            Invoke-WebRequest -UseBasicParsing -MaximumRedirection 5 -Uri $tarUrl -OutFile $tgzPath -TimeoutSec 60
        } catch {
            $lastError = $_.Exception.Message
            continue
        }

        $extracted = Extract-TarGzEntryBytes $tgzPath 'package/stack.ps1'
        if (-not $extracted.ArchiveValid) {
            $lastError = 'downloaded archive is invalid'
            continue
        }
        if (-not $extracted.Found) {
            Exit-Fail 'Downloaded runtime bootstrap archive is missing stack.ps1.'
        }
        $actualSha = Get-BytesSha256Hex ([byte[]]$extracted.Bytes)
        if ($actualSha -ne $script:StackPinSha256) {
            if (Test-Path -LiteralPath $DestinationPath) {
                Remove-Item -LiteralPath $DestinationPath -Force -ErrorAction SilentlyContinue
            }
            Exit-Fail 'Local model runtime bootstrap checksum mismatch.'
        }
        [IO.File]::WriteAllBytes($DestinationPath, [byte[]]$extracted.Bytes)
        return
    }
    Exit-Fail "Could not download the local model runtime helper: $lastError"
}

function Resolve-StackScript {
    if ($env:LINGER_STACK_SCRIPT) {
        if (-not (Test-Path -LiteralPath $env:LINGER_STACK_SCRIPT -PathType Leaf)) {
            Exit-Fail "Configured local model runtime script was not found: $($env:LINGER_STACK_SCRIPT)"
        }
        $script:StackScriptPath = $env:LINGER_STACK_SCRIPT
        return
    }
    if ($script:InRepo -and $script:RepoRoot) {
        $repoStack = Join-Path $script:RepoRoot 'scripts\installs\stack.ps1'
        if (Test-Path -LiteralPath $repoStack -PathType Leaf) {
            $script:StackScriptPath = $repoStack
            return
        }
    }
    $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("linger-stack-" + [Guid]::NewGuid().ToString('N'))
    Set-PrivateWindowsDirectoryAcl $tempRoot
    $script:TempDirsToClean.Add($tempRoot)
    $dest = Join-Path $tempRoot 'stack.ps1'
    if ($env:LINGER_STACK_URL) {
        try {
            Invoke-WebRequest -UseBasicParsing -Uri $env:LINGER_STACK_URL -OutFile $dest -TimeoutSec 30
        } catch {
            Exit-Fail "Could not download the local model runtime helper: $($_.Exception.Message)"
        }
    } else {
        Download-PinnedStackScript $dest $tempRoot
    }
    $script:StackScriptPath = $dest
}

function Invoke-StackBootstrapProbe([string]$CandidateKitHome) {
    $envOverrides = @{ 'LOCALMODELS_KIT_HOME' = $CandidateKitHome }
    $cmdArgs = Join-CommandArgs @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script:StackScriptPath, '--bootstrap-json')
    return [LingerProcessRunner]::Run($script:PowerShellExe, $cmdArgs, '', (ConvertTo-EnvDict $envOverrides), $null)
}

function Ensure-KitHome {
    if ($script:KitHomeResolved) { return }

    $chosenKit = ''
    if ($env:LOCALMODELS_KIT_HOME) {
        $chosenKit = $env:LOCALMODELS_KIT_HOME
    } else {
        $localApp = Get-LocalAppDataRoot
        $userHome = Get-UserHome
        $tempKitDir = Join-Path ([IO.Path]::GetTempPath()) ("linger-kit." + [Guid]::NewGuid().ToString('N'))

        $candidates = @(
            (Join-Path $localApp 'simplex-localmodels\kits'),
            (Join-Path $userHome '.linger\localmodels\kits'),
            $tempKitDir
        )

        foreach ($candidate in $candidates) {
            if ($candidate -eq $tempKitDir) {
                $script:TempDirsToClean.Add($tempKitDir)
            }
            if (-not (Test-SafeAncestors $candidate)) {
                continue
            }
            try {
                $parentDir = Split-Path -Parent $candidate
                $grandParent = if ($parentDir) { Split-Path -Parent $parentDir } else { '' }
                if ($candidate -like '*\.linger\localmodels\kits') {
                    Set-PrivateWindowsDirectoryAcl $grandParent
                    Set-PrivateWindowsDirectoryAcl $parentDir
                    Set-PrivateWindowsDirectoryAcl $candidate
                } elseif ($candidate -like '*\simplex-localmodels\kits') {
                    Set-PrivateWindowsDirectoryAcl $parentDir
                    Set-PrivateWindowsDirectoryAcl $candidate
                } else {
                    Set-PrivateWindowsDirectoryAcl $candidate
                }
            } catch {
                continue
            }

            if (Test-PrivateWindowsDirectory $candidate) {
                $chosenKit = $candidate
                break
            }
        }
    }

    if (-not $chosenKit) {
        Exit-Fail 'Could not initialize a private directory for the local model runtime.'
    }

    $probe = Invoke-StackBootstrapProbe $chosenKit
    if ($probe.ExitCode -ne 0) {
        $msg = @($probe.StdErr, $probe.StdOut) -join "`n"
        $sanitized = ($msg.Split("`n") | ForEach-Object { Format-SanitizedLine $_ } | Where-Object { $_ -ne '' }) -join "`n"
        if (-not $sanitized) { $sanitized = 'Could not initialize the local model runtime.' }
        Write-ErrLine $sanitized
        exit 1
    }
    $script:KitHome = $chosenKit
    $script:KitHomeResolved = $true
}

$script:SanitizedBatchPrinter = [Action[LingerStreamChunk[]]]{
    param($batch)
    foreach ($chunk in $batch) {
        $san = Format-SanitizedLine $chunk.Line
        if ($chunk.IsErr) {
            Write-ErrLine $san
        } else {
            Write-OutLine $san
        }
    }
}

$script:RawBatchPrinter = [Action[LingerStreamChunk[]]]{
    param($batch)
    foreach ($chunk in $batch) {
        if ($chunk.IsErr) {
            Write-ErrLine $chunk.Line
        } else {
            Write-OutLine $chunk.Line
        }
    }
}

function Get-StackInvokePath {
    $currentPath = [string]$env:PATH
    if ($env:DOCKER_HOST -or -not $currentPath) {
        return $currentPath
    }
    $pipes = @()
    try {
        $pipes = [IO.Directory]::GetFiles('\\.\pipe\', '*docker*')
    } catch {
        $pipes = @()
    }
    if (@($pipes).Count -gt 0) {
        return $currentPath
    }
    $kept = New-Object System.Collections.Generic.List[string]
    foreach ($entry in $currentPath.Split(';')) {
        $trimmed = $entry.Trim()
        if (-not $trimmed) { continue }
        $candidate = $trimmed.Trim('"')
        $hasDockerExe = $false
        try {
            if ($candidate) {
                $hasDockerExe = Test-Path -LiteralPath (Join-Path $candidate 'docker.exe') -PathType Leaf
            }
        } catch {
            $hasDockerExe = $false
        }
        if (-not $hasDockerExe) {
            $null = $kept.Add($trimmed)
        }
    }
    return ($kept.ToArray() -join ';')
}

function Invoke-Stack([string[]]$StackArgs, [bool]$StreamOutput = $false) {
    Ensure-KitHome
    $allArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script:StackScriptPath) + $StackArgs
    $cmdLine = Join-CommandArgs $allArgs
    $envDict = ConvertTo-EnvDict @{
        'LOCALMODELS_KIT_HOME' = $script:KitHome
        'PATH' = (Get-StackInvokePath)
    }
    $onBatch = if ($StreamOutput) { $script:SanitizedBatchPrinter } else { $null }
    return [LingerProcessRunner]::RunWithPump($script:PowerShellExe, $cmdLine, '', $envDict, $null, $onBatch)
}

function Invoke-HttpGetText([string]$Url, [int]$TimeoutSec = 5) {
    $res = New-Object PSObject -Property @{
        Ok = $false
        StatusCode = 0
        Content = ''
    }
    try {
        $resp = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSec
        $res.StatusCode = [int]$resp.StatusCode
        $res.Content = [string]$resp.Content
        $res.Ok = ($res.StatusCode -ge 200 -and $res.StatusCode -lt 300)
    } catch {
        $res.Ok = $false
    }
    return $res
}

function Test-LingerServer([string]$Origin) {
    if (-not $Origin) { return $false }
    $url = "$Origin/install/linger-computer.ps1"
    $r = Invoke-HttpGetText $url 5
    if (-not $r.Ok) { return $false }
    return ($r.Content -match 'LingerInstallerEmbedded' -or $r.Content -match 'linger-computer-launcher-v2')
}

function Read-DotEnvFile([string]$Path) {
    $map = @{}
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $map }
    $lines = [IO.File]::ReadAllLines($Path, $script:Utf8NoBom)
    foreach ($raw in $lines) {
        if ($raw -match '^\s*#' -or $raw -match '^\s*$') { continue }
        $idx = $raw.IndexOf('=')
        if ($idx -gt 0) {
            $k = $raw.Substring(0, $idx).Trim()
            $v = $raw.Substring($idx + 1).Trim()
            if (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'"))) {
                if ($v.Length -ge 2) { $v = $v.Substring(1, $v.Length - 2) }
            }
            $map[$k] = $v
        }
    }
    return $map
}

function Set-DotEnvKey([string]$Path, [string]$Key, [string]$Value) {
    $lines = New-Object System.Collections.Generic.List[string]
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        foreach ($l in [IO.File]::ReadAllLines($Path, $script:Utf8NoBom)) {
            $null = $lines.Add($l)
        }
    }
    $found = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match ("^\s*#?\s*" + [regex]::Escape($Key) + "=")) {
            if (-not $found) {
                $lines[$i] = "$Key=$Value"
                $found = $true
            }
        }
    }
    if (-not $found) {
        $null = $lines.Add("$Key=$Value")
    }
    $text = ($lines.ToArray() -join "`n") + "`n"
    [IO.File]::WriteAllText($Path, $text, $script:Utf8NoBom)
}

function Get-HostListeningPorts {
    $ports = New-Object 'System.Collections.Generic.HashSet[int]'
    if ($null -ne $env:LINGER_INSTALL_BUSY_PORTS) {
        foreach ($tok in $env:LINGER_INSTALL_BUSY_PORTS.Split(',')) {
            $trimmed = $tok.Trim()
            $p = 0
            if ($trimmed -and [int]::TryParse($trimmed, [ref]$p)) {
                $null = $ports.Add($p)
            }
        }
        return , $ports
    }
    try {
        $props = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties()
        foreach ($ep in $props.GetActiveTcpListeners()) {
            $null = $ports.Add($ep.Port)
        }
        foreach ($ep in $props.GetActiveUdpListeners()) {
            $null = $ports.Add($ep.Port)
        }
    } catch {
    }
    return , $ports
}

function Invoke-ExternalCommand(
    [string]$CommandName,
    [string[]]$Arguments,
    [string]$WorkingDirectory = '',
    [hashtable]$EnvOverrides = $null,
    [string]$StdInText = $null,
    [bool]$StreamOutput = $false,
    [bool]$SanitizeStream = $false
) {
    $resolvedPath = ''
    if (Test-Path -LiteralPath $CommandName -PathType Leaf) {
        $resolvedPath = $CommandName
    } else {
        $cmdObj = Get-Command $CommandName -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($cmdObj -and $cmdObj.Source) {
            $resolvedPath = $cmdObj.Source
        }
    }
    if (-not $resolvedPath) {
        $missing = New-Object LingerProcessResult
        $missing.ExitCode = 127
        $missing.StdOut = ''
        $missing.StdErr = "Command not found: $CommandName"
        return $missing
    }
    $onBatch = $null
    if ($StreamOutput) {
        $onBatch = if ($SanitizeStream) { $script:SanitizedBatchPrinter } else { $script:RawBatchPrinter }
    }
    $envDict = ConvertTo-EnvDict $EnvOverrides
    if ($resolvedPath -imatch '\.(cmd|bat)$') {
        $inner = Join-CommandArgs (@($resolvedPath) + $Arguments)
        $cmdArgs = '/d /s /c "' + $inner + '"'
        return [LingerProcessRunner]::RunWithPump('cmd.exe', $cmdArgs, $WorkingDirectory, $envDict, $StdInText, $onBatch)
    }
    $argStr = Join-CommandArgs $Arguments
    return [LingerProcessRunner]::RunWithPump($resolvedPath, $argStr, $WorkingDirectory, $envDict, $StdInText, $onBatch)
}

function Get-OwnComposePorts {
    $ports = New-Object 'System.Collections.Generic.HashSet[int]'
    $psRes = Invoke-ExternalCommand 'docker' @('compose', 'ps') $script:RepoRoot
    if ($psRes.ExitCode -eq 0 -and $psRes.StdOut) {
        $matches = [regex]::Matches($psRes.StdOut, ':(\d+)->\d+/')
        foreach ($m in $matches) {
            $p = 0
            if ([int]::TryParse($m.Groups[1].Value, [ref]$p)) {
                $null = $ports.Add($p)
            }
        }
    }
    return , $ports
}

function Find-FreePort([int]$StartPort, $BusySet, $ReservedSet) {
    $candidate = $StartPort
    while ($BusySet.Contains($candidate) -or $ReservedSet.Contains($candidate)) {
        $candidate++
    }
    $null = $ReservedSet.Add($candidate)
    return $candidate
}

function Parse-PortFromUrl([string]$Url, [int]$Fallback) {
    if (-not $Url) { return $Fallback }
    $uri = $null
    if ([Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$uri) -and $uri.Port -gt 0) {
        return $uri.Port
    }
    return $Fallback
}

function Parse-IntOrDefault([string]$Raw, [int]$Fallback) {
    $n = 0
    if ($Raw -and [int]::TryParse($Raw.Trim(), [ref]$n) -and $n -gt 0) {
        return $n
    }
    return $Fallback
}

function Ensure-ComposePorts([string]$EnvPath, [bool]$AssumeYes) {
    $envMap = Read-DotEnvFile $EnvPath

    $webPort = Parse-IntOrDefault $envMap['WEB_HTTP_PORT'] (Parse-PortFromUrl $envMap['WEB_PUBLIC_ORIGIN'] 3000)
    $pgPort = Parse-IntOrDefault $envMap['POSTGRES_PORT'] 5432
    $thPort = Parse-IntOrDefault $envMap['TEAMHUB_HTTP_PORT'] 8080
    $nsPort = Parse-IntOrDefault $envMap['NODE_SERVICES_HTTP_PORT'] (Parse-PortFromUrl $envMap['AGENT_RUNNER_PUBLIC_GATEWAY_URL'] 4319)
    $drPort = Parse-IntOrDefault $envMap['DOCUMENT_RUNTIME_HTTP_PORT'] 4321
    $lkHttp = Parse-PortFromUrl $envMap['LIVEKIT_URL'] 17880
    $lkTcp = 7881
    $lkUdp = 7882

    $overrideRel = '.local/compose.ports.yml'
    $overridePath = Join-Path $script:RepoRoot '.local\compose.ports.yml'
    if (Test-Path -LiteralPath $overridePath -PathType Leaf) {
        $rawYml = [IO.File]::ReadAllText($overridePath, $script:Utf8NoBom)
        if ($rawYml -match '127\.0\.0\.1:(\d+):7880') { $lkHttp = [int]$Matches[1] }
        if ($rawYml -match '--rtc\.tcp_port\s+(\d+)') {
            $lkTcp = [int]$Matches[1]
        } elseif ($rawYml -match ':(\d+):7881') {
            $lkTcp = [int]$Matches[1]
        }
        if ($rawYml -match '--udp-port\s+(\d+)') {
            $lkUdp = [int]$Matches[1]
        } elseif ($rawYml -match ':(\d+):7882/udp') {
            $lkUdp = [int]$Matches[1]
        }
    }

    $listening = Get-HostListeningPorts
    $ownPorts = Get-OwnComposePorts
    $externalBusy = New-Object 'System.Collections.Generic.HashSet[int]'
    foreach ($p in $listening) {
        if (-not $ownPorts.Contains($p)) {
            $null = $externalBusy.Add($p)
        }
    }

    $specs = @(
        @{ Key = 'WEB'; Label = 'Web HTTP'; Current = $webPort },
        @{ Key = 'LK_HTTP'; Label = 'LiveKit HTTP'; Current = $lkHttp },
        @{ Key = 'LK_TCP'; Label = 'LiveKit RTC TCP'; Current = $lkTcp },
        @{ Key = 'LK_UDP'; Label = 'LiveKit RTC UDP'; Current = $lkUdp },
        @{ Key = 'PG'; Label = 'PostgreSQL'; Current = $pgPort },
        @{ Key = 'TH'; Label = 'TeamHub HTTP'; Current = $thPort },
        @{ Key = 'NS'; Label = 'Node Services HTTP'; Current = $nsPort },
        @{ Key = 'DR'; Label = 'Document Runtime HTTP'; Current = $drPort }
    )

    $colliding = New-Object System.Collections.Generic.List[object]
    $reserved = New-Object 'System.Collections.Generic.HashSet[int]'
    foreach ($s in $specs) {
        if ($externalBusy.Contains($s.Current)) {
            $null = $colliding.Add($s)
        } else {
            $null = $reserved.Add($s.Current)
        }
    }

    if ($colliding.Count -eq 0) {
        return
    }

    $busyList = ($colliding | ForEach-Object { $_.Current }) -join ', '
    Write-OutLine "  Port(s) already in use: $busyList"

    $newMap = @{
        WEB = $webPort
        LK_HTTP = $lkHttp
        LK_TCP = $lkTcp
        LK_UDP = $lkUdp
        PG = $pgPort
        TH = $thPort
        NS = $nsPort
        DR = $drPort
    }

    foreach ($s in $colliding) {
        $nextPort = Find-FreePort ($s.Current + 1) $externalBusy $reserved
        $newMap[$s.Key] = $nextPort
        Write-OutLine ("    {0} {1} -> {2}" -f $s.Label, $s.Current, $nextPort)
    }

    $newOrigin = "http://localhost:$($newMap['WEB'])"
    if (-not (Read-YesNoPrompt "  Port(s) $busyList are already in use. Reassign to free local ports automatically (Web -> $newOrigin)? [Y/n]: " $true $AssumeYes)) {
        Exit-Fail "Free those ports or update .env and run $($script:DisplayCmd) again."
    }

    $lkChanged = ($newMap['LK_HTTP'] -ne $lkHttp) -or ($newMap['LK_TCP'] -ne $lkTcp) -or ($newMap['LK_UDP'] -ne $lkUdp)
    if ($lkChanged) {
        $verRes = Invoke-ExternalCommand 'docker' @('compose', 'version', '--short') $script:RepoRoot
        $verText = if ($verRes.ExitCode -eq 0) { [string]$verRes.StdOut } else { '' }
        if ($verText -notmatch 'v?(\d+)\.(\d+)\.(\d+)') {
            $verRes2 = Invoke-ExternalCommand 'docker' @('compose', 'version') $script:RepoRoot
            $verText = if ($verRes2.ExitCode -eq 0) { [string]$verRes2.StdOut } else { '' }
        }
        $composeVerOk = $false
        if ($verText -match 'v?(\d+)\.(\d+)\.(\d+)') {
            $maj = [int]$Matches[1]; $min = [int]$Matches[2]; $pat = [int]$Matches[3]
            if ($maj -gt 2 -or ($maj -eq 2 -and ($min -gt 24 -or ($min -eq 24 -and $pat -ge 4)))) {
                $composeVerOk = $true
            }
        }
        if (-not $composeVerOk) {
            Exit-Fail "Automatic LiveKit port reassignment requires Docker Compose 2.24.4 or later. Update Docker Compose and run $($script:DisplayCmd) again."
        }
    }

    if ($newMap['WEB'] -ne $webPort) {
        Set-DotEnvKey $EnvPath 'WEB_HTTP_PORT' "$($newMap['WEB'])"
        Set-DotEnvKey $EnvPath 'WEB_PUBLIC_ORIGIN' $newOrigin
    }
    if ($newMap['PG'] -ne $pgPort) {
        Set-DotEnvKey $EnvPath 'POSTGRES_PORT' "$($newMap['PG'])"
    }
    if ($newMap['TH'] -ne $thPort) {
        Set-DotEnvKey $EnvPath 'TEAMHUB_HTTP_PORT' "$($newMap['TH'])"
    }
    if ($newMap['NS'] -ne $nsPort) {
        Set-DotEnvKey $EnvPath 'NODE_SERVICES_HTTP_PORT' "$($newMap['NS'])"
        Set-DotEnvKey $EnvPath 'AGENT_RUNNER_PUBLIC_GATEWAY_URL' "ws://127.0.0.1:$($newMap['NS'])/v1/runner-gateway"
    }
    if ($newMap['DR'] -ne $drPort) {
        Set-DotEnvKey $EnvPath 'DOCUMENT_RUNTIME_HTTP_PORT' "$($newMap['DR'])"
    }

    if ($lkChanged) {
        Set-DotEnvKey $EnvPath 'LIVEKIT_URL' "ws://127.0.0.1:$($newMap['LK_HTTP'])"
        $localDir = Join-Path $script:RepoRoot '.local'
        if (-not (Test-Path -LiteralPath $localDir)) {
            $null = New-Item -ItemType Directory -Path $localDir -Force
        }
        $ymlContent = @(
            'services:'
            '  livekit:'
            "    entrypoint: /livekit-server --rtc.tcp_port $($newMap['LK_TCP']) --udp-port $($newMap['LK_UDP'])"
            '    ports: !override'
            "      - ""127.0.0.1:$($newMap['LK_HTTP']):7880"""
            "      - ""`${LIVEKIT_RTC_BIND_ADDRESS:-127.0.0.1}:$($newMap['LK_TCP']):$($newMap['LK_TCP'])"""
            "      - ""`${LIVEKIT_RTC_BIND_ADDRESS:-127.0.0.1}:$($newMap['LK_UDP']):$($newMap['LK_UDP'])/udp"""
        ) -join "`n"
        [IO.File]::WriteAllText($overridePath, $ymlContent + "`n", $script:Utf8NoBom)

        $existingComposeFile = $envMap['COMPOSE_FILE']
        $sep = [string][IO.Path]::PathSeparator
        if (-not $existingComposeFile) {
            Set-DotEnvKey $EnvPath 'COMPOSE_FILE' "docker-compose.yml$sep$overrideRel"
        } elseif (-not ($existingComposeFile.Split($sep) -contains $overrideRel)) {
            Set-DotEnvKey $EnvPath 'COMPOSE_FILE' "$existingComposeFile$sep$overrideRel"
        }
    }
}

function Prompt-OwnerCreation([bool]$AssumeYes) {
    if (-not (Read-YesNoPrompt "  Create the initial owner account now? [Y/n]: " $true $AssumeYes)) {
        return
    }
    $email = Read-PromptLine "  Owner email (default: owner@linger.local): "
    if (-not $email) { $email = 'owner@linger.local' }

    $password = ''
    while ($true) {
        $rawPassword = Read-PasswordPrompt "  Owner password (min 8 characters, default: test1234): "
        if ($null -eq $rawPassword) {
            Write-OutLine "  Skipping owner creation (no password provided)."
            return
        }
        if ($rawPassword -eq '') {
            $password = 'test1234'
            Write-OutLine "  Reminder: change the default password in Settings -> Security."
            break
        }
        if ($rawPassword.Length -ge 8) {
            $password = $rawPassword
            break
        }
        Write-OutLine "  Password must be at least 8 characters."
    }

    $res = Invoke-ExternalCommand 'docker' @('compose', 'exec', '-T', 'teamhub', 'teamhub-account', 'create-owner', '--email', $email, '--password-stdin') $script:RepoRoot $null ($password + "`n")
    if ($res.ExitCode -eq 0) {
        Write-OutLine "  Owner account ready for $email."
    } else {
        Write-OutLine "  Could not create owner account (it may already exist, or teamhub is still initializing)."
    }
}

function Start-ComposeServer([bool]$AssumeYes) {
    $verRes = Invoke-ExternalCommand 'docker' @('compose', 'version') $script:RepoRoot
    if ($verRes.ExitCode -ne 0) {
        Exit-Fail "Docker Compose v2 is required to start Linger locally. Start Docker Desktop and try again."
    }

    $envPath = Join-Path $script:RepoRoot '.env'
    $examplePath = Join-Path $script:RepoRoot '.env.example'
    if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
        if (-not (Test-Path -LiteralPath $examplePath -PathType Leaf)) {
            Exit-Fail ".env.example is missing in $($script:RepoRoot)."
        }
        Copy-Item -LiteralPath $examplePath -Destination $envPath
    }

    Ensure-ComposePorts $envPath $AssumeYes

    Write-OutLine "  Starting Linger with Docker Compose..."
    $upRes = Invoke-ExternalCommand 'docker' @('compose', 'up', '--build', '--detach', '--wait') $script:RepoRoot $null $null $true
    if ($upRes.ExitCode -ne 0) {
        Exit-Fail "Docker Compose failed to start Linger."
    }

    $finalEnv = Read-DotEnvFile $envPath
    $composeOrigin = Normalize-Origin $finalEnv['WEB_PUBLIC_ORIGIN']
    if (-not $composeOrigin) {
        $port = Parse-IntOrDefault $finalEnv['WEB_HTTP_PORT'] 3000
        $composeOrigin = "http://localhost:$port"
    }

    if (-not (Test-LingerServer $composeOrigin)) {
        Exit-Fail "Linger server did not become reachable at $composeOrigin."
    }

    Write-OutLine "  Linger server is ready at $composeOrigin."
    Prompt-OwnerCreation $AssumeYes
    return $composeOrigin
}

function Prompt-CustomUrl([string]$DefaultOrigin, [bool]$AllowSkip = $true) {
    while ($true) {
        $hint = if ($AllowSkip) { " (or type 'skip' to continue with local models only)" } else { '' }
        $raw = Read-PromptLine ("  Enter Linger server URL" + $hint + ": ")
        if ($null -eq $raw) {
            Exit-Fail "No server URL provided."
        }
        if ($AllowSkip -and $raw.ToLowerInvariant() -eq 'skip') {
            return ''
        }
        $normalized = Normalize-Origin $raw
        if (-not $normalized) {
            Write-OutLine "  Invalid URL. Please enter an origin like http://localhost:3000."
            continue
        }
        if (Test-LingerServer $normalized) {
            Write-OutLine "  Found Linger server at $normalized."
            return $normalized
        }
        if (Read-YesNoPrompt "  Could not reach a Linger server at $normalized. Use it anyway? [y/N]: " $false $false) {
            return $normalized
        }
    }
}

function Resolve-InitialOrigin([string]$ExplicitOrigin) {
    if ($ExplicitOrigin) {
        return $ExplicitOrigin
    }
    if ($env:LINGER_WEB_URL) {
        $fromEnv = Normalize-Origin $env:LINGER_WEB_URL
        if (-not $fromEnv) {
            Exit-Fail "Invalid LINGER_WEB_URL: $($env:LINGER_WEB_URL)"
        }
        return $fromEnv
    }
    if ($script:InRepo -and $script:RepoRoot) {
        $dotEnv = Read-DotEnvFile (Join-Path $script:RepoRoot '.env')
        $fromDotEnv = Normalize-Origin $dotEnv['WEB_PUBLIC_ORIGIN']
        if ($fromDotEnv) { return $fromDotEnv }
        $dotExample = Read-DotEnvFile (Join-Path $script:RepoRoot '.env.example')
        $fromExample = Normalize-Origin $dotExample['WEB_PUBLIC_ORIGIN']
        if ($fromExample) { return $fromExample }
    }
    return 'http://localhost:3000'
}

function Invoke-StepCheckServer([string]$Origin, [bool]$AssumeYes) {
    Write-OutLine ""
    Write-OutLine "[1/4] Checking Linger server"
    if (Test-LingerServer $Origin) {
        Write-OutLine "  Found Linger server at $Origin."
        return @{ Origin = $Origin; LocalOnly = $false }
    }

    Write-OutLine "  Could not reach a Linger server at $Origin."
    if ($script:HasCompose) {
        Write-OutLine "  Choose how to proceed:"
        Write-OutLine "    1) Start Linger on this computer with Docker Compose (recommended)"
        Write-OutLine "    2) Enter the URL of an existing Linger server"
        Write-OutLine "    3) Install local models only (connect to Linger later)"
        $choice = if ($AssumeYes) { '1' } else { Read-PromptLine "  Choice [1-3] (default: 1): " }
        if (-not $choice) { $choice = '1' }
        switch ($choice) {
            '1' {
                $startedOrigin = Start-ComposeServer $AssumeYes
                return @{ Origin = $startedOrigin; LocalOnly = $false }
            }
            '2' {
                $custom = Prompt-CustomUrl $Origin $true
                if (-not $custom) {
                    Write-OutLine "  Continuing with local models only."
                    return @{ Origin = $Origin; LocalOnly = $true }
                }
                return @{ Origin = $custom; LocalOnly = $false }
            }
            '3' {
                Write-OutLine "  Continuing with local models only."
                return @{ Origin = $Origin; LocalOnly = $true }
            }
            default {
                Exit-Fail "Invalid choice: $choice"
            }
        }
    } else {
        Write-OutLine "  Choose how to proceed:"
        Write-OutLine "    1) Enter the URL of an existing Linger server"
        Write-OutLine "    2) Install local models only (connect to Linger later)"
        $choice = if ($AssumeYes) { '2' } else { Read-PromptLine "  Choice [1-2] (default: 2): " }
        if (-not $choice) { $choice = '2' }
        switch ($choice) {
            '1' {
                $custom = Prompt-CustomUrl $Origin $true
                if (-not $custom) {
                    Write-OutLine "  Continuing with local models only."
                    return @{ Origin = $Origin; LocalOnly = $true }
                }
                return @{ Origin = $custom; LocalOnly = $false }
            }
            '2' {
                Write-OutLine "  Continuing with local models only."
                return @{ Origin = $Origin; LocalOnly = $true }
            }
            default {
                Exit-Fail "Invalid choice: $choice"
            }
        }
    }
}

function Invoke-StackUpWithRetry([bool]$AssumeYes) {
    $res = Invoke-Stack @('up') $true
    if ($res.ExitCode -eq 0) {
        return
    }
    if (Read-YesNoPrompt "  Retry starting while sharing GPU with other running processes? [Y/n]: " $true $AssumeYes) {
        $retry = Invoke-Stack @('up', '--share-gpu') $true
        if ($retry.ExitCode -eq 0) {
            return
        }
        Exit-Fail "Could not start local models."
    }
    Write-OutLine "  Installation cancelled."
    exit $res.ExitCode
}

function Get-ObjProp($Obj, [string]$Name, $Default = $null) {
    if ($null -eq $Obj) { return $Default }
    $prop = $Obj.PSObject.Properties[$Name]
    if ($null -ne $prop -and $null -ne $prop.Value) {
        $val = $prop.Value
        if ($val -is [System.Collections.ICollection] -and -not ($val -is [System.Collections.IDictionary])) {
            return , $val
        }
        return $val
    }
    return $Default
}

function Get-ObjArray($Obj, [string]$Name) {
    $v = Get-ObjProp $Obj $Name $null
    if ($null -eq $v) { return , @() }
    if ($v -is [PSCustomObject] -and @($v.PSObject.Properties).Count -eq 0) {
        return , @()
    }
    $list = New-Object System.Collections.Generic.List[object]
    foreach ($item in $v) {
        if ($null -ne $item) { $null = $list.Add($item) }
    }
    return , ($list.ToArray())
}

function Resolve-ExistingStack([bool]$ForceUpdate, [bool]$AssumeYes) {
    if ($ForceUpdate) { return @{ Reuse = $false; Update = $true } }
    $stRes = Invoke-Stack @('status', '--json') $false
    if ($stRes.ExitCode -ne 0 -or -not $stRes.StdOut.Trim()) {
        return @{ Reuse = $false; Update = $false }
    }
    try {
        $st = $stRes.StdOut | ConvertFrom-Json
    } catch {
        return @{ Reuse = $false; Update = $false }
    }
    $deps = Get-ObjArray $st 'deployments'
    $lastRun = Get-ObjProp $st 'last_run' $null
    $hasLastOk = [bool](Get-ObjProp $lastRun 'ok' $false)
    if ($deps.Count -eq 0 -and -not $hasLastOk) {
        return @{ Reuse = $false; Update = $false }
    }
    $names = @($deps | ForEach-Object { Get-ObjProp $_ 'name' '' } | Where-Object { $_ }) -join ', '
    $label = if ($names) { $names } else { 'existing setup' }

    Write-OutLine ""
    Write-OutLine "[2/4] Checking existing local model setup"
    Write-OutLine "  An existing local model stack is already configured ($label)."
    Write-OutLine "  Choose how to proceed:"
    Write-OutLine "    1) Keep and start existing models (recommended)"
    Write-OutLine "    2) Reinstall or change model setup"
    $choice = if ($AssumeYes) { '1' } else { Read-PromptLine "  Choice [1-2] (default: 1): " }
    if (-not $choice) { $choice = '1' }
    if ($choice -eq '1') {
        Invoke-StackUpWithRetry $AssumeYes
        return @{ Reuse = $true; Update = $false }
    }
    if ($choice -eq '2') {
        return @{ Reuse = $false; Update = $true }
    }
    Exit-Fail "Invalid choice: $choice"
}

function Invoke-StepHardwareAndPlan([bool]$UpdateMode, [bool]$AssumeYes) {
    Write-OutLine ""
    Write-OutLine "[2/4] Checking hardware and model options"
    Write-OutLine "  Preparing local model installer..."

    $hwRes = Invoke-Stack @('hardware', '--json') $false
    if ($hwRes.ExitCode -ne 0) {
        $errLines = (@($hwRes.StdErr, $hwRes.StdOut) -join "`n").Split("`n") | ForEach-Object { Format-SanitizedLine $_ } | Where-Object { $_ -ne '' }
        if ($errLines) { Write-ErrLine ($errLines -join "`n") }
        Exit-Fail "Could not inspect hardware."
    }

    $hardware = $null
    try {
        $hardware = $hwRes.StdOut | ConvertFrom-Json
    } catch {
        Exit-Fail "Could not parse hardware report."
    }

    $picks = Get-ObjArray $hardware 'picks'
    if ($picks.Count -eq 0) {
        Exit-Fail "No supported local model fits this computer's hardware."
    }

    $selectedPick = $null
    if ($picks.Count -eq 1) {
        $selectedPick = $picks[0]
        $p = $selectedPick
        $role = [string](Get-ObjProp $p 'role' 'smartest')
        $roleText = if ($role -eq 'smartest') { 'Smartest (recommended)' } elseif ($role -eq 'fastest') { 'Fastest' } else { $role }
        $basis = [string](Get-ObjProp $p 'decode_basis' 'estimated')
        $basisText = if ($basis -eq 'measured-decode') { '(measured)' } else { '(estimated)' }
        Write-OutLine ("  Selected model: {0} ({1}) - {2}, score {3}, {4} tok/s {5}" -f (Get-ObjProp $p 'id' ''), (Get-ObjProp $p 'quant' ''), $roleText, (Get-ObjProp $p 'quality' 0), (Get-ObjProp $p 'decode_tok_s' 0), $basisText)
    } else {
        Write-OutLine "  Available model options:"
        for ($i = 0; $i -lt $picks.Count; $i++) {
            $p = $picks[$i]
            $role = [string](Get-ObjProp $p 'role' 'smartest')
            $roleText = if ($role -eq 'smartest') { 'Smartest (recommended)' } elseif ($role -eq 'fastest') { 'Fastest' } else { $role }
            $basis = [string](Get-ObjProp $p 'decode_basis' 'estimated')
            $basisText = if ($basis -eq 'measured-decode') { '(measured)' } else { '(estimated)' }
            Write-OutLine ("    {0}) {1} ({2}) - {3}, score {4}, {5} tok/s {6}" -f ($i + 1), (Get-ObjProp $p 'id' ''), (Get-ObjProp $p 'quant' ''), $roleText, (Get-ObjProp $p 'quality' 0), (Get-ObjProp $p 'decode_tok_s' 0), $basisText)
        }
        $pickRaw = if ($AssumeYes) { '1' } else { Read-PromptLine ("  Choose a model [1-$($picks.Count)] (default: 1): ") }
        if (-not $pickRaw) { $pickRaw = '1' }
        $pickIdx = 0
        if (-not [int]::TryParse($pickRaw, [ref]$pickIdx) -or $pickIdx -lt 1 -or $pickIdx -gt $picks.Count) {
            Exit-Fail "Invalid choice: $pickRaw"
        }
        $selectedPick = $picks[$pickIdx - 1]
    }

    $cards = Get-ObjArray $hardware 'cards'
    $pickCard = Get-ObjProp $selectedPick 'card' $null
    $pickCardObj = $cards | Where-Object { (Get-ObjProp $_ 'index' $null) -eq $pickCard } | Select-Object -First 1
    $hasGpu = ($null -ne $pickCard -and [int]$pickCard -ge 0)
    $needsShare = $false
    if ($hasGpu) {
        if ([bool](Get-ObjProp $selectedPick 'shared' $false)) { $needsShare = $true }
        $heldBy = Get-ObjArray $pickCardObj 'held_by'
        if ($heldBy.Count -gt 0) { $needsShare = $true }
        $cardAuto = Get-ObjProp $pickCardObj 'auto' $true
        if (-not [bool]$cardAuto) { $needsShare = $true }
    }

    $shareGpu = $false
    $gpuMemoryCap = ''
    if ($needsShare) {
        $sharePrompt = "  GPU {0} already has running processes. Share GPU {0}? [Y/n]: " -f $pickCard
        if (-not (Read-YesNoPrompt $sharePrompt $true $AssumeYes)) {
            Write-OutLine "  Installation cancelled."
            exit 0
        }
        $shareGpu = $true
        if (-not $AssumeYes) {
            while ($true) {
                $capRaw = Read-PromptLine "  Optional GPU memory limit for model sizing (e.g. 24G, Enter for auto): "
                if ($null -eq $capRaw -or $capRaw -eq '') {
                    break
                }
                if ($capRaw -match '^[1-9][0-9]*[GgMm]$') {
                    $gpuMemoryCap = $capRaw.ToUpperInvariant()
                    break
                }
                Write-OutLine "  Please enter a size like 24G or 16384M."
            }
        }
    }

    $includeHelpers = $false
    if (-not $AssumeYes) {
        $includeHelpers = Read-YesNoPrompt "  Also install optional routing, embedding, and reranker helper models? [y/N]: " $false $false
    }

    Write-OutLine ""
    Write-OutLine "[3/4] Installing and verifying the local model"
    Write-OutLine "  Preparing installation plan..."

    $planDir = Join-Path ([IO.Path]::GetTempPath()) ("linger-plan-" + [Guid]::NewGuid().ToString('N'))
    Set-PrivateWindowsDirectoryAcl $planDir
    $script:TempDirsToClean.Add($planDir)
    $planFile = Join-Path $planDir 'plan.json'

    $planArgs = New-Object System.Collections.Generic.List[string]
    $null = $planArgs.Add('plan')
    $null = $planArgs.Add('--out')
    $null = $planArgs.Add($planFile)
    if ($UpdateMode) { $null = $planArgs.Add('--update') }
    $null = $planArgs.Add('--prefer')
    $null = $planArgs.Add([string](Get-ObjProp $selectedPick 'role' 'smartest'))
    if ($hasGpu) {
        $null = $planArgs.Add('--gpu')
        $null = $planArgs.Add([string]$pickCard)
    }
    if ($shareGpu) {
        $null = $planArgs.Add('--share-gpu')
    }
    if ($gpuMemoryCap) {
        $null = $planArgs.Add('--gpu-memory')
        $null = $planArgs.Add($gpuMemoryCap)
    }
    if ($includeHelpers) {
        $null = $planArgs.Add('--decision')
        $null = $planArgs.Add('auto')
        $null = $planArgs.Add('--aux')
        $null = $planArgs.Add('embedding,reranker')
    }

    $planRes = Invoke-Stack ($planArgs.ToArray()) $false
    if ($planRes.ExitCode -ne 0) {
        $errLines = (@($planRes.StdErr, $planRes.StdOut) -join "`n").Split("`n") | ForEach-Object { Format-SanitizedLine $_ } | Where-Object { $_ -ne '' }
        if ($errLines) { Write-ErrLine ($errLines -join "`n") }
        Exit-Fail "Could not prepare the installation plan."
    }

    $planJson = ''
    if (Test-Path -LiteralPath $planFile -PathType Leaf) {
        $planJson = [IO.File]::ReadAllText($planFile, $script:Utf8NoBom)
    }
    if (-not $planJson.Trim()) {
        $planJson = $planRes.StdOut
    }

    $plan = $null
    try {
        $plan = $planJson | ConvertFrom-Json
    } catch {
        Exit-Fail "Could not parse the installation plan."
    }

    $llmObj = Get-ObjProp $plan 'llm' $null
    $llmModelObj = Get-ObjProp $llmObj 'model' $null
    $modelName = [string](Get-ObjProp $llmModelObj 'display_name' (Get-ObjProp $llmModelObj 'id' 'model'))
    $modelQuant = [string](Get-ObjProp $llmModelObj 'quant' '')
    $placementObj = Get-ObjProp $llmObj 'placement' $null
    $placementLabel = [string](Get-ObjProp $placementObj 'label' 'local')
    $launchObj = Get-ObjProp $llmObj 'launch' $null
    $windowVal = [long](Get-ObjProp $launchObj 'window' 0)
    $ctxText = Format-ContextWindow $windowVal

    $helperItems = New-Object System.Collections.Generic.List[string]
    $decisionObj = Get-ObjProp $plan 'decision' $null
    $decisionModel = Get-ObjProp $decisionObj 'model' $null
    if ($null -ne $decisionModel) {
        $dName = [string](Get-ObjProp $decisionModel 'display_name' (Get-ObjProp $decisionModel 'id' 'routing'))
        $null = $helperItems.Add("routing ($dName)")
    }
    foreach ($ax in (Get-ObjArray $plan 'aux')) {
        $axEnd = Get-ObjProp $ax 'endpoint' $null
        $label = [string](Get-ObjProp $axEnd 'contract' (Get-ObjProp $ax 'name' ''))
        $axMod = Get-ObjProp $ax 'model' $null
        $axTool = Get-ObjProp $ax 'tool' $null
        $mLabel = ''
        if ($null -ne $axMod) {
            $mLabel = [string](Get-ObjProp $axMod 'display_name' (Get-ObjProp $axMod 'id' ''))
        } elseif ($null -ne $axTool) {
            if ($axTool -is [string]) {
                $mLabel = $axTool
            } else {
                $mLabel = [string](Get-ObjProp $axTool 'display_name' (Get-ObjProp $axTool 'id' ''))
            }
        }
        if ($label -and $mLabel) {
            $null = $helperItems.Add("$label ($mLabel)")
        } elseif ($mLabel) {
            $null = $helperItems.Add($mLabel)
        } elseif ($label) {
            $null = $helperItems.Add($label)
        }
    }
    $helperText = if ($helperItems.Count -gt 0) { $helperItems -join ', ' } else { 'none' }

    $budgetObj = Get-ObjProp $plan 'budget' $null
    $dlSize = Format-Size ([double](Get-ObjProp $budgetObj 'download_bytes' 0))
    $diskSize = Format-Size ([double](Get-ObjProp $budgetObj 'disk_needed_bytes' 0))
    $ramNeed = Format-Size ([double](Get-ObjProp $budgetObj 'ram_needed_bytes' 0))
    $ramAvail = Format-Size ([double](Get-ObjProp $budgetObj 'ram_available_bytes' 0))

    Write-OutLine ""
    Write-OutLine "  Plan summary:"
    Write-OutLine ("    Model:     {0} ({1}), {2}, context {3}" -f $modelName, $modelQuant, $placementLabel, $ctxText)
    Write-OutLine ("    Helpers:   {0}" -f $helperText)
    Write-OutLine ("    Resources: download {0}, disk {1}, RAM {2} / {3} available" -f $dlSize, $diskSize, $ramNeed, $ramAvail)

    $preflightObj = Get-ObjProp $plan 'preflight' $null
    $findings = Get-ObjArray $preflightObj 'findings'
    foreach ($f in $findings) {
        $fLevel = [string](Get-ObjProp $f 'level' 'warn')
        $fCheck = [string](Get-ObjProp $f 'check' '')
        if ($fLevel -eq 'pass') {
            continue
        }
        if ($fLevel -eq 'warn' -and $fCheck -eq 'preflight.gpu' -and $shareGpu) {
            continue
        }
        if ($fLevel -eq 'warn' -and $fCheck -eq 'preflight.running') {
            Write-OutLine "    Note: Existing local model deployments are kept untouched on separate ports."
            continue
        }
        $prefix = if ($fLevel -eq 'fail') { 'Error' } else { 'Warning' }
        $detailText = [string](Get-ObjProp $f 'detail' '')
        Write-OutLine ("    {0}: {1}" -f $prefix, (Format-SanitizedLine $detailText))
        $fixText = [string](Get-ObjProp $f 'fix' '')
        if ($fixText) {
            Write-OutLine ("      Fix: {0}" -f (Format-SanitizedLine $fixText))
        }
    }

    $countsObj = Get-ObjProp $preflightObj 'counts' $null
    $failCount = [int](Get-ObjProp $countsObj 'fail' 0)
    if ($failCount -gt 0) {
        Exit-Fail "Preflight checks failed. Resolve the errors above and run $($script:DisplayCmd) again."
    }

    if (-not (Read-YesNoPrompt "  Approve download and installation? [y/N]: " $false $AssumeYes)) {
        Write-OutLine "  Nothing was downloaded or changed. Run $($script:DisplayCmd) whenever you want to try again."
        exit 0
    }

    $planId = [string](Get-ObjProp $plan 'plan_id' '')
    $applyRes = Invoke-Stack @('apply', $planFile, '--approve', $planId) $true
    if ($applyRes.ExitCode -ne 0) {
        Exit-Fail "Local model installation failed."
    }
}

function Resolve-ComputerLauncher([string]$Origin) {
    $envName = Get-ComputerEnvironmentName $Origin
    $binDir = if ($env:LINGER_COMPUTER_BIN_DIR) { $env:LINGER_COMPUTER_BIN_DIR } else { Join-Path (Get-LocalAppDataRoot) 'Linger\bin' }
    $exePath = Join-Path $binDir ("linger-computer-$envName.exe")
    if (Test-Path -LiteralPath $exePath -PathType Leaf) {
        return @{ Path = $exePath; BinDir = $binDir; EnvName = $envName }
    }
    $cmdPath = Join-Path $binDir ("linger-computer-$envName.cmd")
    if (Test-Path -LiteralPath $cmdPath -PathType Leaf) {
        return @{ Path = $cmdPath; BinDir = $binDir; EnvName = $envName }
    }
    return @{ Path = $exePath; BinDir = $binDir; EnvName = $envName }
}

function Build-ComputerEnvOverrides([string]$BinDir) {
    $userHome = Get-UserHome
    $localBin = Join-Path $userHome '.local\bin'
    $piAgentDir = Join-Path $userHome '.local\share\localmodels\tools\gateway-home\.pi\agent'

    $pathParts = New-Object System.Collections.Generic.List[string]
    if ($BinDir) { $null = $pathParts.Add($BinDir) }
    if ($localBin) { $null = $pathParts.Add($localBin) }
    if ($env:PATH) { $null = $pathParts.Add($env:PATH) }
    $joinedPath = $pathParts -join ';'

    $overrides = @{
        'PATH' = $joinedPath
    }
    if ($env:SystemRoot) { $overrides['SystemRoot'] = $env:SystemRoot }
    if ($env:PATHEXT) { $overrides['PATHEXT'] = $env:PATHEXT }
    if (Test-Path -LiteralPath $piAgentDir) {
        $overrides['PI_CODING_AGENT_DIR'] = $piAgentDir
    }
    return $overrides
}

function Resolve-PiBinary {
    $localBin = Join-Path (Get-UserHome) '.local\bin'
    foreach ($candidateName in @('pi.cmd', 'pi.exe', 'pi')) {
        $p = Join-Path $localBin $candidateName
        if (Test-Path -LiteralPath $p -PathType Leaf) {
            return $p
        }
    }
    $cmd = Get-Command pi -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) {
        return $cmd.Source
    }
    return ''
}

function Invoke-ComputerCommand([string]$LauncherPath, [string[]]$CompArgs, [hashtable]$EnvOverrides, [bool]$StreamOutput = $true) {
    return Invoke-ExternalCommand $LauncherPath $CompArgs '' $EnvOverrides $null $StreamOutput $StreamOutput
}

function Invoke-ConnectStep([string]$Origin) {
    Write-OutLine ""
    Write-OutLine "[4/4] Connecting this computer to Linger"

    if (Test-IsElevated) {
        Exit-Fail "Cannot connect this computer from an elevated Administrator PowerShell window. Open an ordinary non-elevated PowerShell window and run: $($script:DisplayCmd) --connect --web-url $Origin"
    }

    $tmpDir = Join-Path ([IO.Path]::GetTempPath()) ("linger-comp-" + [Guid]::NewGuid().ToString('N'))
    Set-PrivateWindowsDirectoryAcl $tmpDir
    $script:TempDirsToClean.Add($tmpDir)
    $installerPs1 = Join-Path $tmpDir 'linger-computer.ps1'

    $resp = Invoke-HttpGetText "$Origin/install/linger-computer.ps1" 30
    if (-not $resp.Ok -or (-not ($resp.Content -match 'LingerInstallerEmbedded' -or $resp.Content -match 'linger-computer-launcher-v2'))) {
        Exit-Fail "Could not download the Linger Computer installer from $Origin."
    }
    [IO.File]::WriteAllText($installerPs1, $resp.Content, $script:Utf8NoBom)

    $bootEnv = @{
        'LINGER_WEB_URL' = $Origin
    }
    if ($env:LINGER_COMPUTER_BIN_DIR) { $bootEnv['LINGER_COMPUTER_BIN_DIR'] = $env:LINGER_COMPUTER_BIN_DIR }
    if ($env:LINGER_COMPUTER_DATA_DIR) { $bootEnv['LINGER_COMPUTER_DATA_DIR'] = $env:LINGER_COMPUTER_DATA_DIR }
    if ($env:LINGER_COMPUTER_CONFIG) { $bootEnv['LINGER_COMPUTER_CONFIG'] = $env:LINGER_COMPUTER_CONFIG }

    $bootArgs = Join-CommandArgs @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installerPs1)
    $bootRes = [LingerProcessRunner]::RunWithPump($script:PowerShellExe, $bootArgs, '', (ConvertTo-EnvDict $bootEnv), $null, $script:RawBatchPrinter)
    if ($bootRes.ExitCode -ne 0) {
        Exit-Fail "Linger Computer installation failed."
    }

    $resolved = Resolve-ComputerLauncher $Origin
    $launcher = $resolved.Path
    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
        Exit-Fail "Linger Computer launcher was not found after installation: $launcher"
    }

    $compEnv = Build-ComputerEnvOverrides $resolved.BinDir
    $piBin = Resolve-PiBinary

    $authorized = $false
    $authRes = Invoke-ComputerCommand $launcher @('auth', 'status', '--json') $compEnv $false
    if ($authRes.ExitCode -eq 0 -and $authRes.StdOut.Trim()) {
        try {
            $authObj = $authRes.StdOut | ConvertFrom-Json
            if ([bool](Get-ObjProp $authObj 'authorized' $false)) {
                $authorized = $true
            }
        } catch {
        }
    }

    if ($authorized) {
        Write-OutLine "  This computer is already linked to Linger. Restarting background service..."
        $restartRes = Invoke-ComputerCommand $launcher @('daemon', 'restart') $compEnv $true
        if ($restartRes.ExitCode -ne 0) {
            Exit-Fail "Failed to restart the Linger Computer daemon."
        }
    } else {
        Write-OutLine "  Sign in to link this computer to Linger (a browser window may open)..."
        $loginArgs = New-Object System.Collections.Generic.List[string]
        $null = $loginArgs.Add('login')
        $null = $loginArgs.Add('--web-url')
        $null = $loginArgs.Add($Origin)
        if ($piBin) {
            $null = $loginArgs.Add('--pi-path')
            $null = $loginArgs.Add($piBin)
        }
        $loginRes = Invoke-ComputerCommand $launcher ($loginArgs.ToArray()) $compEnv $true
        if ($loginRes.ExitCode -ne 0) {
            Exit-Fail "Failed to link this computer to Linger."
        }
    }

    if ($piBin) {
        Write-OutLine "  Verifying Pi local model connection..."
        $checkRes = Invoke-ComputerCommand $launcher @('runtime', 'check', 'pi', '--live', '--pi-path', $piBin) $compEnv $true
        if ($checkRes.ExitCode -ne 0) {
            Exit-Fail "Pi local model verification failed."
        }
    }

    Write-OutLine "Done."
}

function Invoke-ModeStatus([string]$Origin) {
    $stRes = Invoke-Stack @('status') $true
    if ($stRes.ExitCode -ne 0) {
        Exit-Fail "Could not read local model status."
    }
    $resolved = Resolve-ComputerLauncher $Origin
    if (Test-Path -LiteralPath $resolved.Path -PathType Leaf) {
        $compEnv = Build-ComputerEnvOverrides $resolved.BinDir
        $null = Invoke-ComputerCommand $resolved.Path @('daemon', 'status') $compEnv $true
    }
}

function Invoke-ModeUp([string]$Origin, [bool]$AssumeYes) {
    Invoke-StackUpWithRetry $AssumeYes
    $resolved = Resolve-ComputerLauncher $Origin
    if (Test-Path -LiteralPath $resolved.Path -PathType Leaf) {
        $compEnv = Build-ComputerEnvOverrides $resolved.BinDir
        $authRes = Invoke-ComputerCommand $resolved.Path @('auth', 'status', '--json') $compEnv $false
        if ($authRes.ExitCode -eq 0 -and $authRes.StdOut.Trim()) {
            try {
                $authObj = $authRes.StdOut | ConvertFrom-Json
                if ([bool](Get-ObjProp $authObj 'authorized' $false)) {
                    $null = Invoke-ComputerCommand $resolved.Path @('daemon', 'restart') $compEnv $true
                }
            } catch {
            }
        }
    }
}

function Invoke-ModeConnect([string]$Origin) {
    if (Test-IsElevated) {
        Exit-Fail "Cannot connect this computer from an elevated Administrator PowerShell window. Open an ordinary non-elevated PowerShell window and run: $($script:DisplayCmd) --connect --web-url $Origin"
    }
    $targetOrigin = $Origin
    if (-not (Test-LingerServer $targetOrigin)) {
        Write-OutLine "  Could not reach a Linger server at $targetOrigin."
        $targetOrigin = Prompt-CustomUrl $targetOrigin $true
        if (-not $targetOrigin) {
            Write-OutLine "  Continuing with local models only."
            return
        }
    } else {
        Write-OutLine "  Found Linger server at $targetOrigin."
    }
    Invoke-ConnectStep $targetOrigin
}

function Invoke-ModeRemove([bool]$Purge, [bool]$AssumeYes) {
    if (-not $Purge) {
        $rmRes = Invoke-Stack @('remove', '--yes') $true
        if ($rmRes.ExitCode -ne 0) {
            Exit-Fail "Failed to stop or remove local model services."
        }
        return
    }

    $dryRes = Invoke-Stack @('remove', '--purge', '--dry-run') $true
    if ($dryRes.ExitCode -ne 0) {
        Exit-Fail "Failed to inspect local model files for removal."
    }
    if (-not (Read-YesNoPrompt "  Delete local model configuration and all downloaded model files? [y/N]: " $false $AssumeYes)) {
        Write-OutLine "  Nothing deleted."
        return
    }
    $purgeRes = Invoke-Stack @('remove', '--purge', '--yes') $true
    if ($purgeRes.ExitCode -ne 0) {
        Exit-Fail "Failed to purge local model files."
    }
}

# --- Main ---

$mode = 'guide'
$modeFlag = ''
$explicitOrigin = ''
$assumeYes = $false
$forceUpdate = $false
$purge = $false

$i = 0
while ($i -lt $script:CliArgs.Count) {
    $arg = [string]$script:CliArgs[$i]
    switch -Wildcard ($arg) {
        '--help' { Show-Usage; exit 0 }
        '-h'     { Show-Usage; exit 0 }
        '-?'     { Show-Usage; exit 0 }
        '--yes'  { $assumeYes = $true }
        '-y'     { $assumeYes = $true }
        '--update'      { $forceUpdate = $true }
        '--purge'       { $purge = $true }
        '--web-url' {
            if ($i + 1 -ge $script:CliArgs.Count) {
                Exit-Fail "--web-url requires an origin URL"
            }
            $rawUrl = [string]$script:CliArgs[$i + 1]
            $norm = Normalize-Origin $rawUrl
            if (-not $norm) {
                Exit-Fail "Invalid Linger server URL: $rawUrl"
            }
            $explicitOrigin = $norm
            $i++
        }
        '--web-url=*' {
            $rawUrl = $arg.Substring('--web-url='.Length)
            if (-not $rawUrl) {
                Exit-Fail "--web-url requires an origin URL"
            }
            $norm = Normalize-Origin $rawUrl
            if (-not $norm) {
                Exit-Fail "Invalid Linger server URL: $rawUrl"
            }
            $explicitOrigin = $norm
        }
        '--connect' {
            if ($modeFlag -and $modeFlag -ne '--connect') {
                Exit-Fail "Options $modeFlag and --connect cannot be combined"
            }
            $mode = 'connect'
            $modeFlag = '--connect'
        }
        '--up' {
            if ($modeFlag -and $modeFlag -ne '--up') {
                Exit-Fail "Options $modeFlag and --up cannot be combined"
            }
            $mode = 'up'
            $modeFlag = '--up'
        }
        '--status' {
            if ($modeFlag -and $modeFlag -ne '--status') {
                Exit-Fail "Options $modeFlag and --status cannot be combined"
            }
            $mode = 'status'
            $modeFlag = '--status'
        }
        '--remove' {
            if ($modeFlag -and $modeFlag -ne '--remove') {
                Exit-Fail "Options $modeFlag and --remove cannot be combined"
            }
            $mode = 'remove'
            $modeFlag = '--remove'
        }
        default {
            Exit-Fail "Unknown option: $arg"
        }
    }
    $i++
}

if ($purge -and $mode -ne 'remove') {
    Exit-Fail "Option --purge requires --remove"
}

try {
    Resolve-StackScript
    $origin = Resolve-InitialOrigin $explicitOrigin

    switch ($mode) {
        'status' {
            Invoke-ModeStatus $origin
        }
        'up' {
            Invoke-ModeUp $origin $assumeYes
        }
        'connect' {
            Invoke-ModeConnect $origin
        }
        'remove' {
            Invoke-ModeRemove $purge $assumeYes
        }
        'guide' {
            if (Test-IsElevated) {
                Write-OutLine "Note: PowerShell is running as Administrator. Connecting this computer to Linger in step [4/4] requires a non-elevated PowerShell window."
                if (-not (Read-YesNoPrompt "Continue with server/hardware checks and local model installation anyway? [Y/n]: " $true $assumeYes)) {
                    Write-OutLine "Installation cancelled."
                    exit 0
                }
            }

            $serverState = Invoke-StepCheckServer $origin $assumeYes
            $resolvedOrigin = $serverState.Origin
            $localOnly = [bool]$serverState.LocalOnly

            $existing = Resolve-ExistingStack $forceUpdate $assumeYes
            if (-not $existing.Reuse) {
                Invoke-StepHardwareAndPlan ([bool]$existing.Update) $assumeYes
            }

            if ($localOnly) {
                Write-OutLine ""
                Write-OutLine "Local models are ready."
                Write-OutLine "When your Linger server is running, connect with:"
                Write-OutLine "  $($script:DisplayCmd) --connect --web-url $resolvedOrigin"
            } else {
                Invoke-ConnectStep $resolvedOrigin
            }
        }
    }
} finally {
    Cleanup-TempDirs
}
