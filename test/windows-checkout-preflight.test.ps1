$ErrorActionPreference='Stop'
$sourceScript=Join-Path (Split-Path -Parent $PSScriptRoot) 'windows\Configure-ExistingProvider.ps1'
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('pac-checkout-preflight-'+[guid]::NewGuid().ToString('N'))
$oldProfile=$env:USERPROFILE
try {
  New-Item -ItemType Directory -Path $testRoot | Out-Null
  $testRoot=(Resolve-Path -LiteralPath $testRoot).Path
  $testProfile=Join-Path $testRoot 'home'
  $outer=Join-Path $testRoot 'outer'
  $zip=Join-Path $outer 'zip'
  New-Item -ItemType Directory -Path $testProfile,(Join-Path $zip 'windows') -Force | Out-Null
  Copy-Item -LiteralPath $sourceScript -Destination (Join-Path $zip 'windows\Configure-ExistingProvider.ps1')
  $env:USERPROFILE=$testProfile
  foreach($nested in @($false,$true)) {
    if($nested) { & git.exe init --quiet $outer; if($LASTEXITCODE -ne 0){throw 'Synthetic parent Git setup failed.'} }
    $failed=$false
    try { & (Join-Path $zip 'windows\Configure-ExistingProvider.ps1') -KitPath 'missing' -KeysPath 'missing' -OpenCodePath 'missing' } catch { $failed=$true }
    if(!$failed){throw 'An archive or nested non-checkout was accepted.'}
    if(@(Get-ChildItem -LiteralPath $testProfile -Force).Count -ne 0){throw 'Preflight modified the synthetic user profile.'}
  }
  $checkout=Join-Path $testRoot 'checkout'
  New-Item -ItemType Directory -Path (Join-Path $checkout 'windows'),(Join-Path $checkout 'adapters'),(Join-Path $checkout 'src'),(Join-Path $checkout 'source-package') -Force | Out-Null
  Copy-Item -LiteralPath $sourceScript -Destination (Join-Path $checkout 'windows\Configure-ExistingProvider.ps1')
  foreach($file in @('adapters/install-hapi-command.mjs','adapters/pac-hapi-opencode.mjs','src/opencode-provider.mjs','source-package/package.json','source-package/package-lock.json')) { [IO.File]::WriteAllText((Join-Path $checkout $file),'fixture') }
  & git.exe init --quiet $checkout
  & git.exe -C $checkout add -- .
  & git.exe -C $checkout -c user.name=Fixture -c user.email=fixture@example.invalid commit --quiet -m fixture
  if($LASTEXITCODE -ne 0){throw 'Synthetic checkout setup failed.'}
  $message=''
  try { & (Join-Path $checkout 'windows\Configure-ExistingProvider.ps1') -KitPath 'missing' -KeysPath 'missing' -OpenCodePath 'missing' } catch { $message=$_.Exception.Message }
  if($message -notmatch 'missing'){throw 'A valid checkout did not reach subsequent input validation.'}
  [IO.File]::WriteAllText((Join-Path $checkout 'src/opencode-provider.mjs'),'changed')
  $message=''
  try { & (Join-Path $checkout 'windows\Configure-ExistingProvider.ps1') -KitPath 'missing' -KeysPath 'missing' -OpenCodePath 'missing' } catch { $message=$_.Exception.Message }
  if($message -notmatch 'Commit or discard'){throw 'Modified provider sources were not rejected before profile changes.'}
  [IO.File]::WriteAllText((Join-Path $checkout 'src/opencode-provider.mjs'),'fixture')
  & git.exe -C $checkout rm --quiet -- source-package/package-lock.json
  & git.exe -C $checkout -c user.name=Fixture -c user.email=fixture@example.invalid commit --quiet -m 'missing manifest'
  $message=''
  try { & (Join-Path $checkout 'windows\Configure-ExistingProvider.ps1') -KitPath 'missing' -KeysPath 'missing' -OpenCodePath 'missing' } catch { $message=$_.Exception.Message }
  if($message -notmatch 'manifests must be tracked'){throw 'Missing dependency manifests were not rejected before profile changes.'}
  [IO.File]::WriteAllText((Join-Path $checkout 'source-package/package-lock.json'),'fixture')
  & git.exe -C $checkout add -- source-package/package-lock.json
  & git.exe -C $checkout rm --quiet -- adapters/install-hapi-command.mjs
  & git.exe -C $checkout -c user.name=Fixture -c user.email=fixture@example.invalid commit --quiet -m 'missing provider'
  $message=''
  try { & (Join-Path $checkout 'windows\Configure-ExistingProvider.ps1') -KitPath 'missing' -KeysPath 'missing' -OpenCodePath 'missing' } catch { $message=$_.Exception.Message }
  if($message -notmatch 'missing tracked provider'){throw 'Missing provider sources were not rejected before profile changes.'}
  if(@(Get-ChildItem -LiteralPath $testProfile -Force).Count -ne 0){throw 'Preflight modified the synthetic user profile.'}
  Write-Output 'ZIP, nested, modified and incomplete checkouts rejected; clean checkout reached input validation.'
} finally {
  $env:USERPROFILE=$oldProfile
  if(Test-Path -LiteralPath $testRoot) {
    $absolute=(Resolve-Path -LiteralPath $testRoot).Path
    $parent=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
    if(!$absolute.StartsWith($parent,[StringComparison]::OrdinalIgnoreCase) -or !(Split-Path -Leaf $absolute).StartsWith('pac-checkout-preflight-')){throw 'Refusing unexpected test cleanup path.'}
    Remove-Item -LiteralPath $absolute -Recurse -Force
  }
}
