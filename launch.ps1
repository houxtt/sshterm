$ErrorActionPreference = 'SilentlyContinue'
$node = 'C:\Users\logic\AppData\Local\hermes\node\node.exe'
$script = 'C:\tools\sshterm\server\index.js'
$workdir = 'C:\tools\sshterm'
if (-not (Test-Path $node)) { $node = 'node' }
Start-Process -FilePath $node -ArgumentList $script -WorkingDirectory $workdir -WindowStyle Hidden
