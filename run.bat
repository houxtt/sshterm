@echo off
chcp 65001 >nul
cd /d %~dp0
where node >nul 2>nul || (echo Node.js is required for source mode. & pause & exit /b 1)
if not exist node_modules (call npm ci || (pause & exit /b 1))
call npm start
