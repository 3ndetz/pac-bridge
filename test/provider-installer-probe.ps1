$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$testRoot=(New-Item -ItemType Directory -Path (Join-Path $env:TEMP ('pac-install-'+[guid]::NewGuid().ToString('N')))).FullName
$testProfile=Join-Path $testRoot 'profile'
$kit=Join-Path $testRoot 'kit'
$pac=Join-Path $testProfile '.hapi-servermall\pac-bridge'
New-Item -ItemType Directory -Force -Path $pac,(Join-Path $kit 'windows') | Out-Null
foreach($path in @((Join-Path $testProfile '.hapi-servermall\settings.json'),(Join-Path $testProfile '.hapi-servermall\connection.json'),(Join-Path $pac 'connection.json'),(Join-Path $pac 'opencode-path.txt'),(Join-Path $pac 'pac-source-token.txt'),(Join-Path $pac 'pac-relay-ca.pem'))) {
  [IO.File]::WriteAllText($path,'synthetic')
}
$runtime=Join-Path $kit 'windows\Runtime.ps1'
[IO.File]::WriteAllText($runtime,"`$env:PAC_EXPERIMENTAL='1'`r`n")
$previousProfile=$env:USERPROFILE
try {
  $env:USERPROFILE=$testProfile
  & (Join-Path $root 'windows\Install-ProviderMode.ps1') -KitPath $kit
  if(([IO.File]::ReadAllText($runtime)).Contains('PAC Bridge provider loader v1')){throw 'Staging changed the active runtime.'}
  & (Join-Path $root 'windows\Install-ProviderMode.ps1') -KitPath $kit -Activate
  $record=Get-Content -LiteralPath (Join-Path $pac 'provider-current.json') -Raw | ConvertFrom-Json
  . $runtime
  $command=Join-Path $pac ('provider-versions/'+$record.revision+'/bin/opencode.cmd')
  if($env:PAC_HAPI_PROVIDER_EXPERIMENT -ne '1' -or !(Test-Path -LiteralPath $command -PathType Leaf)){throw 'Provider environment is incomplete.'}
  $wrapper=[IO.File]::ReadAllText($command)
  if(!$wrapper.Contains($record.revision)){throw 'Wrapper does not reference the immutable provider directory.'}
  & (Join-Path $root 'windows\Install-ProviderMode.ps1') -KitPath $kit -Activate
  if(([regex]::Matches([IO.File]::ReadAllText($runtime),'PAC Bridge provider loader v1')).Count -ne 1){throw 'Provider loader was duplicated.'}
  & (Join-Path $root 'windows\Disable-ProviderMode.ps1') -KitPath $kit
  $restored=[IO.File]::ReadAllText($runtime)
  if($restored.Contains('PAC Bridge provider loader v1') -or !$restored.Contains("`$env:PAC_EXPERIMENTAL='1'")){throw 'Provider disable did not preserve the original runtime.'}
  Write-Output 'Synthetic provider installation and repeated update passed.'
} finally { $env:USERPROFILE=$previousProfile }
