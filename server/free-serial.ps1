# Free a busy serial port by restarting the device (needs admin/UAC).
# Usage: powershell -File free-serial.ps1 -ComPort COM27
param([string]$ComPort = '')
$ErrorActionPreference = 'Stop'
if (-not $ComPort) { Write-Output 'ERR: no port'; exit 1 }
$dev = Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match $ComPort }
if (-not $dev) { Write-Output "ERR: device not found for $ComPort"; exit 1 }
$devId = $dev.PNPDeviceID
Write-Output "Device: $($dev.Name) ($devId)"
Disable-PnpDevice -InstanceId $devId -Confirm:$false -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800
Enable-PnpDevice -InstanceId $devId -Confirm:$false -ErrorAction Stop
Write-Output 'OK: device restarted'
