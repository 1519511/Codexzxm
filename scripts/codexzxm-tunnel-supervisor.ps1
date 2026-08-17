param(
  [switch]$Once,
  [switch]$StatusOnly,
  [switch]$ForceReconnect,
  [int]$IntervalSeconds = 30,
  [int]$ProxyWaitSeconds = 600
)

$ErrorActionPreference = 'Stop'
$StateRoot = Join-Path $env:USERPROFILE '.config\codexzxm'
$ConfigFile = if ($env:CODEXZXM_TUNNEL_CONFIG) { $env:CODEXZXM_TUNNEL_CONFIG } else { Join-Path $StateRoot 'tunnel-windows.json' }
$SecretFile = Join-Path $StateRoot 'secrets\control-plane.dpapi'
$LegacySecretFile = Join-Path $env:LOCALAPPDATA 'Codexzxm\secrets\control-plane.dpapi'
$SupervisorStateDir = Join-Path $StateRoot 'supervisor'
$LogFile = Join-Path $SupervisorStateDir 'tunnel-supervisor.log'
$MutexName = 'Local\CodexzxmTunnelSupervisor'

New-Item -ItemType Directory -Force $SupervisorStateDir | Out-Null

function Write-SupervisorLog([string]$Message) {
  try {
    if (Test-Path $LogFile) {
      $info = Get-Item $LogFile -ErrorAction SilentlyContinue
      if ($info -and $info.Length -gt 1048576) { Move-Item $LogFile ($LogFile + '.1') -Force -ErrorAction SilentlyContinue }
    }
    Add-Content -Path $LogFile -Value ((Get-Date).ToString('s') + ' ' + $Message) -Encoding UTF8
  } catch {}
}

function Read-TunnelConfig {
  if (-not (Test-Path -LiteralPath $ConfigFile)) { throw "Codexzxm tunnel config is missing: $ConfigFile. Run enable-codexzxm-autostart.ps1 first." }
  $cfg = [System.IO.File]::ReadAllText($ConfigFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  foreach ($field in @('alias','tunnelId','profileName','profileDir','mcpCommand')) {
    if (-not $cfg.$field) { throw "Codexzxm tunnel config is missing required field: $field" }
  }
  return $cfg
}

function Resolve-TunnelClient($Config) {
  foreach ($candidate in @($env:CODEXZXM_TUNNEL_CLIENT, $Config.tunnelClient)) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return (Resolve-Path -LiteralPath $candidate).Path }
  }
  $onPath = Get-Command tunnel-client.exe,tunnel-client -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($onPath) { return $onPath.Source }
  throw 'tunnel-client executable was not found. Set CODEXZXM_TUNNEL_CLIENT or tunnelClient in the local tunnel config, or put tunnel-client on PATH.'
}

function Resolve-SecretFile {
  if (Test-Path -LiteralPath $SecretFile) { return $SecretFile }
  if (Test-Path -LiteralPath $LegacySecretFile) { return $LegacySecretFile }
  throw "DPAPI runtime credential is missing: $SecretFile"
}

function Read-DpapiSecret {
  $path = Resolve-SecretFile
  $cipherText = (Get-Content -LiteralPath $path -Raw).Trim()
  if (-not $cipherText) { throw 'DPAPI runtime credential file is empty' }
  $secure = ConvertTo-SecureString $cipherText
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    if (-not $plain -or -not $plain.StartsWith('sk-')) { throw 'DPAPI runtime credential did not decode to an OpenAI API key' }
    return $plain
  } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Test-TcpEndpoint([string]$HostName, [int]$Port, [int]$TimeoutMs = 1000) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect($HostName, $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) { return $false }
    $client.EndConnect($async)
    return $true
  } catch { return $false } finally { $client.Dispose() }
}

function Wait-ForProxy([string]$ProxyUrl) {
  if (-not $ProxyUrl) { return $true }
  try { $uri = [Uri]$ProxyUrl } catch { return $true }
  $deadline = (Get-Date).AddSeconds([Math]::Max(0, $ProxyWaitSeconds))
  do {
    if (Test-TcpEndpoint $uri.Host $uri.Port) { return $true }
    if ($Once -or (Get-Date) -ge $deadline) { return $false }
    Start-Sleep -Seconds 5
  } while ($true)
}

function Get-HealthUrlFile($Config) {
  return Join-Path $env:USERPROFILE ('.local\state\tunnel-client\health\' + $Config.alias + '.url')
}

function Get-RuntimeStatus($Config) {
  $baseUrl = $null
  $healthUrlFile = Get-HealthUrlFile $Config
  try { if (Test-Path $healthUrlFile) { $baseUrl = (Get-Content $healthUrlFile -Raw).Trim() } } catch {}
  if (-not $baseUrl) { return [PSCustomObject]@{ running=$false; ready=$false; healthUrl=$null } }
  try {
    $health = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 ($baseUrl.TrimEnd('/') + '/healthz')
    $ready = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 ($baseUrl.TrimEnd('/') + '/readyz')
    return [PSCustomObject]@{ running=($health.StatusCode -eq 200); ready=($ready.StatusCode -eq 200); healthUrl=$baseUrl }
  } catch { return [PSCustomObject]@{ running=$false; ready=$false; healthUrl=$baseUrl } }
}

function Repair-TunnelProfile($Config) {
  $profilePath = Join-Path $Config.profileDir ($Config.profileName + '.yaml')
  New-Item -ItemType Directory -Force $Config.profileDir | Out-Null
  $payload = [ordered]@{
    admin_ui=[ordered]@{open_browser=$false}; config_version=1
    control_plane=[ordered]@{api_key='env:OPENAI_API_KEY';base_url='https://api.openai.com';tunnel_id=$Config.tunnelId}
    health=[ordered]@{listen_addr='127.0.0.1:0';url_file=(Get-HealthUrlFile $Config)}
    log=[ordered]@{format='json';level='info'}
    mcp=[ordered]@{commands=@([ordered]@{channel='main';command=$Config.mcpCommand})}
  }
  if ($Config.proxy) { $payload.http_proxy = $Config.proxy }
  $json = $payload | ConvertTo-Json -Depth 8
  [System.IO.File]::WriteAllText($profilePath, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
  return $profilePath
}

function Apply-RuntimeEnvironment($Config) {
  $env:OPENAI_API_KEY = $script:RuntimeKey
  if ($Config.proxy) { $env:HTTPS_PROXY=$Config.proxy; $env:HTTP_PROXY=$Config.proxy; $env:NO_PROXY='127.0.0.1,localhost' }
  if ($Config.defaultCwd) { $env:CODEXZXM_DEFAULT_CWD=$Config.defaultCwd }
  if ($Config.permissionProfile) { $env:CODEXZXM_PROFILE=$Config.permissionProfile }
}

function Clear-RuntimeEnvironment {
  foreach ($name in @('OPENAI_API_KEY','CODEXZXM_DEFAULT_CWD','CODEXZXM_PROFILE')) { Remove-Item ('Env:' + $name) -ErrorAction SilentlyContinue }
}

function Ensure-Runtime([string]$Exe, $Config) {
  $status = Get-RuntimeStatus $Config
  if ($ForceReconnect -and $status.running) {
    try { $null = & $Exe runtimes stop $Config.alias --json 2>$null; Write-SupervisorLog 'forced stale runtime stop requested'; Start-Sleep -Seconds 1 } catch { Write-SupervisorLog ('forced runtime stop error: ' + $_.Exception.Message) }
    $status = Get-RuntimeStatus $Config
  }
  if (-not $ForceReconnect -and $status.running -and $status.ready) { return [PSCustomObject]@{Changed=$false;Running=$true;Ready=$true} }
  if (-not (Wait-ForProxy $Config.proxy)) { Write-SupervisorLog ('proxy unavailable: ' + $Config.proxy); return [PSCustomObject]@{Changed=$false;Running=$false;Ready=$false} }
  Apply-RuntimeEnvironment $Config
  try {
    $null = & $Exe runtimes connect --alias $Config.alias --tunnel-id $Config.tunnelId --runtime-api-key 'env:OPENAI_API_KEY' --profile $Config.profileName --profile-dir $Config.profileDir --mcp-command $Config.mcpCommand --json 2>$null
    if ($LASTEXITCODE -ne 0) { Write-SupervisorLog "runtimes connect failed with exit code $LASTEXITCODE"; return [PSCustomObject]@{Changed=$true;Running=$false;Ready=$false} }
    $null = Repair-TunnelProfile $Config
  } finally { Clear-RuntimeEnvironment }
  Start-Sleep -Seconds 2
  $after = Get-RuntimeStatus $Config
  $ok = $after.running -and $after.ready
  Write-SupervisorLog ('runtime reconnect ' + $(if($ok){'succeeded'}else{'did not become ready'}))
  return [PSCustomObject]@{Changed=$true;Running=[bool]$after.running;Ready=[bool]$after.ready}
}

$mutex = New-Object System.Threading.Mutex($false, $MutexName)
$ownsMutex = $false
try {
  $ownsMutex = $mutex.WaitOne(0, $false)
  if (-not $ownsMutex) { exit 0 }
  $config = Read-TunnelConfig
  $exe = Resolve-TunnelClient $config
  $profilePath = Join-Path $config.profileDir ($config.profileName + '.yaml')
  if ($StatusOnly) {
    $status = Get-RuntimeStatus $config
    [PSCustomObject]@{alias=$config.alias;profile=$profilePath;tunnelId=$config.tunnelId;runtimeRunning=[bool]$status.running;runtimeReady=[bool]$status.ready;credentialPresent=((Test-Path $SecretFile) -or (Test-Path $LegacySecretFile));proxy=$config.proxy;config=$ConfigFile} | ConvertTo-Json
    exit 0
  }
  $script:RuntimeKey = Read-DpapiSecret
  Write-SupervisorLog 'supervisor started'
  do {
    try { $null = Ensure-Runtime $exe $config } catch { Write-SupervisorLog ('ensure runtime error: ' + $_.Exception.Message) }
    if ($Once) { break }
    Start-Sleep -Seconds ([Math]::Max(10, $IntervalSeconds))
  } while ($true)
} finally {
  Clear-RuntimeEnvironment
  $script:RuntimeKey = $null
  if ($ownsMutex) { try { $mutex.ReleaseMutex() } catch {} }
  $mutex.Dispose()
}
