param(
  [string]$TaskName = "WhatsAppSalesAI-LocalStack"
)

$ErrorActionPreference = "Stop"
$watchScript = Join-Path $PSScriptRoot "start-local-stack.ps1"
$powerShellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
$action = New-ScheduledTaskAction -Execute $powerShellPath -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchScript`" -Monitor"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Starts and monitors WhatsApp Sales AI, local Qwen and project MySQL after logon." -Force | Out-Null
Write-Output "Installed startup task: $TaskName"
