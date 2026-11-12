[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$KitPath, [switch]$Activate, [switch]$NamedProviders, [switch]$LegacyMigration)
$ErrorActionPreference='Stop'
if($LegacyMigration -and !$NamedProviders){throw 'Legacy migration requires named PAC providers.'}
$source=Split-Path -Parent $PSScriptRoot
$kit=(Resolve-Path -LiteralPath $KitPath).Path
$runtime=Join-Path $kit 'windows\Runtime.ps1'
$profileHome=Join-Path $env:USERPROFILE '.hapi-servermall'
$pac=Join-Path $profileHome 'pac-bridge'
foreach($path in @($runtime,(Join-Path $profileHome 'settings.json'),(Join-Path $profileHome 'connection.json'))) {
  if(!(Test-Path -LiteralPath $path -PathType Leaf)){throw 'An existing configured HAPI/PAC profile and local Runtime.ps1 are required.'}
}
$modern=@('connection.json','opencode-path.txt','pac-source-token.txt','pac-relay-ca.pem')
$legacy=@('start-pac-opencode.ps1','source.token','cert.pem')
$hasModern=@($modern | Where-Object { !(Test-Path -LiteralPath (Join-Path $pac $_) -PathType Leaf) }).Count -eq 0
$hasLegacy=@($legacy | Where-Object { !(Test-Path -LiteralPath (Join-Path $pac $_) -PathType Leaf) }).Count -eq 0
if(!$hasModern -and !$hasLegacy){throw 'The existing PAC connection files are incomplete or use an unsupported layout.'}
$portableNode=Join-Path $env:LOCALAPPDATA 'ServermallWorkflow\node'
if(Test-Path -LiteralPath (Join-Path $portableNode 'node.exe') -PathType Leaf){$env:PATH=$portableNode+';'+$env:PATH}
if(!(Get-Command git.exe -ErrorAction SilentlyContinue) -or !(Get-Command npm.cmd -ErrorAction SilentlyContinue) -or !(Get-Command node.exe -ErrorAction SilentlyContinue)){throw 'Git, Node.js and npm are required.'}
if((& node.exe --version).Trim() -notmatch '^v24\.'){throw 'Node.js 24 is required.'}
Push-Location -LiteralPath $source
try {
  $revision=(& git.exe rev-parse HEAD).Trim()
  if($LASTEXITCODE -ne 0 -or $revision -cnotmatch '^[0-9a-f]{40}$'){throw 'A Git checkout with a valid commit is required.'}
  & git.exe diff --quiet HEAD -- adapters src package.json package-lock.json
  if($LASTEXITCODE -ne 0){throw 'Commit or discard source changes before installing; the revision must match the files.'}
  $files=@(& git.exe ls-files -- adapters src package.json package-lock.json)
  if($LASTEXITCODE -ne 0 -or !$files.Count){throw 'Could not list tracked source files.'}
  $versions=Join-Path $pac 'provider-versions'
  $target=Join-Path $versions $revision
  New-Item -ItemType Directory -Path $versions -Force | Out-Null
  if(!(Test-Path -LiteralPath $target)) {
    $stage=Join-Path $versions ('.stage-'+[guid]::NewGuid().ToString())
    New-Item -ItemType Directory -Path $stage | Out-Null
    foreach($file in $files){
      if([IO.Path]::IsPathRooted($file) -or $file -match '(^|[\\/])\.\.([\\/]|$)'){throw 'Unsafe tracked path.'}
      $dest=Join-Path $stage $file
      New-Item -ItemType Directory -Path (Split-Path $dest -Parent) -Force | Out-Null
      Copy-Item -LiteralPath (Join-Path $source $file) -Destination $dest
    }
    Push-Location -LiteralPath $stage
    try {
      & npm.cmd ci --omit=dev --no-audit --no-fund
      if($LASTEXITCODE -ne 0){throw 'PAC Bridge dependency installation failed.'}
      & node.exe adapters/install-hapi-command.mjs (Join-Path $stage 'bin')
      if($LASTEXITCODE -ne 0){throw 'OpenCode wrapper installation failed.'}
    } finally {Pop-Location}
    # The generated wrapper contains its absolute source path; generate it
    # after moving to the final immutable path instead.
    Remove-Item -LiteralPath (Join-Path $stage 'bin\opencode.cmd')
    Remove-Item -LiteralPath (Join-Path $stage 'bin')
    Move-Item -LiteralPath $stage -Destination $target
    & node.exe (Join-Path $target 'adapters\install-hapi-command.mjs') (Join-Path $target 'bin')
    if($LASTEXITCODE -ne 0){throw 'Final OpenCode wrapper installation failed.'}
  }
  if(!(Test-Path -LiteralPath (Join-Path $target 'bin\opencode.cmd') -PathType Leaf)){throw 'Provider version is incomplete; inspect it before retrying.'}
  if(!$Activate) {
    Write-Output 'Provider version staged. The active runtime configuration and runner were not changed.'
    return
  }
  $loader=Join-Path $pac 'provider-runtime.ps1'
  $loaderText=@'
$pacHome=Join-Path $env:USERPROFILE '.hapi-servermall\pac-bridge'
$current=Get-Content -LiteralPath (Join-Path $pacHome 'provider-current.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]$current.revision -cnotmatch '^[0-9a-f]{40}$') { throw 'Invalid PAC provider revision.' }
$version=Join-Path $pacHome ('provider-versions/'+$current.revision)
$wrapper=Join-Path $version 'bin\opencode.cmd'
if (!(Test-Path -LiteralPath $wrapper -PathType Leaf)) { throw 'PAC provider wrapper is missing.' }
$env:PAC_HAPI_PROVIDER_EXPERIMENT='1'
if ($current.namedProviders -eq $true) { $env:PAC_NAMED_PROVIDERS_EXPERIMENT='1' } else { Remove-Item Env:PAC_NAMED_PROVIDERS_EXPERIMENT -ErrorAction SilentlyContinue }
if ($current.legacyMigration -eq $true) { $env:PAC_LEGACY_MIGRATION_EXPERIMENT='1' } else { Remove-Item Env:PAC_LEGACY_MIGRATION_EXPERIMENT -ErrorAction SilentlyContinue }
$env:PATH=(Split-Path $wrapper -Parent)+';'+$env:PATH
$notify=Join-Path $pacHome 'notify\tg-notify.cjs'
if (Test-Path -LiteralPath $notify -PathType Leaf) { $env:PAC_TURN_NOTIFY_SCRIPT=$notify }
'@
  $marker='# PAC Bridge provider loader v1'
  $runtimeText=[IO.File]::ReadAllText($runtime)
  if($runtimeText.Contains($marker) -and !$runtimeText.Contains(". (Join-Path `$env:USERPROFILE '.hapi-servermall\pac-bridge\provider-runtime.ps1')")){throw 'Existing provider loader is not recognized.'}
  [IO.File]::WriteAllText($loader,$loaderText,[Text.UTF8Encoding]::new($false))
  $pointer=Join-Path $pac 'provider-current.json'
  [IO.File]::WriteAllText(($pointer+'.new'),(@{revision=$revision;namedProviders=[bool]$NamedProviders;legacyMigration=[bool]$LegacyMigration}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath ($pointer+'.new') -Destination $pointer -Force
  if(!$runtimeText.Contains($marker)) {
    $backup=Join-Path $pac ('runtime-before-provider-'+[guid]::NewGuid().ToString()+'.ps1')
    Copy-Item -LiteralPath $runtime -Destination $backup
    $addition="`r`n$marker`r`n. (Join-Path `$env:USERPROFILE '.hapi-servermall\pac-bridge\provider-runtime.ps1')`r`n"
    [IO.File]::WriteAllText($runtime,($runtimeText+$addition),[Text.UTF8Encoding]::new($false))
  }
  Write-Output 'Provider mode selected for the next runner start. The current HAPI runner was not restarted or replaced; verify the runtime and migration before restarting.'
} finally {Pop-Location}
