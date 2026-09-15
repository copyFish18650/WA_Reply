param(
  [switch]$Monitor,
  [int]$CheckIntervalSeconds = 15
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $projectRoot "data"
$nodePath = (Get-Command node -ErrorAction Stop).Source
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

function Get-PortOwner([int]$Port) {
  return Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Start-Database {
  if (-not (Get-PortOwner 3307)) {
    & (Join-Path $PSScriptRoot "start-mysql-dev.ps1")
  }
}

function Start-LocalModel {
  if (-not (Get-PortOwner 11435)) {
    & (Join-Path $PSScriptRoot "start-qwen35.ps1")
  }
}

function Start-WorkspaceApp {
  $listener = Get-PortOwner 3010
  if ($listener) { return $listener.OwningProcess }
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $stdoutPath = Join-Path $dataDir "app-$stamp.log"
  $stderrPath = Join-Path $dataDir "app-$stamp-error.log"
  $process = Start-Process `
    -FilePath $nodePath `
    -ArgumentList "--disable-warning=ExperimentalWarning", "server.js" `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru
  foreach ($attempt in 1..30) {
    Start-Sleep -Milliseconds 500
    $listener = Get-PortOwner 3010
    if ($listener) { return $listener.OwningProcess }
    if ($process.HasExited) {
      $details = if (Test-Path -LiteralPath $stderrPath) { (Get-Content -LiteralPath $stderrPath -Tail 30) -join [Environment]::NewLine } else { "" }
      throw "WhatsApp Sales AI failed to start. $details"
    }
  }
  throw "WhatsApp Sales AI did not listen on port 3010. Check $stderrPath"
}

function Ensure-Stack {
  Start-Database
  Start-LocalModel
  $appPid = Start-WorkspaceApp
  Write-Output "Local stack ready: app=http://127.0.0.1:3010 (PID $appPid), AI=http://127.0.0.1:11435, MySQL=127.0.0.1:3307"
}

Ensure-Stack
if (-not $Monitor) { exit 0 }

Write-Output "Monitoring local stack every $CheckIntervalSeconds seconds. Press Ctrl+C to stop monitoring."
while ($true) {
  Start-Sleep -Seconds ([Math]::Max(5, $CheckIntervalSeconds))
  try {
    if (-not (Get-PortOwner 3307) -or -not (Get-PortOwner 11435) -or -not (Get-PortOwner 3010)) {
      Write-Output "[$(Get-Date -Format s)] A component stopped; restarting the local stack."
      Ensure-Stack
    }
  } catch {
    Write-Error "[$(Get-Date -Format s)] Recovery failed: $($_.Exception.Message)" -ErrorAction Continue
  }
}
