@echo off
chcp 65001 >nul
cd /d %~dp0

rem 1. check Node.js
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found, install: https://nodejs.org/
    pause
    exit /b 1
)

rem 2. check deps
if not exist node_modules (
    echo [FIRST RUN] installing dependencies...
    call npm install --registry=https://registry.npmmirror.com
    if errorlevel 1 (
        echo [ERROR] npm install failed
        pause
        exit /b 1
    )
)

rem 3. already running?
curl -s -m 2 http://127.0.0.1:8787/launcher-info 2>nul | findstr /C:"sshterm" >nul
if not errorlevel 1 (
    start http://127.0.0.1:8787
    exit /b 0
)

rem 4. start (pass through args like --auto-exit)
node server/index.js %*
pause
