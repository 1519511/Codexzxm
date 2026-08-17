[CmdletBinding()]
param([string]$InstallDir=(Join-Path $env:LOCALAPPDATA 'Codexzxm'))
$ErrorActionPreference='Stop'
$InstallDir=[System.IO.Path]::GetFullPath($InstallDir)
if(-not (Test-Path -LiteralPath $InstallDir)){Write-Host "Codexzxm is not installed at $InstallDir";exit 0}
$pkg=Join-Path $InstallDir 'package.json'
if(-not (Test-Path -LiteralPath $pkg)){throw "Refusing to remove directory without package.json: $InstallDir"}
$name=(Get-Content -LiteralPath $pkg -Raw | ConvertFrom-Json).name
if($name -ne 'codexzxm'){throw "Refusing to remove non-Codexzxm package '$name': $InstallDir"}
Remove-Item -LiteralPath $InstallDir -Recurse -Force
Write-Host "Codexzxm removed: $InstallDir"
