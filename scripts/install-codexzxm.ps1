[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "Codexzxm"),
  [switch]$Json
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$SourceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$ParentDir = Split-Path -Parent $InstallDir
$StageDir = Join-Path $ParentDir ("Codexzxm-stage-" + [guid]::NewGuid().ToString("N"))
$BackupDir = $null
function Invoke-Checked([string]$Command, [string[]]$Arguments) {
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Command failed ($LASTEXITCODE): $Command $($Arguments -join ' ')" }
}
function Copy-Tree([string]$From,[string]$To) {
  New-Item -ItemType Directory -Force -Path $To | Out-Null
  foreach($entry in @('src','config','scripts','bin','package.json','npm-shrinkwrap.json','LICENSE','THIRD_PARTY_NOTICES.md','SECURITY.md','README.md')) {
    $source=Join-Path $From $entry
    if(-not (Test-Path -LiteralPath $source)){ throw "Missing Codexzxm release entry: $entry" }
    Copy-Item -LiteralPath $source -Destination (Join-Path $To $entry) -Recurse -Force
  }
}
try {
  if($env:OS -ne 'Windows_NT'){ throw 'Codexzxm installer currently supports Windows only.' }
  $node=(Get-Command node.exe,node -ErrorAction SilentlyContinue | Select-Object -First 1).Source
  $npm=(Get-Command npm.cmd,npm -ErrorAction SilentlyContinue | Select-Object -First 1).Source
  if(-not $node -or -not $npm){ throw 'Node.js/npm were not found on PATH.' }
  $nodeVersion=(& $node -p "process.versions.node").Trim()
  if([int]($nodeVersion.Split('.')[0]) -lt 22){ throw "Codexzxm requires Node.js 22+. Current: v$nodeVersion" }
  New-Item -ItemType Directory -Force -Path $ParentDir | Out-Null
  Copy-Tree $SourceRoot $StageDir
  Push-Location $StageDir
  try {
    Invoke-Checked $npm @('ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund')
    Invoke-Checked $node @('--check','src/public-runtime.mjs')
    Invoke-Checked $node @('--check','src/workbench-tools.mjs')
    $identity = & $node -e "import('./src/surface-contracts.mjs').then(m=>console.log(JSON.stringify({surface:m.PRIVATE_WORKBENCH_SURFACE_VERSION,tools:m.PUBLIC_TOOL_NAMES.length+m.PRIVATE_WORKBENCH_TOOL_NAMES.length})))"
    if($LASTEXITCODE -ne 0){ throw 'Codexzxm runtime identity validation failed.' }
  } finally { Pop-Location }
  if(Test-Path -LiteralPath $InstallDir){
    $pkg=Join-Path $InstallDir 'package.json'
    if(-not (Test-Path -LiteralPath $pkg)){ throw "Refusing to replace non-Codexzxm directory: $InstallDir" }
    $name=(Get-Content -LiteralPath $pkg -Raw | ConvertFrom-Json).name
    if($name -ne 'codexzxm'){ throw "Refusing to replace package '$name' at $InstallDir" }
    $BackupDir=Join-Path $ParentDir ("Codexzxm-backup-"+[guid]::NewGuid().ToString('N'))
    Move-Item -LiteralPath $InstallDir -Destination $BackupDir
  }
  try {
    Move-Item -LiteralPath $StageDir -Destination $InstallDir
    if($BackupDir -and (Test-Path -LiteralPath $BackupDir)){
      foreach($entry in @('secrets','state')){
        $preserved=Join-Path $BackupDir $entry
        $destination=Join-Path $InstallDir $entry
        if(Test-Path -LiteralPath $preserved){
          if(Test-Path -LiteralPath $destination){ throw "Upgrade preservation collision for $entry at $destination" }
          Move-Item -LiteralPath $preserved -Destination $destination
        }
      }
    }
  }
  catch {
    if(Test-Path -LiteralPath $InstallDir){ Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue }
    if($BackupDir -and (Test-Path -LiteralPath $BackupDir)){ Move-Item -LiteralPath $BackupDir -Destination $InstallDir }
    throw
  }
  if($BackupDir -and (Test-Path $BackupDir)){ Remove-Item $BackupDir -Recurse -Force }
  $package=Get-Content (Join-Path $InstallDir 'package.json') -Raw | ConvertFrom-Json
  $result=[ordered]@{ok=$true;name='Codexzxm';version=$package.version;installDir=$InstallDir;stdio=(Join-Path $InstallDir 'bin\codexzxm-stdio.cmd');http=(Join-Path $InstallDir 'bin\codexzxm-http.cmd');identity=($identity|Out-String).Trim()}
  if($Json){$result|ConvertTo-Json -Depth 5}else{Write-Host "Codexzxm installed: $($package.version)";Write-Host "Location: $InstallDir";Write-Host "STDIO: $($result.stdio)";Write-Host "HTTP: $($result.http)"}
} catch {
  if(Test-Path $StageDir){Remove-Item $StageDir -Recurse -Force -ErrorAction SilentlyContinue}
  if($BackupDir -and (Test-Path $BackupDir) -and -not (Test-Path $InstallDir)){Move-Item $BackupDir $InstallDir -ErrorAction SilentlyContinue}
  if($Json){[ordered]@{ok=$false;error=$_.Exception.Message}|ConvertTo-Json}else{Write-Error $_.Exception.Message}
  exit 1
}
