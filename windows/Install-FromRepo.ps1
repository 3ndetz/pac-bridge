[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$KitPath,
  [Parameter(Mandatory=$true)][string]$KeysPath,
  [Parameter(Mandatory=$true)][string]$OpenCodePath,
  [string]$HapiBinaryPath = ''
)
$ErrorActionPreference = 'Stop'
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$hash = [string]$manifest.hapiSha256
if ($hash -notmatch '^[a-f0-9]{64}$') { throw 'Invalid reviewed HAPI checksum.' }
if (!$HapiBinaryPath) {
  $downloadDir = Join-Path $env:LOCALAPPDATA 'PAC-Bridge\downloads'
  New-Item -ItemType Directory -Path $downloadDir -Force | Out-Null
  $HapiBinaryPath = Join-Path $downloadDir ('hapi-'+$hash+'.exe')
  if (!(Test-Path -LiteralPath $HapiBinaryPath -PathType Leaf)) {
    $temporary = Join-Path $downloadDir ([guid]::NewGuid().ToString()+'.download')
    $url = 'https://github.com/3ndetz/pac-bridge/releases/download/windows-preview-ffd08bd/hapi-pac.exe'
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $temporary -TimeoutSec 300
    if ((Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash) { throw 'Downloaded HAPI checksum mismatch.' }
    Move-Item -LiteralPath $temporary -Destination $HapiBinaryPath
  }
}
if ((Get-FileHash -LiteralPath $HapiBinaryPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash) { throw 'HAPI checksum mismatch.' }
& (Join-Path $PSScriptRoot 'Install-PacRunner.ps1') -KitPath $KitPath -KeysPath $KeysPath -OpenCodePath $OpenCodePath -HapiBinaryPath $HapiBinaryPath
