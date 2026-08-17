@echo off
setlocal
for %%I in ("%~dp0..") do set "CODEXLESS_WORKBENCH_ROOT=%%~fI"
cd /d "%CODEXLESS_WORKBENCH_ROOT%"
if not exist ".workbench" mkdir ".workbench"
set "CODEXLESS_PRIVATE_WORKBENCH=1"
set "CODEXLESS_HOST=127.0.0.1"
set "CODEXLESS_PORT=7691"
set "CODEXLESS_DEFAULT_CWD=%CODEXLESS_WORKBENCH_ROOT%"
set "CODEXLESS_PROFILE=:danger-full-access"
set "CODEXLESS_PRIVATE_MCP_ALLOWLIST=*"
set "CODEXLESS_PRIVATE_MCP_ALLOW_CODEX_APPS=1"
node "%CODEXLESS_WORKBENCH_ROOT%\scripts\workbench-launch.mjs" http >> "%CODEXLESS_WORKBENCH_ROOT%\.workbench\http.log" 2>&1
exit /b %ERRORLEVEL%
