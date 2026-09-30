$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $root 'dist\sshterm-setup.exe'
if (-not (Test-Path -LiteralPath $installer)) { throw 'Installer artifact is missing' }

# Never run this test over a user's installed copy of the application.
$uninstallKeys = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$existing = @(Get-ItemProperty $uninstallKeys -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -eq 'sshterm' })
if ($existing.Count) { throw 'Installer smoke test requires no existing sshterm installation' }

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$target = Join-Path $tempRoot ('sshterm-installer-smoke-' + [guid]::NewGuid().ToString('N'))
$target = [IO.Path]::GetFullPath($target)
if (-not $target.StartsWith($tempRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or
    (Test-Path -LiteralPath $target)) { throw 'Unsafe installer test directory' }

$installed = $false
try {
  $setup = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$target") `
    -WindowStyle Hidden -Wait -PassThru
  if ($setup.ExitCode -ne 0) { throw "Installer exited with $($setup.ExitCode)" }
  $installed = $true
  $binary = Join-Path $target 'sshterm.exe'
  if (-not (Test-Path -LiteralPath $binary)) { throw 'Installed sshterm.exe is missing' }
  $env:SSHTERM_SMOKE_HOLD_MS = '1'
  $watch = [Diagnostics.Stopwatch]::StartNew()
  & node (Join-Path $PSScriptRoot 'desktop_smoke.js') $binary
  $watch.Stop()
  if ($LASTEXITCODE -ne 0) { throw 'Installed application smoke test failed' }
  Write-Host "Installed application smoke passed in $([math]::Round($watch.Elapsed.TotalSeconds, 2)) s"
} finally {
  if ($installed) {
    $uninstaller = Join-Path $target 'Uninstall sshterm.exe'
    if (Test-Path -LiteralPath $uninstaller) {
      $remove = Start-Process -FilePath $uninstaller -ArgumentList '/S' `
        -WindowStyle Hidden -Wait -PassThru
      if ($remove.ExitCode -ne 0) { throw "Test uninstaller exited with $($remove.ExitCode)" }
    }
  }
  if (Test-Path -LiteralPath $target) {
    if (@(Get-ChildItem -LiteralPath $target -Force).Count -ne 0) {
      throw "Test installation left files in $target"
    }
    Remove-Item -LiteralPath $target -Force
  }
}
