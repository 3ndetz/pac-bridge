$ErrorActionPreference='Stop'
$sourceRoot=Split-Path -Parent $PSScriptRoot
$realUser=$env:USERPROFILE
$hapiBinary=$env:PAC_TEST_HAPI_BINARY
if (!$hapiBinary) { throw 'Set PAC_TEST_HAPI_BINARY to the reviewed PAC HAPI executable.' }
$tempRoot=(Get-Item -LiteralPath (Join-Path $realUser 'AppData\Local\Temp')).FullName
$root=Join-Path $tempRoot ('pac-install-proof-'+[guid]::NewGuid().ToString())
$kit=Join-Path $root 'kit'
$keys=Join-Path $root 'keys'
$env:USERPROFILE=Join-Path $root 'profile'
New-Item -ItemType Directory -Path (Join-Path $kit 'windows'),$keys,$env:USERPROFILE -Force | Out-Null
'{"hapiVersion":"0.34.4"}' | Set-Content -Encoding UTF8 (Join-Path $kit 'runtime-release.json')
'# Synthetic kit capability' | Set-Content -Encoding UTF8 (Join-Path $kit 'windows\Resolve-RuntimePin.ps1')
'{"hapiUrl":"https://example.test/workflow/1/","relayUrl":"wss://example.test:1234","pacName":"testpac","controllerCwd":"C:\\test","displayName":"#1","modelPrefix":"Claude"}' | Set-Content -Encoding UTF8 (Join-Path $keys 'connection.json')
foreach($name in @('hapi-token.txt','pac-source-token.txt','pac-relay-ca.pem')) { Set-Content -LiteralPath (Join-Path $keys $name) -Value 'synthetic' }
@'
param($TokenFile,$PublicUrl)
. (Join-Path $PSScriptRoot 'Runtime.ps1')
if ($PublicUrl -ne 'https://example.test/workflow/1/' -or $env:PAC_NAME -ne 'testpac' -or !(Test-Path $env:PAC_SOURCE_TOKEN_FILE) -or !(Test-Path $env:PAC_OPENCODE_BINARY)) { throw 'Runner did not receive expected configuration' }
Write-Output 'Synthetic runner received PAC settings.'
'@ | Set-Content -Encoding UTF8 (Join-Path $kit 'windows\Install-Runner.ps1')
@'
param($BinaryPath,$ExpectedSha256)
if ((Get-FileHash -LiteralPath $BinaryPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedSha256) { throw 'Wrong runtime selected' }
$target=Join-Path $env:USERPROFILE ('.hapi-servermall/runtime-fixes/'+$ExpectedSha256)
New-Item -ItemType Directory -Path $target -Force | Out-Null
Copy-Item -LiteralPath $BinaryPath -Destination (Join-Path $target 'hapi.exe')
'@ | Set-Content -Encoding UTF8 (Join-Path $kit 'windows\Install-RuntimeFix.ps1')
'Write-Output "Synthetic connection verified."' | Set-Content -Encoding UTF8 (Join-Path $kit 'windows\Verify-Connection.ps1')
try {
  & (Join-Path $sourceRoot 'windows\Install-PacRunner.ps1') -KitPath $kit -KeysPath $keys -OpenCodePath (Join-Path $realUser '.local\bin\opencode.exe') -HapiBinaryPath $hapiBinary
  if (!(Test-Path (Join-Path $env:USERPROFILE '.hapi-servermall\pac-bridge\bin\opencode.cmd'))) { throw 'Missing wrapper' }
  if (!(Test-Path (Join-Path $env:USERPROFILE '.hapi-servermall\runtime-user-pin.json'))) { throw 'Missing runtime pin' }
  try { & (Join-Path $sourceRoot 'windows\Install-PacRunner.ps1') -KitPath $kit -KeysPath $keys -OpenCodePath (Join-Path $realUser '.local\bin\opencode.exe') -HapiBinaryPath $hapiBinary; throw 'Unexpected second install' } catch { if ($_.Exception.Message -notmatch 'existing HAPI/PAC') { throw } }
  Write-Output 'Synthetic isolated installation and repeat protection passed.'
} finally {
  $env:USERPROFILE=$realUser
  $resolved=(Get-Item -LiteralPath $root).FullName
  if ((Split-Path -Parent $resolved) -eq $tempRoot -and (Split-Path -Leaf $resolved).StartsWith('pac-install-proof-')) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
