param(
  [int]$GpuLayers = 0,
  [int]$ContextSize = 8192,
  [int]$Parallel = 2,
  [int]$Threads = [Math]::Min(12, [Environment]::ProcessorCount)
)

$ErrorActionPreference = "Stop"
$localAiRoot = Join-Path $env:LOCALAPPDATA "WhatsAppSalesAI\local-ai"
$serverPath = Join-Path $localAiRoot "llama-b10809-cuda\llama-server.exe"
if (-not (Test-Path -LiteralPath $serverPath)) {
  $serverPath = Join-Path $localAiRoot "llama-b10809-cpu\llama-server.exe"
}
$modelPath = Join-Path $localAiRoot "models\Qwen_Qwen3.5-9B-Q4_K_M.gguf"
$port = 11435

if (-not (Test-Path -LiteralPath $serverPath)) {
  throw "llama.cpp runtime not found: $serverPath"
}
if (-not (Test-Path -LiteralPath $modelPath)) {
  throw "Qwen3.5-9B model not found: $modelPath"
}

$listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
  if ($process.CommandLine -like "*Qwen_Qwen3.5-9B-Q4_K_M.gguf*") {
    Write-Output "Qwen3.5-9B is already running on http://127.0.0.1:$port (PID $($listener.OwningProcess))."
    exit 0
  }
  throw "Port $port is already occupied by PID $($listener.OwningProcess). Stop or reconfigure that service first."
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$stdoutPath = Join-Path $localAiRoot "llama-qwen35-$stamp.log"
$stderrPath = Join-Path $localAiRoot "llama-qwen35-$stamp-error.log"
$arguments = @(
  "--model", $modelPath,
  "--host", "127.0.0.1",
  "--port", "$port",
  "--alias", "Qwen3.5-9B-Q4_K_M",
  "--ctx-size", "$ContextSize",
  "--parallel", "$Parallel",
  "--threads", "$Threads",
  "--gpu-layers", "$GpuLayers",
  "--flash-attn", "on",
  "--reasoning", "off",
  "--reasoning-budget", "0",
  "--no-ui"
)

$process = Start-Process `
  -FilePath $serverPath `
  -ArgumentList $arguments `
  -WorkingDirectory (Split-Path $serverPath) `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutPath `
  -RedirectStandardError $stderrPath `
  -PassThru

$ready = $false
foreach ($attempt in 1..30) {
  Start-Sleep -Seconds 2
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 3
    if ($health.status -eq "ok") {
      $ready = $true
      break
    }
  } catch {
    # The model is still loading.
  }
}

if (-not $ready) {
  throw "Qwen3.5-9B did not become ready. Check $stderrPath"
}

Write-Output "Qwen3.5-9B is ready on http://127.0.0.1:$port (PID $($process.Id), GPU layers: $GpuLayers)."
Write-Output "Log: $stderrPath"
