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
    return $response.StatusCode -eq 200 -and $response.Content -match '<title>sshterm\b'
  } catch {
    return $false
  }
}

function Get-SourceBuildId {
  $sourceFiles = @(
    Get-ChildItem -LiteralPath (Join-Path $scriptDir 'server') -Recurse -File -Filter '*.js'
    Get-Item -LiteralPath (Join-Path $scriptDir 'package.json')
  )
  $latest = ($sourceFiles | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1).LastWriteTimeUtc
  return [DateTimeOffset]::new($latest).ToUnixTimeMilliseconds().ToString()
}

function Get-RunningInfo {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri ($appUrl + 'launcher-info') -TimeoutSec 1
    if ($response.StatusCode -ne 200) { return $null }
    $info = $response.Content | ConvertFrom-Json
    if ($info.app -ne 'sshterm') { return $null }
    return $info
  } catch {
    return $null
  }
}

function Get-ListeningProcessId {
  foreach ($line in (& netstat.exe -ano -p tcp)) {
    if ($line -match '^\s*TCP\s+127\.0\.0\.1:8787\s+\S+\s+LISTENING\s+(\d+)\s*$') {
      return [int]$Matches[1]
    }
  }
  return $null
}

function Stop-StaleServer([object]$info) {
  $processId = if ($null -ne $info -and $info.pid) { [int]$info.pid } else { Get-ListeningProcessId }
  if (-not $processId) { throw 'Cannot identify the stale sshterm server process.' }
  Write-LauncherLog "Source updated; restarting stale server PID $processId."
  Stop-Process -Id $processId -ErrorAction Stop
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 100
    if (-not (Test-SshtermReady)) { return }
  }
  throw "Stale sshterm server PID $processId did not stop."
}

try {
  if (Test-SshtermReady) {
    $sourceBuildId = Get-SourceBuildId
    $runningInfo = Get-RunningInfo
    if ($null -ne $runningInfo -and [string]$runningInfo.buildId -eq $sourceBuildId) {
      Write-LauncherLog 'Server already running with current source; opening browser.'
    } else {
      # Never replace a live server from a second launcher click. Restarting it
      # would discard credentials held only in the server process memory.
      # Updated source is picked up after the user deliberately stops the app.
      Write-LauncherLog 'Server already running; preserving active sessions and opening browser.'
    }
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
  # The server intentionally stays alive after the browser closes. This keeps
  # saved-session credentials in process memory, so restored tabs can reconnect
  # without asking for the password again.
  Start-Process -FilePath $nodePath `
    -ArgumentList @("`"$serverScript`"", '--no-open') `
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
