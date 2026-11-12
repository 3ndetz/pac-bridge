param([switch]$LegacyLayout)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$testRoot=(New-Item -ItemType Directory -Path (Join-Path $env:TEMP ('pac-install-'+[guid]::NewGuid().ToString('N')))).FullName
$testProfile=Join-Path $testRoot 'profile'
$kit=Join-Path $testRoot 'kit'
$pac=Join-Path $testProfile '.hapi-servermall\pac-bridge'
New-Item -ItemType Directory -Force -Path $pac,(Join-Path $kit 'windows') | Out-Null
foreach($path in @((Join-Path $testProfile '.hapi-servermall\settings.json'),(Join-Path $testProfile '.hapi-servermall\connection.json'))) {
  [IO.File]::WriteAllText($path,'synthetic')
}
$names=if($LegacyLayout){@('start-pac-opencode.ps1','source.token','cert.pem')}else{@('connection.json','opencode-path.txt','pac-source-token.txt','pac-relay-ca.pem')}
foreach($name in $names){[IO.File]::WriteAllText((Join-Path $pac $name),'synthetic')}
$runtime=Join-Path $kit 'windows\Runtime.ps1'
[IO.File]::WriteAllText($runtime,"`$env:PAC_EXPERIMENTAL='1'`r`n")
$previousProfile=$env:USERPROFILE
try {
  $env:USERPROFILE=$testProfile
  & (Join-Path $root 'windows\Install-ProviderMode.ps1') -KitPath $kit
  if(([IO.File]::ReadAllText($runtime)).Contains('PAC Bridge provider loader v1')){throw 'Staging changed the active runtime.'}
  & (Join-Path $root 'windows\Install-ProviderMode.ps1') -KitPath $kit -Activate -NamedProviders -LegacyMigration
  $record=Get-Content -LiteralPath (Join-Path $pac 'provider-current.json') -Raw | ConvertFrom-Json
  . $runtime
  $command=Join-Path $pac ('provider-versions/'+$record.revision+'/bin/opencode.cmd')
  $versionDir=Join-Path $pac ('provider-versions/'+$record.revision)
  foreach($dependency in @('ws','yaml','zod','minimatch')) {
    if(!(Test-Path -LiteralPath (Join-Path $versionDir ('node_modules/'+$dependency+'/package.json')) -PathType Leaf)){throw 'Source provider dependency is missing.'}
  }
  if(Test-Path -LiteralPath (Join-Path $versionDir 'node_modules/@anthropic-ai')){throw 'Controller-only Claude dependencies must not be installed on the source.'}
  if($env:PAC_HAPI_PROVIDER_EXPERIMENT -ne '1' -or !(Test-Path -LiteralPath $command -PathType Leaf)){throw 'Provider environment is incomplete.'}
  if($env:PAC_NAMED_PROVIDERS_EXPERIMENT -ne '1' -or $env:PAC_LEGACY_MIGRATION_EXPERIMENT -ne '1'){throw 'Provider migration settings were not retained.'}
  $wrapper=[IO.File]::ReadAllText($command)
  if(!$wrapper.Contains($record.revision)){throw 'Wrapper does not reference the immutable provider directory.'}
  if(!$wrapper.Contains('provider-dispatch.mjs')){throw 'The installed wrapper must follow future provider versions.'}
  & (Join-Path $root 'windows\Install-ProviderMode.ps1') -KitPath $kit -Activate -NamedProviders -LegacyMigration
  if(([regex]::Matches([IO.File]::ReadAllText($runtime),'PAC Bridge provider loader v1')).Count -ne 1){throw 'Provider loader was duplicated.'}
  & (Join-Path $root 'windows\Disable-ProviderMode.ps1') -KitPath $kit
  $restored=[IO.File]::ReadAllText($runtime)
  if($restored.Contains('PAC Bridge provider loader v1') -or !$restored.Contains("`$env:PAC_EXPERIMENTAL='1'")){throw 'Provider disable did not preserve the original runtime.'}
  Write-Output 'Synthetic provider installation and repeated update passed.'
} finally { $env:USERPROFILE=$previousProfile }
