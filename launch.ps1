$ErrorActionPreference = 'SilentlyContinue'
# P3 FIX: 使用相对路径替代硬编码路径
# $PSScriptRoot 是脚本所在目录，自动适配不同机器部署
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $scriptDir) { $scriptDir = Get-Location }  # 兜底: 当前目录

# 尝试找到 node.exe，优先使用 hermes 内置的 node
$hermesNode = 'C:\Users\logic\AppData\Local\hermes\node\node.exe'
if (-not (Test-Path $hermesNode)) {
  # 用环境变量或系统 node 替代
  $envPath = [Environment]::GetEnvironmentVariable('PATH', 'Machine')
  $userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
  $allPaths = ($envPath; $userPath) -join ';'
  $nodePaths = $allPaths -split ';' | Where-Object { $_ -match 'node\.exe$' }
  if ($nodePaths) { $node = $nodePaths[0] }
  else { $node = 'node' }
} else { $node = $hermesNode }

# 脚本和工作目录使用相对路径
$script = Join-Path $scriptDir 'server\index.js'
$workdir = $scriptDir

Start-Process -FilePath $node -ArgumentList $script -WorkingDirectory $workdir -WindowStyle Hidden