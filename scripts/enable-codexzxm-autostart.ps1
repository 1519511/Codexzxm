[CmdletBinding()]
param(
  [string]$Alias = 'codexzxm',
  [string]$TunnelId = '',
  [string]$ProfileName = '',
  [string]$ProfileDir = '',
  [string]$McpCommand = '',
  [string]$Proxy = '',
  [string]$DefaultCwd = '',
  [string]$PermissionProfile = ':danger-full-access',
  [string]$TunnelClient = '',
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
if (-not $env:OPENAI_API_KEY -or -not $env:OPENAI_API_KEY.StartsWith('sk-')) {
  throw 'OPENAI_API_KEY is not present in this PowerShell process. Set a valid ordinary OpenAI API key in this process, then retry.'
}

$installRoot = Join-Path $env:LOCALAPPDATA 'Codexzxm'
$supervisor = Join-Path $installRoot 'scripts\codexzxm-tunnel-supervisor.ps1'
if (-not (Test-Path -LiteralPath $supervisor)) { throw "Supervisor script is missing: $supervisor" }

$stateRoot = Join-Path $env:USERPROFILE '.config\codexzxm'
$configFile = Join-Path $stateRoot 'tunnel-windows.json'
$secretDir = Join-Path $stateRoot 'secrets'
$secretFile = Join-Path $secretDir 'control-plane.dpapi'
$existing = $null
if (Test-Path -LiteralPath $configFile) {
  try { $existing = [System.IO.File]::ReadAllText($configFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json } catch {}
}

function Pick([string]$Value, [string]$Property, [string]$Fallback = '') {
  if ($Value) { return $Value }
  if ($existing -and $existing.$Property) { return [string]$existing.$Property }
  return $Fallback
}

$Alias = Pick $Alias 'alias' 'codexzxm'
$ProfileName = Pick $ProfileName 'profileName' $Alias
$ProfileDir = Pick $ProfileDir 'profileDir' (Join-Path $stateRoot 'tunnel-profiles')
$McpCommand = Pick $McpCommand 'mcpCommand' (Join-Path $installRoot 'bin\codexzxm-stdio.cmd')
$Proxy = Pick $Proxy 'proxy' ''
$DefaultCwd = Pick $DefaultCwd 'defaultCwd' $env:USERPROFILE
$PermissionProfile = Pick $PermissionProfile 'permissionProfile' ':danger-full-access'
$TunnelClient = Pick $TunnelClient 'tunnelClient' ''
$TunnelId = Pick $TunnelId 'tunnelId' ''

if (-not $TunnelClient) {
  $cmd = Get-Command tunnel-client.exe,tunnel-client -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { $TunnelClient = $cmd.Source }
}
if (-not $TunnelClient -or -not (Test-Path -LiteralPath $TunnelClient)) {
  throw 'tunnel-client executable was not found. Pass -TunnelClient <path> or put tunnel-client on PATH.'
}

if (-not $TunnelId) {
  $oldHttps = $env:HTTPS_PROXY; $oldHttp = $env:HTTP_PROXY; $oldNoProxy = $env:NO_PROXY
  try {
    if ($Proxy) { $env:HTTPS_PROXY=$Proxy; $env:HTTP_PROXY=$Proxy; $env:NO_PROXY='127.0.0.1,localhost' }
    $listedText = (& $TunnelClient runtimes list --json | Out-String)
    if ($LASTEXITCODE -eq 0 -and $listedText) {
      $listed = $listedText | ConvertFrom-Json
      $match = @($listed.aliases) | Where-Object { $_.alias -eq $Alias } | Select-Object -First 1
      if ($match -and $match.tunnel_id) { $TunnelId = [string]$match.tunnel_id }
    }
  } finally {
    if ($null -eq $oldHttps) { Remove-Item Env:HTTPS_PROXY -ErrorAction SilentlyContinue } else { $env:HTTPS_PROXY=$oldHttps }
    if ($null -eq $oldHttp) { Remove-Item Env:HTTP_PROXY -ErrorAction SilentlyContinue } else { $env:HTTP_PROXY=$oldHttp }
    if ($null -eq $oldNoProxy) { Remove-Item Env:NO_PROXY -ErrorAction SilentlyContinue } else { $env:NO_PROXY=$oldNoProxy }
  }
}
if (-not $TunnelId) { throw "No tunnel ID was supplied or discovered for alias '$Alias'. Pass -TunnelId <tunnel_...>." }

New-Item -ItemType Directory -Force $stateRoot,$secretDir,$ProfileDir | Out-Null
$secure = ConvertTo-SecureString $env:OPENAI_API_KEY -AsPlainText -Force
$cipher = ConvertFrom-SecureString $secure
Set-Content -LiteralPath $secretFile -Value $cipher -Encoding ASCII
try {
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls.exe $secretFile '/inheritance:r' ('/grant:r', ('*' + $sid + ':F')) | Out-Null
} catch {}

$config = [ordered]@{
  version = 1
  platform = 'windows'
  alias = $Alias
  tunnelId = $TunnelId
  profileName = $ProfileName
  profileDir = $ProfileDir
  mcpCommand = $McpCommand
  proxy = $Proxy
  defaultCwd = $DefaultCwd
  permissionProfile = $PermissionProfile
  tunnelClient = $TunnelClient
}
$json = $config | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($configFile, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))

$startupDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
New-Item -ItemType Directory -Force $startupDir | Out-Null
$launcher = Join-Path $startupDir 'Codexzxm-Tunnel.vbs'
$escapedSupervisor = $supervisor.Replace('"','""')
$vbs = @"
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""$escapedSupervisor""", 0, False
"@
Set-Content -LiteralPath $launcher -Value $vbs -Encoding ASCII

Write-Host 'Codexzxm Windows tunnel configuration saved outside the install tree.'
Write-Host "Tunnel config: $configFile"
Write-Host "Credential file: $secretFile"
Write-Host "Startup launcher: $launcher"

if (-not $NoStart) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $supervisor -Once -ForceReconnect
  if ($LASTEXITCODE -ne 0) { throw "Supervisor one-shot validation failed with exit code $LASTEXITCODE" }
  Write-Host 'Supervisor forced-reconnect validation completed.'
  & wscript.exe //B //Nologo $launcher
  Write-Host 'Hidden supervisor watchdog launched.'
}
