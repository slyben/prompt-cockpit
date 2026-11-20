param([string]$RepoPath)

$scriptName = Split-Path -Leaf $PSCommandPath
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like "*$scriptName*" } |
    ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null }

try {
    $repoRoot = (Resolve-Path -LiteralPath $RepoPath -ErrorAction Stop).Path.TrimEnd('\')
}
catch {
    Write-Host "[ERROR] RepoPath '$RepoPath' could not be resolved ($($_.Exception.Message))."
    exit 1
}

Set-Location -LiteralPath $repoRoot
git pull
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] git pull failed - resolve manually in $RepoPath."
    exit 1
}

Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class RLProcessInfo {
    [StructLayout(LayoutKind.Sequential)]
    struct BasicInformation {
        public IntPtr ExitStatus, PebBaseAddress, AffinityMask, BasePriority, UniqueProcessId, InheritedFromUniqueProcessId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool IsWow64Process(IntPtr process, out bool wow64);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);
    [DllImport("ntdll.dll")]
    static extern int NtQueryInformationProcess(IntPtr process, int infoClass, ref BasicInformation info, int size, out int returned);

    const uint QUERY_INFORMATION = 0x0400, VM_READ = 0x0010;
    const int PEB_PROCESS_PARAMETERS = 0x20, PARAMETERS_CURRENT_DIRECTORY = 0x38;

    static byte[] Read(IntPtr process, IntPtr address, int size) {
        byte[] buffer = new byte[size];
        IntPtr read;
        if (!ReadProcessMemory(process, address, buffer, new IntPtr(size), out read) || read.ToInt64() != size) throw new Win32Exception();
        return buffer;
    }

    // x64 only: the offsets above are for 64-bit PEB layouts.
    public static string GetCurrentDirectory(int pid) {
        if (IntPtr.Size != 8) throw new NotSupportedException("launcher is not running as 64-bit PowerShell");
        IntPtr process = OpenProcess(QUERY_INFORMATION | VM_READ, false, pid);
        if (process == IntPtr.Zero) throw new Win32Exception();
        try {
            bool wow64;
            if (!IsWow64Process(process, out wow64)) throw new Win32Exception();
            if (wow64) throw new NotSupportedException("process is 32-bit");
            BasicInformation info = new BasicInformation();
            int returned;
            int status = NtQueryInformationProcess(process, 0, ref info, Marshal.SizeOf(typeof(BasicInformation)), out returned);
            if (status != 0) throw new Win32Exception(string.Format("NtQueryInformationProcess failed (0x{0:X8})", status));
            IntPtr parameters = new IntPtr(BitConverter.ToInt64(Read(process, info.PebBaseAddress + PEB_PROCESS_PARAMETERS, 8), 0));
            byte[] dosPath = Read(process, parameters + PARAMETERS_CURRENT_DIRECTORY, 16);
            int length = BitConverter.ToUInt16(dosPath, 0);
            IntPtr buffer = new IntPtr(BitConverter.ToInt64(dosPath, 8));
            return System.Text.Encoding.Unicode.GetString(Read(process, buffer, length));
        }
        finally {
            CloseHandle(process);
        }
    }
}

public static class RLKillOnCloseJob {
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters { public ulong R, W, O, RB, WB, OB; }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    const int EXTENDED_LIMIT_INFORMATION = 9;
    const uint LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    // Held for the launcher's lifetime; the OS closes it when this process
    // exits for any reason, which kills everything still in the job.
    static IntPtr job;

    public static void Assign(IntPtr process) {
        job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception();
        ExtendedLimits info = new ExtendedLimits();
        info.Basic.LimitFlags = LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(job, EXTENDED_LIMIT_INFORMATION, ref info, (uint)Marshal.SizeOf(typeof(ExtendedLimits)))) throw new Win32Exception();
        if (!AssignProcessToJobObject(job, process)) throw new Win32Exception();
    }
}
"@

# Mirrors src/server.js (Number(PORT) || 4317): blank or 0 means the default.
$port = 4317
$portText = "$env:PORT".Trim()
if ($portText) {
    $parsedPort = 0
    if (-not [int]::TryParse($portText, [ref]$parsedPort) -or $parsedPort -lt 0 -or $parsedPort -gt 65535) {
        Write-Host "[ERROR] PORT must be a number from 1 to 65535 (got '$env:PORT')."
        exit 1
    }
    if ($parsedPort -ne 0) {
        $port = $parsedPort
    }
}

function Get-PortOwnerPids {
    try {
        $listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop
    }
    catch {
        if ($_.CategoryInfo.Category -eq 'ObjectNotFound') {
            return @()
        }
        Write-Host "[ERROR] Could not check whether port $port is in use ($($_.Exception.Message))."
        exit 1
    }
    @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
}

function Get-ProcessDirectory([int]$ProcessId) {
    try {
        return [RLProcessInfo]::GetCurrentDirectory($ProcessId).TrimEnd('\')
    }
    catch {
        # A server killed by an older launcher's job may still be tearing down.
        Start-Sleep -Seconds 1
        if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
            return $null
        }
        return [RLProcessInfo]::GetCurrentDirectory($ProcessId).TrimEnd('\')
    }
}

$staleServers = @()
foreach ($ownerPid in Get-PortOwnerPids) {
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerPid"
    if (-not $owner) {
        continue
    }
    if (-not ($owner.Name -eq 'node.exe' -and $owner.CommandLine -match 'src[\\/]server\.js')) {
        Write-Host "[ERROR] Port $port is held by $($owner.Name) (PID $ownerPid) - stop it and retry."
        exit 1
    }
    try {
        $ownerDir = Get-ProcessDirectory $ownerPid
    }
    catch {
        Write-Host "[ERROR] Port $port is held by node src/server.js (PID $ownerPid), but its working directory could not be read ($($_.Exception.Message)) - stop it and retry."
        exit 1
    }
    if ($null -eq $ownerDir) {
        continue
    }
    if ($ownerDir -ne $repoRoot) {
        Write-Host "[ERROR] Port $port is held by node src/server.js from $ownerDir (PID $ownerPid), not $repoRoot - stop it and retry."
        exit 1
    }
    $staleServers += $ownerPid
}

foreach ($stalePid in $staleServers) {
    Write-Host "[INFO] Replacing existing prompt-cockpit server on port $port (PID $stalePid)."
    taskkill /PID $stalePid /T /F 2>$null | Out-Null
}
$deadline = (Get-Date).AddSeconds(5)
while ((Get-PortOwnerPids).Count -gt 0 -and ((Get-Date) -lt $deadline)) {
    Start-Sleep -Milliseconds 250
}
$remaining = Get-PortOwnerPids
if ($remaining.Count -gt 0) {
    Write-Host "[ERROR] Port $port is still in use (PID $($remaining -join ', ')) - stop it and retry."
    exit 1
}

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "cmd.exe"
# Holds at set /p until the launcher writes a line, so npm cannot spawn
# before cmd is in the kill-on-close job (children inherit the job).
$psi.Arguments = "/c set /p RL_GATE=& npm start"
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.WorkingDirectory = $RepoPath

$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $psi

$global:RLServerUrl = $null
$global:RLPattern = 'https?://\S+'

$stdHandler = {
    if ($null -ne $EventArgs.Data) {
        Write-Host $EventArgs.Data
        if ((-not $global:RLServerUrl) -and ($EventArgs.Data -match $global:RLPattern)) {
            $global:RLServerUrl = $Matches[0]
        }
    }
}

Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -Action $stdHandler | Out-Null
Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived -Action $stdHandler | Out-Null

try {
    $proc.Start() | Out-Null
    $proc.BeginOutputReadLine()
    $proc.BeginErrorReadLine()
    try {
        [RLKillOnCloseJob]::Assign($proc.Handle)
    }
    catch {
        Write-Host "[ERROR] Could not create the kill-on-close job ($($_.Exception.Message)) - not starting the server."
        exit 1
    }
    $proc.StandardInput.WriteLine()
    $proc.StandardInput.Close()

    $deadline = (Get-Date).AddSeconds(60)
    while ((-not $global:RLServerUrl) -and (-not $proc.HasExited)) {
        Start-Sleep -Milliseconds 250
        if ((Get-Date) -gt $deadline) {
            Write-Host "[WARN] No URL detected after 60s, still waiting..."
            $deadline = (Get-Date).AddSeconds(60)
        }
    }

    if ($global:RLServerUrl) {
        Start-Process $global:RLServerUrl
    }

    while (-not $proc.HasExited) {
        Start-Sleep -Milliseconds 500
    }
}
finally {
    taskkill /PID $proc.Id /T /F 2>$null | Out-Null
    Get-EventSubscriber | Unregister-Event -ErrorAction SilentlyContinue
}
