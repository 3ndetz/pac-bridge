[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$KitPath,
  [Parameter(Mandatory=$true)][string]$KeysPath,
  [Parameter(Mandatory=$true)][string]$OpenCodePath
)
$ErrorActionPreference='Stop'
$sourceRoot=Split-Path -Parent $PSScriptRoot
$kit=(Resolve-Path -LiteralPath $KitPath).Path
$keys=(Resolve-Path -LiteralPath $KeysPath).Path
$opencode=(Resolve-Path -LiteralPath $OpenCodePath).Path
$kitWindows=Join-Path $kit 'windows'
$runtime=Join-Path $kitWindows 'Runtime.ps1'
$homePath=Join-Path $env:USERPROFILE '.hapi-servermall'
$pacPath=Join-Path $homePath 'pac-bridge'
foreach ($file in @('connection.json','hapi-token.txt','pac-source-token.txt','pac-relay-ca.pem')) {
  if (!(Test-Path -LiteralPath (Join-Path $keys $file) -PathType Leaf)) { throw "Missing required key file: $file" }
}
if (!(Test-Path -LiteralPath (Join-Path $kitWindows 'Install-Runner.ps1') -PathType Leaf)) { throw 'The permanent ServerMallAgents kit is required.' }
if (!(Test-Path -LiteralPath (Join-Path $sourceRoot 'package-lock.json') -PathType Leaf)) { throw 'Extract the complete PAC Bridge source archive first.' }
if (!(Test-Path -LiteralPath $opencode -PathType Leaf)) { throw 'OpenCode executable not found.' }
if ((& $opencode --version).Trim() -ne '1.19.5') { throw 'This integration requires the verified OpenCode version 1.19.5.' }
if (!(Get-Command node.exe -ErrorAction SilentlyContinue) -or !(Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'Node.js 24 and npm are required.' }
if ((& node.exe --version).Trim() -notmatch '^v24\.') { throw 'Node.js 24 is required.' }
$bashCandidates=@((Join-Path $env:LOCALAPPDATA 'Programs\Git\bin\bash.exe'),(Join-Path $env:ProgramFiles 'Git\bin\bash.exe'))
if (!($bashCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })) { throw 'Git Bash is required in its standard installation location.' }
if ((Test-Path -LiteralPath $runtime) -or (Test-Path -LiteralPath (Join-Path $homePath 'settings.json')) -or (Test-Path -LiteralPath $pacPath)) {
  throw 'An existing HAPI/PAC configuration was found. Do not overwrite it; follow the upgrade/merge procedure manually.'
}
$config=Get-Content -LiteralPath (Join-Path $keys 'connection.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($config.hapiUrl -notmatch '^https://[^/]+/workflow/1/$' -or $config.relayUrl -notmatch '^wss://[^/]+$' -or $config.pacName -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$' -or !$config.controllerCwd) { throw 'Invalid private connection settings.' }
New-Item -ItemType Directory -Path $pacPath -Force | Out-Null
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $homePath /inheritance:r /grant:r "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to protect HAPI credentials.' }
$installed=Join-Path $pacPath 'source'
New-Item -ItemType Directory -Path $installed | Out-Null
Get-ChildItem -LiteralPath $sourceRoot -Force | Where-Object { $_.Name -notin @('.git','node_modules') } | Copy-Item -Destination $installed -Recurse
foreach ($file in @('connection.json','pac-source-token.txt','pac-relay-ca.pem')) { Copy-Item -LiteralPath (Join-Path $keys $file) -Destination $pacPath }
[IO.File]::WriteAllText((Join-Path $pacPath 'opencode-path.txt'),$opencode,[Text.UTF8Encoding]::new($false))
Push-Location $installed
try {
  & npm.cmd ci --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'PAC Bridge dependency installation failed.' }
  & node.exe adapters/install-hapi-command.mjs (Join-Path $pacPath 'bin')
  if ($LASTEXITCODE -ne 0) { throw 'OpenCode wrapper installation failed.' }
} finally { Pop-Location }
$runtimeText=@'
# Local PAC Bridge environment. Kept across ServerMallAgents kit updates.
$pacHome=Join-Path $env:USERPROFILE '.hapi-servermall\pac-bridge'
$cfg=Get-Content -LiteralPath (Join-Path $pacHome 'connection.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$env:PAC_EXPERIMENTAL='1'
$env:PAC_OPENCODE_BINARY=[IO.File]::ReadAllText((Join-Path $pacHome 'opencode-path.txt')).Trim()
$env:PAC_RELAY_URL=[string]$cfg.relayUrl
$env:PAC_NAME=[string]$cfg.pacName
$env:PAC_DISPLAY_NAME=[string]$cfg.displayName
$env:PAC_MODEL_PREFIX=[string]$cfg.modelPrefix
$env:PAC_CONTROLLER_CWD=[string]$cfg.controllerCwd
$env:PAC_SOURCE_TOKEN_FILE=Join-Path $pacHome 'pac-source-token.txt'
$env:NODE_EXTRA_CA_CERTS=Join-Path $pacHome 'pac-relay-ca.pem'
$env:PAC_SESSION_DIR=Join-Path $pacHome 'bindings'
$env:PATH=(Join-Path $pacHome 'bin')+';'+$env:PATH
'@
[IO.File]::WriteAllText($runtime,$runtimeText,[Text.UTF8Encoding]::new($false))
& (Join-Path $kitWindows 'Install-Runner.ps1') -TokenFile (Join-Path $keys 'hapi-token.txt') -PublicUrl ([string]$config.hapiUrl)
Write-Output 'Runner installation finished. Verify model discovery and a real PAC turn in the existing HAPI hub.'
