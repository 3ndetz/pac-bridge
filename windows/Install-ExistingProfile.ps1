[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$KitPath,
  [Parameter(Mandatory=$true)][string]$KeysPath,
  [Parameter(Mandatory=$true)][string]$OpenCodePath,
  [Parameter(Mandatory=$true)][string]$HapiBinaryPath
)
$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $PSScriptRoot
$kit = (Resolve-Path -LiteralPath $KitPath).Path
$keys = (Resolve-Path -LiteralPath $KeysPath).Path
$openCode = (Resolve-Path -LiteralPath $OpenCodePath).Path
$binary = (Resolve-Path -LiteralPath $HapiBinaryPath).Path
$hapiProfile = Join-Path $env:USERPROFILE '.hapi-servermall'
$pac = Join-Path $hapiProfile 'pac-bridge'
$runtime = Join-Path $kit 'windows\Runtime.ps1'
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$release = Get-Content -LiteralPath (Join-Path $kit 'runtime-release.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($release.hapiVersion -ne $manifest.hapiVersion -or !(Test-Path -LiteralPath (Join-Path $kit 'windows\Resolve-RuntimePin.ps1') -PathType Leaf)) { throw 'A compatible managed kit with runtime pin support is required.' }
foreach ($name in @('connection.json','pac-source-token.txt','pac-relay-ca.pem')) {
  if (!(Test-Path -LiteralPath (Join-Path $keys $name) -PathType Leaf)) { throw "Missing private connection file: $name" }
}
foreach ($name in @('connection.json','settings.json','machine-token')) {
  if (!(Test-Path -LiteralPath (Join-Path $hapiProfile $name) -PathType Leaf)) { throw "Existing HAPI profile is incomplete: $name" }
}
if ((Test-Path -LiteralPath $pac) -or (Test-Path -LiteralPath $runtime) -or (Test-Path -LiteralPath (Join-Path $hapiProfile 'runtime-user-pin.json'))) { throw 'An existing PAC or local runtime configuration requires a reviewed merge.' }
if ((Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.hapiSha256) { throw 'PAC HAPI runtime checksum mismatch.' }
if ((& $binary --version) -notmatch ('hapi version: '+[regex]::Escape([string]$manifest.hapiVersion)+'(?:\s|$)')) { throw 'PAC HAPI runtime version mismatch.' }
if ((& $openCode --version).Trim() -ne $manifest.openCodeVersion) { throw 'The verified OpenCode version is required.' }
if (!(Get-Command node.exe -ErrorAction SilentlyContinue) -or !(Get-Command npm.cmd -ErrorAction SilentlyContinue) -or (& node.exe --version).Trim() -notmatch '^v24\.') { throw 'Node.js 24 and npm are required.' }
$bashCandidates = @((Join-Path $env:LOCALAPPDATA 'Programs\Git\bin\bash.exe'), (Join-Path $env:ProgramFiles 'Git\bin\bash.exe'))
if (!($bashCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })) { throw 'Git Bash is required in its standard installation location.' }
$existing = Get-Content -LiteralPath (Join-Path $hapiProfile 'connection.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$cfg = Get-Content -LiteralPath (Join-Path $keys 'connection.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($existing.publicUrl -notmatch '^https://[^/]+/workflow/[1-9][0-9]*/$' -or $cfg.relayUrl -notmatch '^wss://[^/]+$' -or $cfg.pacName -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$' -or !$cfg.controllerCwd) { throw 'Invalid existing hub or PAC connection settings.' }
$cfg.hapiUrl = [string]$existing.publicUrl
New-Item -ItemType Directory -Path $pac | Out-Null
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $pac /inheritance:r /grant:r "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to protect the PAC profile.' }
if (Test-Path -LiteralPath (Join-Path $hapiProfile 'runtime-cli.json')) { Copy-Item -LiteralPath (Join-Path $hapiProfile 'runtime-cli.json') -Destination (Join-Path $pac 'previous-runtime-cli.json') }
$installed = Join-Path $pac 'source'
New-Item -ItemType Directory -Path $installed | Out-Null
Get-ChildItem -LiteralPath $sourceRoot -Force | Where-Object { $_.Name -notin @('.git','node_modules','hapi-pac.exe') } | Copy-Item -Destination $installed -Recurse
foreach ($name in @('pac-source-token.txt','pac-relay-ca.pem')) { Copy-Item -LiteralPath (Join-Path $keys $name) -Destination $pac }
[IO.File]::WriteAllText((Join-Path $pac 'connection.json'), ($cfg|ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $pac 'opencode-path.txt'), $openCode, [Text.UTF8Encoding]::new($false))
Push-Location $installed
try {
  & npm.cmd ci --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'PAC Bridge dependency installation failed.' }
  & node.exe adapters/install-hapi-command.mjs (Join-Path $pac 'bin')
  if ($LASTEXITCODE -ne 0) { throw 'OpenCode wrapper installation failed.' }
} finally { Pop-Location }
# Reuse the reviewed environment template used by the fresh-profile installer.
$installer = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Install-PacRunner.ps1'))
$match = [regex]::Match($installer, "(?s)\`$runtimeText=@'\r?\n(.*?)\r?\n'@")
if (!$match.Success) { throw 'The reviewed runtime environment template is unavailable.' }
[IO.File]::WriteAllText($runtime, $match.Groups[1].Value, [Text.UTF8Encoding]::new($false))
$destination = Join-Path $hapiProfile ('runtime-fixes/'+$manifest.hapiSha256+'/hapi.exe')
New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
if (!(Test-Path -LiteralPath $destination)) { Copy-Item -LiteralPath $binary -Destination $destination }
if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.hapiSha256) { throw 'Installed PAC runtime checksum mismatch.' }
$pin = Join-Path $hapiProfile 'runtime-user-pin.json'
[IO.File]::WriteAllText(($pin+'.new'), (@{baseVersion=[string]$manifest.hapiVersion;sha256=[string]$manifest.hapiSha256}|ConvertTo-Json), [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath ($pin+'.new') -Destination $pin -Force
& (Join-Path $kit 'windows\Install-RuntimeFix.ps1') -BinaryPath $binary -ExpectedSha256 ([string]$manifest.hapiSha256)
& (Join-Path $kit 'windows\Verify-Connection.ps1')
Write-Output 'PAC Bridge was integrated with the existing HAPI profile. Verify models and a real turn.'
