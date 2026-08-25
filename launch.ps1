param(
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverScript = Join-Path $scriptDir 'server\index.js'
$appUrl = 'http://127.0.0.1:8787/'
$logDir = Join-Path $env:USERPROFILE '.sshterm\logs'
$launcherLog = Join-Path $logDir 'launcher.log'
$stdoutLog = Join-Path $logDir 'server-stdout.log'
$stderrLog = Join-Path $logDir 'server-stderr.log'

function Write-LauncherLog([string]$message) {
  try {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    Add-Content -LiteralPath $launcherLog -Encoding UTF8 -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $message"
  } catch {
    # Logging must never prevent the application from starting.
  }
}

function Test-SshtermReady {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $appUrl -TimeoutSec 1
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

try {
  if (Test-SshtermReady) {
    Write-LauncherLog 'Server already running; opening browser.'
    if (-not $NoBrowser) { Start-Process $appUrl }
    exit 0
  }

  if (-not (Test-Path -LiteralPath $serverScript)) {
    throw "Server script not found: $serverScript"
  }

  $nodeCommand = Get-Command node.exe -ErrorAction Stop
  $nodePath = $nodeCommand.Source
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
  Write-LauncherLog "Using Node: $nodePath"

  # Keep Node hidden and redirect output so startup failures remain diagnosable.
  # --auto-exit stops the server after all browser clients have disconnected.
  Start-Process -FilePath $nodePath `
    -ArgumentList @("`"$serverScript`"", '--no-open', '--auto-exit') `
    -WorkingDirectory $scriptDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog

  $ready = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    if (Test-SshtermReady) { $ready = $true; break }
  }
  if (-not $ready) {
    throw "Server was not ready within 10 seconds; inspect $stderrLog"
  }

  Write-LauncherLog 'Server started successfully.'
  if (-not $NoBrowser) { Start-Process $appUrl }
  exit 0
} catch {
  Write-LauncherLog "Startup failed: $($_.Exception.Message)"
  exit 1
}
