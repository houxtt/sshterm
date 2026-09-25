$ErrorActionPreference = 'Stop'

$appRoot = Split-Path -Parent $PSScriptRoot
$payloadPath = Join-Path $appRoot 'runtime\node-runtime.gz'
$runtimeDir = Join-Path $appRoot 'runtime\bin'
$runtimePath = Join-Path $runtimeDir 'sshterm-node.exe'
$serverScript = Join-Path $PSScriptRoot 'index.js'

function Restore-NodeRuntime {
  if (-not (Test-Path -LiteralPath $payloadPath)) {
    throw "Packaged Node runtime payload not found: $payloadPath"
  }

  New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
  $tempRuntime = "$runtimePath.$PID.tmp"
  $inputStream = $null
  $gzipStream = $null
  $outputStream = $null

  try {
    $inputStream = [System.IO.File]::OpenRead($payloadPath)
    $gzipStream = New-Object System.IO.Compression.GZipStream(
      $inputStream,
      [System.IO.Compression.CompressionMode]::Decompress
    )
    $outputStream = [System.IO.File]::Create($tempRuntime)
    $gzipStream.CopyTo($outputStream)
  } finally {
    if ($null -ne $outputStream) { $outputStream.Dispose() }
    if ($null -ne $gzipStream) { $gzipStream.Dispose() }
    if ($null -ne $inputStream) { $inputStream.Dispose() }
  }

  Move-Item -LiteralPath $tempRuntime -Destination $runtimePath -Force
}

if (-not (Test-Path -LiteralPath $runtimePath) -or
    (Get-Item -LiteralPath $runtimePath).Length -lt 1MB) {
  Restore-NodeRuntime
}

& $runtimePath $serverScript @args
exit $LASTEXITCODE
