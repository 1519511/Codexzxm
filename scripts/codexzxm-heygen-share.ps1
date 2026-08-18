[CmdletBinding()]
param(
  [ValidateSet('Start','Status','Stop')]
  [string]$Action = 'Status',
  [string[]]$Path = @(),
  [ValidateRange(1,120)]
  [int]$LeaseMinutes = 30,
  [switch]$Replace
)

$ErrorActionPreference = 'Stop'
$StateRoot = Join-Path $env:USERPROFILE '.config\codexzxm\ephemeral-share\heygen'
$ActiveFile = Join-Path $StateRoot 'active.json'
$ServerScript = Join-Path $env:LOCALAPPDATA 'Codexzxm\scripts\codexzxm-ephemeral-share-server.mjs'

function Read-JsonFile([string]$File) {
  if (-not (Test-Path -LiteralPath $File)) { return $null }
  try { return [System.IO.File]::ReadAllText($File, [System.Text.Encoding]::UTF8) | ConvertFrom-Json } catch { return $null }
}

function Test-ProcessId([int]$ProcessId) {
  if ($ProcessId -le 0) { return $false }
  return [bool](Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Write-JsonFile([string]$File, $Value) {
  $dir = Split-Path -Parent $File
  New-Item -ItemType Directory -Force $dir | Out-Null
  $tmp = $File + '.tmp'
  $json = $Value | ConvertTo-Json -Depth 8
  [System.IO.File]::WriteAllText($tmp, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tmp -Destination $File -Force
}

function Stop-Session($State, [string]$Reason = 'stopped') {
  if (-not $State) { return }
  foreach ($pidValue in @([int]$State.cloudflaredPid, [int]$State.serverPid)) {
    if ($pidValue -gt 0) { Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue }
  }
  $State.status = $Reason
  $stoppedAt = (Get-Date).ToString('o')
  if ($State.PSObject.Properties['stoppedAt']) { $State.stoppedAt = $stoppedAt } else { $State | Add-Member -NotePropertyName stoppedAt -NotePropertyValue $stoppedAt }
  Write-JsonFile $ActiveFile $State
}

function Get-ContentType([string]$FilePath) {
  switch ([System.IO.Path]::GetExtension($FilePath).ToLowerInvariant()) {
    '.png'  { return 'image/png' }
    '.jpg'  { return 'image/jpeg' }
    '.jpeg' { return 'image/jpeg' }
    '.webp' { return 'image/webp' }
    '.gif'  { return 'image/gif' }
    '.mp4'  { return 'video/mp4' }
    '.webm' { return 'video/webm' }
    '.mov'  { return 'video/quicktime' }
    '.m4a'  { return 'audio/mp4' }
    '.mp3'  { return 'audio/mpeg' }
    '.wav'  { return 'audio/wav' }
    default { return 'application/octet-stream' }
  }
}

New-Item -ItemType Directory -Force $StateRoot | Out-Null
$existing = Read-JsonFile $ActiveFile

if ($Action -eq 'Stop') {
  if ($existing) { Stop-Session $existing 'stopped' }
  [PSCustomObject]@{ status='stopped'; active=$false; stateFile=$ActiveFile } | ConvertTo-Json -Depth 5
  exit 0
}

if ($Action -eq 'Status') {
  if (-not $existing) {
    [PSCustomObject]@{ status='none'; active=$false; stateFile=$ActiveFile } | ConvertTo-Json -Depth 5
    exit 0
  }
  $expires = [DateTimeOffset]::Parse([string]$existing.expiresAt)
  $serverRunning = Test-ProcessId ([int]$existing.serverPid)
  $tunnelRunning = Test-ProcessId ([int]$existing.cloudflaredPid)
  $active = $serverRunning -and $tunnelRunning -and ([DateTimeOffset]::Now -lt $expires)
  if (-not $active -and $existing.status -eq 'active') {
    Stop-Session $existing $(if ([DateTimeOffset]::Now -ge $expires) { 'expired' } else { 'failed' })
    $existing = Read-JsonFile $ActiveFile
  }
  [PSCustomObject]@{
    status=$existing.status
    active=$active
    sessionId=$existing.sessionId
    startedAt=$existing.startedAt
    expiresAt=$existing.expiresAt
    serverRunning=$serverRunning
    tunnelRunning=$tunnelRunning
    assets=$existing.assets
    stateFile=$ActiveFile
  } | ConvertTo-Json -Depth 8
  exit 0
}

if ($Action -ne 'Start') { throw "Unsupported action: $Action" }
if (-not $Path -or $Path.Count -eq 0) { throw 'Start requires at least one -Path.' }
if (-not (Test-Path -LiteralPath $ServerScript)) { throw "Installed asset server is missing: $ServerScript" }

if ($existing -and $existing.status -eq 'active') {
  $existingServer = Test-ProcessId ([int]$existing.serverPid)
  $existingTunnel = Test-ProcessId ([int]$existing.cloudflaredPid)
  if (($existingServer -or $existingTunnel) -and -not $Replace) {
    throw "An active HeyGen share already exists. Run -Action Status, -Action Stop, or use -Replace."
  }
  Stop-Session $existing 'replaced'
}

$node = (Get-Command node.exe,node -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $node) { throw 'Node.js was not found on PATH.' }

$tunnelConfig = Join-Path $env:USERPROFILE '.config\codexzxm\tunnel-windows.json'
$cfg = Read-JsonFile $tunnelConfig
$cloudflared = $null
if ($cfg -and $cfg.tunnelClient) {
  $candidate = Join-Path (Split-Path -Parent ([string]$cfg.tunnelClient)) 'cloudflared.exe'
  if (Test-Path -LiteralPath $candidate) { $cloudflared = $candidate }
}
if (-not $cloudflared) {
  $cmd = Get-Command cloudflared.exe,cloudflared -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { $cloudflared = $cmd.Source }
}
if (-not $cloudflared -or -not (Test-Path -LiteralPath $cloudflared)) {
  throw 'cloudflared was not found. Codexzxm normally reuses the cloudflared.exe bundled next to tunnel-client.'
}

$resolved = @()
foreach ($item in $Path) {
  $full = [System.IO.Path]::GetFullPath($item)
  $info = Get-Item -LiteralPath $full -ErrorAction Stop
  if ($info.PSIsContainer) { throw "Directories cannot be shared: $full" }
  $resolved += [PSCustomObject]@{ path=$full; contentType=(Get-ContentType $full); size=[int64]$info.Length }
}

$sessionId = [guid]::NewGuid().ToString('N')
$sessionDir = Join-Path $StateRoot $sessionId
New-Item -ItemType Directory -Force $sessionDir | Out-Null
$manifestFile = Join-Path $sessionDir 'manifest.json'
$serverStateFile = Join-Path $sessionDir 'server-state.json'
$serverOut = Join-Path $sessionDir 'server.out.log'
$serverErr = Join-Path $sessionDir 'server.err.log'
$cloudflaredLog = Join-Path $sessionDir 'cloudflared.log'
$cloudflaredOut = Join-Path $sessionDir 'cloudflared.out.log'
$cloudflaredErr = Join-Path $sessionDir 'cloudflared.err.log'

Write-JsonFile $manifestFile ([ordered]@{ files=@($resolved | ForEach-Object { [ordered]@{path=$_.path;contentType=$_.contentType} }) })
$serverProcess = Start-Process $node -ArgumentList @($ServerScript,$manifestFile,$serverStateFile) -RedirectStandardOutput $serverOut -RedirectStandardError $serverErr -WindowStyle Hidden -PassThru

$serverDeadline = (Get-Date).AddSeconds(10)
do {
  if (Test-Path -LiteralPath $serverStateFile) { break }
  if ($serverProcess.HasExited) { throw "Ephemeral file server exited early. See $serverErr" }
  Start-Sleep -Milliseconds 100
} while ((Get-Date) -lt $serverDeadline)
if (-not (Test-Path -LiteralPath $serverStateFile)) {
  Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
  throw 'Ephemeral file server did not become ready.'
}
$serverState = Read-JsonFile $serverStateFile
$localBase = 'http://127.0.0.1:' + [int]$serverState.port

$cloudflaredProcess = Start-Process $cloudflared -ArgumentList @('tunnel','--url',$localBase,'--no-autoupdate','--loglevel','info','--logfile',$cloudflaredLog) -RedirectStandardOutput $cloudflaredOut -RedirectStandardError $cloudflaredErr -WindowStyle Hidden -PassThru
$tunnelDeadline = (Get-Date).AddSeconds(30)
$publicBase = $null
do {
  Start-Sleep -Milliseconds 250
  $text = ''
  foreach ($file in @($cloudflaredLog,$cloudflaredOut,$cloudflaredErr)) {
    if (Test-Path -LiteralPath $file) {
      try { $text += (Get-Content -LiteralPath $file -Raw -ErrorAction SilentlyContinue) } catch {}
    }
  }
  $match = [regex]::Match($text, 'https://[a-z0-9-]+\.trycloudflare\.com')
  if ($match.Success) { $publicBase = $match.Value; break }
  if ($cloudflaredProcess.HasExited) { break }
} while ((Get-Date) -lt $tunnelDeadline)

if (-not $publicBase) {
  Stop-Process -Id $cloudflaredProcess.Id -Force -ErrorAction SilentlyContinue
  Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
  throw "Cloudflare Quick Tunnel did not produce a public URL. See $cloudflaredLog"
}

$startedAt = [DateTimeOffset]::Now
$expiresAt = $startedAt.AddMinutes($LeaseMinutes)
$assets = @()
foreach ($asset in @($serverState.assets)) {
  $source = $resolved | Where-Object { $_.path -eq [string]$asset.path } | Select-Object -First 1
  $assets += [ordered]@{
    path = [string]$asset.path
    size = [int64]$asset.size
    contentType = [string]$asset.contentType
    url = $publicBase + [string]$asset.route
  }
}

$state = [ordered]@{
  version=1
  status='active'
  sessionId=$sessionId
  startedAt=$startedAt.ToString('o')
  expiresAt=$expiresAt.ToString('o')
  serverPid=[int]$serverProcess.Id
  cloudflaredPid=[int]$cloudflaredProcess.Id
  publicBase=$publicBase
  assets=$assets
  sessionDir=$sessionDir
}
Write-JsonFile $ActiveFile $state

$cleanupScript = Join-Path $sessionDir 'cleanup.ps1'
$cleanup = @"
Start-Sleep -Seconds $([int]($LeaseMinutes * 60))
`$activeFile = '$($ActiveFile.Replace("'","''"))'
if (Test-Path -LiteralPath `$activeFile) {
  try {
    `$s = [IO.File]::ReadAllText(`$activeFile,[Text.Encoding]::UTF8) | ConvertFrom-Json
    if (`$s.sessionId -eq '$sessionId' -and `$s.status -eq 'active') {
      Stop-Process -Id ([int]`$s.cloudflaredPid) -Force -ErrorAction SilentlyContinue
      Stop-Process -Id ([int]`$s.serverPid) -Force -ErrorAction SilentlyContinue
      `$s.status='expired'; `$stoppedAt=(Get-Date).ToString('o'); if (`$s.PSObject.Properties['stoppedAt']) { `$s.stoppedAt=`$stoppedAt } else { `$s | Add-Member -NotePropertyName stoppedAt -NotePropertyValue `$stoppedAt }
      [IO.File]::WriteAllText(`$activeFile,((`$s|ConvertTo-Json -Depth 8)+[Environment]::NewLine),(New-Object Text.UTF8Encoding(`$false)))
    }
  } catch {}
}
"@
[System.IO.File]::WriteAllText($cleanupScript, $cleanup, (New-Object System.Text.UTF8Encoding($false)))
Start-Process powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$cleanupScript) -WindowStyle Hidden | Out-Null

[PSCustomObject]@{
  status='active'
  sessionId=$sessionId
  startedAt=$startedAt.ToString('o')
  expiresAt=$expiresAt.ToString('o')
  leaseMinutes=$LeaseMinutes
  publicBase=$publicBase
  assets=$assets
  privacy='Anyone with an unguessable URL can fetch the asset until this share is stopped or expires. No directory listing is exposed.'
  stopCommand='powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Action Stop'
} | ConvertTo-Json -Depth 8
