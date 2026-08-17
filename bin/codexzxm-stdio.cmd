@echo off
setlocal
node "%~dp0..\scripts\codexzxm-launch.mjs" stdio
exit /b %ERRORLEVEL%
