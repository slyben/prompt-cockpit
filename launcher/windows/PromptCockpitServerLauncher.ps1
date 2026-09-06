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

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "cmd.exe"
$psi.Arguments = "/c npm start"
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
