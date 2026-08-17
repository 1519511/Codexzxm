[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Alias,
  [string]$Description=''
)
$ErrorActionPreference='Stop'
if($Alias -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'){throw 'Alias must be 1-64 characters using letters, numbers, dot, underscore, or hyphen.'}
$stateRoot=Join-Path $env:USERPROFILE '.config\codexzxm\secrets-v1'
New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null
$secretFile=Join-Path $stateRoot ($Alias+'.dpapi')
$indexFile=Join-Path $stateRoot 'index.json'
$secure=Read-Host "Secret value for $Alias" -AsSecureString
$cipher=ConvertFrom-SecureString $secure
[System.IO.File]::WriteAllText($secretFile,$cipher+[Environment]::NewLine,[System.Text.Encoding]::ASCII)
try{
  $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls.exe $secretFile '/inheritance:r' ('/grant:r',('*'+$sid+':F')) | Out-Null
}catch{}
$index=[ordered]@{version=1;secrets=@()}
if(Test-Path -LiteralPath $indexFile){
  try{$index=[System.IO.File]::ReadAllText($indexFile,[System.Text.Encoding]::UTF8)|ConvertFrom-Json}catch{throw "Secret index is corrupt: $indexFile"}
}
$now=(Get-Date).ToUniversalTime().ToString('o')
$existing=@($index.secrets)|Where-Object{$_.alias -eq $Alias}|Select-Object -First 1
$createdAt=if($existing -and $existing.createdAt){$existing.createdAt}else{$now}
$kept=@($index.secrets)|Where-Object{$_.alias -ne $Alias}
$record=[ordered]@{alias=$Alias;provider='windows-dpapi-file';description=$Description;createdAt=$createdAt;updatedAt=$now;locator=[ordered]@{file=$secretFile}}
$payload=[ordered]@{version=1;secrets=@($kept)+@($record)}
$json=$payload|ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($indexFile,$json+[Environment]::NewLine,(New-Object System.Text.UTF8Encoding($false)))
try{
  $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls.exe $indexFile '/inheritance:r' ('/grant:r',('*'+$sid+':F')) | Out-Null
}catch{}
Write-Host "Stored permanent secretRef '$Alias' with Windows DPAPI."
Write-Host "Metadata index: $indexFile"
Write-Host 'Plaintext was not written to the metadata index.'
