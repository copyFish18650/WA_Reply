param(
  [int]$Port = 3307
)

$ErrorActionPreference = "Stop"
$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existing) {
  Write-Host "MySQL is already listening on 127.0.0.1:$Port"
  exit 0
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $projectRoot "data\mysql-dev"
$candidates = @(
  "C:\Program Files\MySQL\MySQL Server 8.4\bin\mysqld.exe",
  "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysqld.exe"
)
$mysqld = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $mysqld) { throw "MySQL Server was not found. Install MySQL 8.0+ first." }
$baseDir = Split-Path -Parent (Split-Path -Parent $mysqld)

if (-not (Test-Path (Join-Path $dataDir "mysql"))) {
  New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
  & $mysqld --initialize-insecure "--basedir=$baseDir" "--datadir=$dataDir" --console
  if ($LASTEXITCODE -ne 0) { throw "Unable to initialize the local MySQL data directory." }
}

$arguments = @(
  "--basedir=`"$baseDir`"",
  "--datadir=`"$dataDir`"",
  "--port=$Port",
  "--bind-address=127.0.0.1",
  "--mysqlx=0",
  "--pid-file=`"$(Join-Path $dataDir 'mysqld.pid')`"",
  "--log-error=`"$(Join-Path $dataDir 'mysqld-error.log')`"",
  "--max_allowed_packet=64M"
)
Start-Process -FilePath $mysqld -ArgumentList $arguments -WindowStyle Hidden | Out-Null

for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
  Start-Sleep -Milliseconds 500
  if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    Write-Host "MySQL started on 127.0.0.1:$Port"
    exit 0
  }
}
throw "MySQL did not start. Check data/mysql-dev/mysqld-error.log."
