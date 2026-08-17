@echo off
setlocal
node "%~dp0..\scripts\codexzxm-launch.mjs" http
exit /b %ERRORLEVEL%
