$ErrorActionPreference='Stop'
$sourceRoot=Split-Path -Parent $PSScriptRoot
$realUser=$env:USERPROFILE
$binary=$env:PAC_TEST_HAPI_BINARY
if (!$binary) { throw 'Set PAC_TEST_HAPI_BINARY to the reviewed executable.' }
$tempRoot=(Get-Item -LiteralPath (Join-Path $realUser 'AppData\Local\Temp')).FullName
$root=Join-Path $tempRoot ('pac-existing-install-test-'+[guid]::NewGuid().ToString('N'))
$kit=Join-Path $root 'kit';$keys=Join-Path $root 'keys';$env:USERPROFILE=Join-Path $root 'profile'
$profile=Join-Path $env:USERPROFILE '.hapi-servermall'
New-Item -ItemType Directory -Path (Join-Path $kit 'windows'),$keys,$profile -Force|Out-Null
'{"hapiVersion":"0.34.4"}'|Set-Content -Encoding UTF8 (Join-Path $kit 'runtime-release.json')
'# synthetic kit capability'|Set-Content -Encoding UTF8 (Join-Path $kit 'windows\Resolve-RuntimePin.ps1')
'{"publicUrl":"https://example.test/workflow/4/","relayPort":1234}'|Set-Content -Encoding UTF8 (Join-Path $profile 'connection.json')
'{"machineId":"existing-id"}'|Set-Content -Encoding UTF8 (Join-Path $profile 'settings.json')
'synthetic'|Set-Content -Encoding UTF8 (Join-Path $profile 'machine-token')
'{"sha256":"old-pointer"}'|Set-Content -Encoding UTF8 (Join-Path $profile 'runtime-cli.json')
'{"hapiUrl":"https://example.test/workflow/1/","relayUrl":"wss://example.test:1234","pacName":"testpac","controllerCwd":"C:\\test","displayName":"#1","modelPrefix":"Claude"}'|Set-Content -Encoding UTF8 (Join-Path $keys 'connection.json')
foreach($name in @('pac-source-token.txt','pac-relay-ca.pem')){'synthetic'|Set-Content -Encoding UTF8 (Join-Path $keys $name)}
@'
param($BinaryPath,$ExpectedSha256)
if ((Get-FileHash -LiteralPath $BinaryPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedSha256) { throw 'Wrong runtime selected' }
. (Join-Path $PSScriptRoot 'Runtime.ps1')
if ($env:PAC_NAME -ne 'testpac' -or !(Test-Path -LiteralPath $env:PAC_SOURCE_TOKEN_FILE)) { throw 'Runtime environment is incomplete' }
'@ | Set-Content -Encoding UTF8 (Join-Path $kit 'windows\Install-RuntimeFix.ps1')
'Write-Output "Synthetic connection verified."'|Set-Content -Encoding UTF8 (Join-Path $kit 'windows\Verify-Connection.ps1')
try {
  & (Join-Path $sourceRoot 'windows\Install-ExistingProfile.ps1') -KitPath $kit -KeysPath $keys -OpenCodePath (Join-Path $realUser '.local\bin\opencode.exe') -HapiBinaryPath $binary
  $installed=Get-Content -LiteralPath (Join-Path $profile 'pac-bridge\connection.json') -Raw -Encoding UTF8|ConvertFrom-Json
  $original=Get-Content -LiteralPath (Join-Path $profile 'settings.json') -Raw -Encoding UTF8|ConvertFrom-Json
  if($installed.hapiUrl -ne 'https://example.test/workflow/4/' -or $original.machineId -ne 'existing-id'){throw 'Existing profile identity was not preserved'}
  if(!(Test-Path -LiteralPath (Join-Path $profile 'runtime-user-pin.json')) -or !(Test-Path -LiteralPath (Join-Path $profile 'pac-bridge\previous-runtime-cli.json'))){throw 'Missing pin or runtime backup'}
  try { & (Join-Path $sourceRoot 'windows\Install-ExistingProfile.ps1') -KitPath $kit -KeysPath $keys -OpenCodePath (Join-Path $realUser '.local\bin\opencode.exe') -HapiBinaryPath $binary; throw 'Unexpected second install' } catch {if($_.Exception.Message -notmatch 'reviewed merge'){throw}}
  Write-Output 'Existing profile integration and repeat protection passed.'
} finally { $env:USERPROFILE=$realUser }
