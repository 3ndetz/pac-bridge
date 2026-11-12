[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$KitPath,
  [Parameter(Mandatory=$true)][string]$KeysPath,
  [Parameter(Mandatory=$true)][string]$OpenCodePath
)
$ErrorActionPreference='Stop'
$kit=(Resolve-Path -LiteralPath $KitPath).Path
$keys=(Resolve-Path -LiteralPath $KeysPath).Path
$opencode=(Resolve-Path -LiteralPath $OpenCodePath).Path
$profile=Join-Path $env:USERPROFILE '.hapi-servermall'
$pac=Join-Path $profile 'pac-bridge'
$runtime=Join-Path $kit 'windows\Runtime.ps1'
foreach($name in @('settings.json','connection.json','machine-token')) {
  if(!(Test-Path -LiteralPath (Join-Path $profile $name) -PathType Leaf)){throw 'An existing configured HAPI profile is required.'}
}
foreach($name in @('connection.json','pac-source-token.txt','pac-relay-ca.pem')) {
  if(!(Test-Path -LiteralPath (Join-Path $keys $name) -PathType Leaf)){throw "Missing PAC connection file: $name"}
}
if(Test-Path -LiteralPath $pac){throw 'A PAC profile already exists; use its reviewed migration procedure.'}
if(!(Test-Path -LiteralPath (Join-Path $kit 'windows\Install-Runner.ps1') -PathType Leaf)){throw 'A permanent ServerMallAgents kit is required.'}
$cfg=Get-Content -LiteralPath (Join-Path $keys 'connection.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if($cfg.relayUrl -notmatch '^wss://[^/]+$' -or $cfg.pacName -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$' -or !$cfg.controllerCwd){throw 'Invalid PAC connection settings.'}
if((& $opencode --version).Trim() -ne '1.19.5'){throw 'The verified OpenCode 1.19.5 is required.'}
$portableNode=Join-Path $env:LOCALAPPDATA 'ServermallWorkflow\node'
if(Test-Path -LiteralPath (Join-Path $portableNode 'node.exe') -PathType Leaf){$env:PATH=$portableNode+';'+$env:PATH}
if(!(Get-Command git.exe -ErrorAction SilentlyContinue) -or !(Get-Command npm.cmd -ErrorAction SilentlyContinue) -or (& node.exe --version).Trim() -notmatch '^v24\.'){throw 'Git and Node.js 24 with npm are required.'}
$bash=@((Join-Path $env:LOCALAPPDATA 'Programs\Git\bin\bash.exe'),(Join-Path $env:ProgramFiles 'Git\bin\bash.exe'))
if(!($bash | Where-Object {Test-Path -LiteralPath $_ -PathType Leaf})){throw 'Git Bash is required.'}
New-Item -ItemType Directory -Path $pac | Out-Null
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $pac /inheritance:r /grant:r "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
if($LASTEXITCODE -ne 0){throw 'Failed to protect the PAC profile.'}
foreach($name in @('connection.json','pac-source-token.txt','pac-relay-ca.pem')){Copy-Item -LiteralPath (Join-Path $keys $name) -Destination $pac}
[IO.File]::WriteAllText((Join-Path $pac 'opencode-path.txt'),$opencode,[Text.UTF8Encoding]::new($false))
$environment=@'
$pacHome=Join-Path $env:USERPROFILE '.hapi-servermall\pac-bridge'
$cfg=Get-Content -LiteralPath (Join-Path $pacHome 'connection.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$env:PAC_EXPERIMENTAL='1'
$env:PAC_OPENCODE_BINARY=[IO.File]::ReadAllText((Join-Path $pacHome 'opencode-path.txt')).Trim()
$env:PAC_RELAY_URL=[string]$cfg.relayUrl
$env:PAC_NAME=[string]$cfg.pacName
if ($cfg.displayName) { $env:PAC_DISPLAY_NAME=[string]$cfg.displayName } else { Remove-Item Env:PAC_DISPLAY_NAME -ErrorAction SilentlyContinue }
if ($cfg.modelPrefix) { $env:PAC_MODEL_PREFIX=[string]$cfg.modelPrefix } else { Remove-Item Env:PAC_MODEL_PREFIX -ErrorAction SilentlyContinue }
$env:PAC_CONTROLLER_CWD=[string]$cfg.controllerCwd
$env:PAC_SOURCE_TOKEN_FILE=Join-Path $pacHome 'pac-source-token.txt'
$env:NODE_EXTRA_CA_CERTS=Join-Path $pacHome 'pac-relay-ca.pem'
$env:PAC_SESSION_DIR=Join-Path $pacHome 'bindings'
'@
[IO.File]::WriteAllText((Join-Path $pac 'connection-runtime.ps1'),$environment,[Text.UTF8Encoding]::new($false))
if(Test-Path -LiteralPath $runtime){
  Copy-Item -LiteralPath $runtime -Destination (Join-Path $pac 'runtime-before-connection.ps1')
  $old=[IO.File]::ReadAllText($runtime)
} else {
  $old=''
  [IO.File]::WriteAllText($runtime,'',[Text.UTF8Encoding]::new($false))
}
& (Join-Path $PSScriptRoot 'Install-ProviderMode.ps1') -KitPath $kit -NamedProviders
if($LASTEXITCODE -ne 0){throw 'Provider staging failed.'}
$addition="`r`n# PAC Bridge connection v1`r`n. (Join-Path `$env:USERPROFILE '.hapi-servermall\pac-bridge\connection-runtime.ps1')`r`n"
[IO.File]::WriteAllText($runtime,($old+$addition),[Text.UTF8Encoding]::new($false))
& (Join-Path $PSScriptRoot 'Install-ProviderMode.ps1') -KitPath $kit -Activate -NamedProviders
Write-Output 'PAC provider configured for the next runner start. HAPI and existing sessions were not restarted.'
