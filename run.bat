@echo off
rem sshterm 启动脚本 — SSH / Telnet / 串口 连接工具
cd /d %~dp0

rem 1. 检查 Node.js
where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未找到 Node.js, 请先安装: https://nodejs.org/
    pause
    exit /b 1
)

rem 2. 检查依赖
if not exist node_modules (
    echo [首次运行] 安装依赖中...
    call npm install --registry=https://registry.npmmirror.com
    if errorlevel 1 (
        echo [错误] 依赖安装失败, 请检查网络后重试
        pause
        exit /b 1
    )
)

rem 3. 启动 (自动打开浏览器)
echo 启动 sshterm... 关闭本窗口将停止服务
node server/index.js
pause
