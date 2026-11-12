param([Parameter(Mandatory=$true)][string]$OpenCodePath)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$testRoot=(New-Item -ItemType Directory -Path (Join-Path $env:TEMP ('pac-bootstrap-'+[guid]::NewGuid().ToString('N')))).FullName
$profile=Join-Path $testRoot 'profile'
$kit=Join-Path $testRoot 'kit'
$keys=Join-Path $testRoot 'keys'
$profileHome=Join-Path $profile '.hapi-servermall'
New-Item -ItemType Directory -Force -Path $profileHome,(Join-Path $kit 'windows'),$keys | Out-Null
foreach($name in @('settings.json','connection.json','machine-token')){[IO.File]::WriteAllText((Join-Path $profileHome $name),'synthetic')}
[IO.File]::WriteAllText((Join-Path $keys 'connection.json'),'{"relayUrl":"wss://example.invalid","pacName":"testpac","controllerCwd":"C:/test"}')
foreach($name in @('pac-source-token.txt','pac-relay-ca.pem')){[IO.File]::WriteAllText((Join-Path $keys $name),'synthetic')}
[IO.File]::WriteAllText((Join-Path $kit 'windows\Install-Runner.ps1'),'# synthetic: never executed')
$runtime=Join-Path $kit 'windows\Runtime.ps1'
[IO.File]::WriteAllText($runtime,"`$env:EXISTING_PROFILE_MARKER='preserved'`r`n")
$previous=$env:USERPROFILE
try {
  $env:USERPROFILE=$profile
  & (Join-Path $root 'windows\Configure-ExistingProvider.ps1') -KitPath $kit -KeysPath $keys -OpenCodePath $OpenCodePath
  . $runtime
  if($env:EXISTING_PROFILE_MARKER -ne 'preserved' -or $env:PAC_NAME -ne 'testpac' -or $env:PAC_NAMED_PROVIDERS_EXPERIMENT -ne '1'){throw 'Existing environment or PAC provider configuration was not preserved.'}
  if(Test-Path Env:PAC_DISPLAY_NAME){throw 'Missing optional PAC display name was set to an invalid empty value.'}
  if(!(Test-Path -LiteralPath (Join-Path $profileHome 'pac-bridge\provider-current.json'))){throw 'Provider pointer missing.'}
  $refused=$false
  try { & (Join-Path $root 'windows\Configure-ExistingProvider.ps1') -KitPath $kit -KeysPath $keys -OpenCodePath $OpenCodePath } catch { $refused=$true }
  if(!$refused){throw 'Existing PAC profile must not be overwritten.'}
  Write-Output 'Synthetic existing-profile bootstrap passed.'
} finally { $env:USERPROFILE=$previous }
