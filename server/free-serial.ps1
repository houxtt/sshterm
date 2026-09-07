# Free a busy serial port by restarting the device (needs admin/UAC).
# Usage: powershell -File free-serial.ps1 -ComPort COM27
param([string]$ComPort = '')
$ErrorActionPreference = 'Stop'
if (-not $ComPort) { Write-Output 'ERR: no port'; exit 1 }
$portName = $ComPort.ToUpper()
if ($portName -notmatch '^COM\d+$') { Write-Output "ERR: invalid port $ComPort"; exit 1 }
$pattern = "\($([regex]::Escape($portName))\)$"
$matches = @(Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match $pattern })
if ($matches.Count -ne 1) {
  Write-Output "ERR: expected exactly one device for $portName, found $($matches.Count)"
  exit 2
}
$dev = $matches[0]
$devId = $dev.PNPDeviceID
Write-Output "Device: $($dev.Name) ($devId)"
Disable-PnpDevice -InstanceId $devId -Confirm:$false -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800
Enable-PnpDevice -InstanceId $devId -Confirm:$false -ErrorAction Stop
Write-Output 'OK: device restarted'
exit 0
