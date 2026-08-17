[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$SecretFile)
$ErrorActionPreference='Stop'
$cipher=([System.IO.File]::ReadAllText($SecretFile,[System.Text.Encoding]::ASCII)).Trim()
if(-not $cipher){throw 'DPAPI secret file is empty'}
$secure=ConvertTo-SecureString $cipher
$ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try{
  $plain=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  [Console]::Out.Write($plain)
}finally{
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
}
