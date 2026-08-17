[CmdletBinding()]
param(
  [switch]$KeepCredential,
  [switch]$KeepConfig
)

$ErrorActionPreference = 'Stop'
$stateRoot = Join-Path $env:USERPROFILE '.config\codexzxm'
$configFile = Join-Path $stateRoot 'tunnel-windows.json'
$secretFile = Join-Path $stateRoot 'secrets\control-plane.dpapi'
$legacySecretFile = Join-Path $env:LOCALAPPDATA 'Codexzxm\secrets\control-plane.dpapi'
$startupDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$launcher = Join-Path $startupDir 'Codexzxm-Tunnel.vbs'

Remove-Item -LiteralPath $launcher -Force -ErrorAction SilentlyContinue
if (-not $KeepCredential) {
  Remove-Item -LiteralPath $secretFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $legacySecretFile -Force -ErrorAction SilentlyContinue
}
if (-not $KeepConfig) { Remove-Item -LiteralPath $configFile -Force -ErrorAction SilentlyContinue }

Write-Host 'Codexzxm Windows Startup launcher removed.'
if ($KeepCredential) { Write-Host 'Runtime credential retained.' } else { Write-Host 'Runtime credential removed.' }
if ($KeepConfig) { Write-Host 'Tunnel configuration retained.' } else { Write-Host 'Tunnel configuration removed.' }
