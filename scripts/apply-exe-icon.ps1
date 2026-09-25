param(
  [Parameter(Mandatory = $true)][string]$ExecutablePath,
  [Parameter(Mandatory = $true)][string]$IconPath
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class IconResources {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr BeginUpdateResource(string fileName, bool deleteExisting);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool UpdateResource(IntPtr handle, IntPtr type, IntPtr name,
    ushort language, byte[] data, uint size);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool EndUpdateResource(IntPtr handle, bool discard);
}
'@

$exe = (Resolve-Path -LiteralPath $ExecutablePath).Path
$ico = [System.IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $IconPath).Path)
if ($ico.Length -lt 22 -or [BitConverter]::ToUInt16($ico, 0) -ne 0 -or
    [BitConverter]::ToUInt16($ico, 2) -ne 1) {
  throw "Invalid ICO file: $IconPath"
}
$count = [BitConverter]::ToUInt16($ico, 4)
if ($count -lt 1 -or $count -gt 20 -or $ico.Length -lt 6 + 16 * $count) {
  throw "Invalid ICO image count: $count"
}

$groupStream = New-Object System.IO.MemoryStream
$group = New-Object System.IO.BinaryWriter($groupStream)
$group.Write([uint16]0)
$group.Write([uint16]1)
$group.Write([uint16]$count)

$handle = [IconResources]::BeginUpdateResource($exe, $false)
if ($handle -eq [IntPtr]::Zero) {
  throw "BeginUpdateResource failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}
$completed = $false
try {
  for ($i = 0; $i -lt $count; $i++) {
    $entry = 6 + 16 * $i
    $size = [BitConverter]::ToUInt32($ico, $entry + 8)
    $offset = [BitConverter]::ToUInt32($ico, $entry + 12)
    if ($size -eq 0 -or [uint64]$offset + [uint64]$size -gt $ico.Length) {
      throw "Invalid ICO image entry: $i"
    }
    $image = New-Object byte[] $size
    [Array]::Copy($ico, [int]$offset, $image, 0, [int]$size)
    $id = 101 + $i
    if (-not [IconResources]::UpdateResource($handle, [IntPtr]3, [IntPtr]$id,
        [uint16]0, $image, [uint32]$size)) {
      throw "UpdateResource icon $id failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }

    $group.Write([byte]$ico[$entry])
    $group.Write([byte]$ico[$entry + 1])
    $group.Write([byte]$ico[$entry + 2])
    $group.Write([byte]$ico[$entry + 3])
    $group.Write([uint16][BitConverter]::ToUInt16($ico, $entry + 4))
    $group.Write([uint16][BitConverter]::ToUInt16($ico, $entry + 6))
    $group.Write([uint32]$size)
    $group.Write([uint16]$id)
  }

  $group.Flush()
  $groupBytes = $groupStream.ToArray()
  if (-not [IconResources]::UpdateResource($handle, [IntPtr]14, [IntPtr]1,
      [uint16]0, $groupBytes, [uint32]$groupBytes.Length)) {
    throw "UpdateResource icon group failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }
  if (-not [IconResources]::EndUpdateResource($handle, $false)) {
    throw "EndUpdateResource failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }
  $completed = $true
} finally {
  if (-not $completed) { [void][IconResources]::EndUpdateResource($handle, $true) }
  $group.Dispose()
  $groupStream.Dispose()
}
Write-Output "Embedded $count icon sizes into $exe"
