param([string]$RepoPath)

$scriptName = Split-Path -Leaf $PSCommandPath
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like "*$scriptName*" } |
    ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null }

Set-Location $RepoPath
git pull
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] git pull failed - resolve manually in $RepoPath."
    exit 1
}

$port = if ($env:PORT) { [int]$env:PORT } else { 4317 }
$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
    if ($owner -and $owner.Name -eq 'node.exe' -and $owner.CommandLine -match 'src[\\/]server\.js') {
        Write-Host "[INFO] Replacing existing prompt-cockpit server on port $port (PID $($owner.ProcessId))."
        taskkill /PID $owner.ProcessId /T /F 2>$null | Out-Null
        $deadline = (Get-Date).AddSeconds(5)
        while ((Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline)) {
            Start-Sleep -Milliseconds 250
        }
    }
    elseif ($owner) {
        Write-Host "[ERROR] Port $port is held by $($owner.Name) (PID $($owner.ProcessId)) - stop it and retry."
        exit 1
    }
}

Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

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
        Write-Host "[WARN] Could not tie the server to this window ($($_.Exception.Message)); closing the window may leave it running."
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
