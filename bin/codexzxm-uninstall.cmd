@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\scripts\uninstall-codexzxm.ps1" %*
exit /b %ERRORLEVEL%
