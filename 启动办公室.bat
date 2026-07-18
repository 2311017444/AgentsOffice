@echo off
chcp 65001 >nul
cd /d %~dp0
echo [Agent Office] 正在启动协作中枢...
node apps\hub\dist\index.js
pause
