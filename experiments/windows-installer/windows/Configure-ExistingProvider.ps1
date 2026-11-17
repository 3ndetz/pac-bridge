[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$KitPath,
  [Parameter(Mandatory=$true)][string]$KeysPath,
  [Parameter(Mandatory=$true)][string]$OpenCodePath
)
$ErrorActionPreference='Stop'
$kit=[IO.Path]::GetFullPath((Resolve-Path -LiteralPath $KitPath).Path)
$keys=[IO.Path]::GetFullPath((Resolve-Path -LiteralPath $KeysPath).Path)
$opencode=[IO.Path]::GetFullPath((Resolve-Path -LiteralPath $OpenCodePath).Path)
$profile=[IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.hapi-servermall'))
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
$source=Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Runtime-Lock.ps1')
$previousErrorPreference=$ErrorActionPreference
$ErrorActionPreference='Continue'
try {$gitRoot=@(& git.exe -C $source rev-parse --show-toplevel 2>$null)} finally {$ErrorActionPreference=$previousErrorPreference}
if($LASTEXITCODE -ne 0 -or $gitRoot.Count -ne 1 -or !(Test-Path -LiteralPath $gitRoot[0] -PathType Container) -or (Resolve-Path -LiteralPath $gitRoot[0]).Path -ine (Resolve-Path -LiteralPath $source).Path){throw 'A Git checkout of PAC Bridge is required; clone the repository before installing.'}
$revision=@(& git.exe -C $source rev-parse HEAD 2>$null)
if($LASTEXITCODE -ne 0 -or $revision.Count -ne 1 -or $revision[0] -cnotmatch '^[0-9a-f]{40}$'){throw 'A Git checkout with a valid commit is required.'}
& git.exe -C $source diff --quiet HEAD -- adapters src source-package
if($LASTEXITCODE -ne 0){throw 'Commit or discard source changes before installing; the revision must match the files.'}
& git.exe -C $source ls-files --error-unmatch -- source-package/package.json source-package/package-lock.json | Out-Null
if($LASTEXITCODE -ne 0){throw 'The source dependency manifest and lockfile must be tracked.'}
$runtimeExisted=Test-Path -LiteralPath $runtime -PathType Leaf
if((Test-Path -LiteralPath $runtime) -and !$runtimeExisted){throw 'Runtime.ps1 is not a file.'}
if($runtimeExisted -and ((Get-Item -LiteralPath $runtime -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Runtime.ps1 must not be a link.'}
$originalBytes=if($runtimeExisted){Read-PacLockedBytes $runtime}else{$null}
$old=if($runtimeExisted){$reader=[IO.StreamReader]::new([IO.MemoryStream]::new($originalBytes),[Text.Encoding]::UTF8,$true);try{$reader.ReadToEnd()}finally{$reader.Dispose()}}else{''}
$addition="`r`n# PAC Bridge connection v1`r`n. (Join-Path `$env:USERPROFILE '.hapi-servermall\pac-bridge\connection-runtime.ps1')`r`n"
$providerAddition="`r`n# PAC Bridge provider loader v1`r`n. (Join-Path `$env:USERPROFILE '.hapi-servermall\pac-bridge\provider-runtime.ps1')`r`n"
$encoding=[Text.UTF8Encoding]::new($false)
$originalRuntime=if($runtimeExisted){[Convert]::ToBase64String($originalBytes)}else{$null}
function Get-CheckedRuntime {
  if(!(Test-Path -LiteralPath $runtime)){return $null}
  $item=Get-Item -LiteralPath $runtime -Force
  if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Runtime.ps1 is not a regular file.'}
  return [Convert]::ToBase64String((Read-PacLockedBytes $runtime))
}
throw 'Installation disabled: crash-safe recovery is not yet established.'
$createdPac=$false
$createdRuntime=$false
try {
New-Item -ItemType Directory -Path $pac -ErrorAction Stop | Out-Null
$createdPac=$true
if((Get-CheckedRuntime) -cne $originalRuntime){throw 'Runtime.ps1 changed before installation.'}
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
  [IO.File]::WriteAllBytes((Join-Path $pac 'runtime-before-connection.ps1'),$originalBytes)
} else {
  $runtimeStream=[IO.File]::Open($runtime,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  $createdRuntime=$true
  $runtimeStream.Dispose()
}
& (Join-Path $PSScriptRoot 'Install-ProviderMode.ps1') -KitPath $kit -NamedProviders
if($LASTEXITCODE -ne 0){throw 'Provider staging failed.'}
$expectedRuntime=if($runtimeExisted){$originalRuntime}else{[Convert]::ToBase64String($encoding.GetBytes(''))}
Set-PacLockedBytes $runtime $expectedRuntime ($encoding.GetBytes($old+$addition))
$expectedProviderRuntime=[Convert]::ToBase64String($encoding.GetBytes($old+$addition))
& (Join-Path $PSScriptRoot 'Install-ProviderMode.ps1') -KitPath $kit -Activate -NamedProviders -ExpectedRuntimeBase64 $expectedProviderRuntime
Write-Output 'PAC provider configured for the next runner start. HAPI and existing sessions were not restarted.'
} catch {
  $failure=$_
  if($createdPac){
    try {
      $current=Get-CheckedRuntime
      $known=@([Convert]::ToBase64String($encoding.GetBytes('')),[Convert]::ToBase64String($encoding.GetBytes($old+$addition)),[Convert]::ToBase64String($encoding.GetBytes($old+$addition+$providerAddition)))
      if($runtimeExisted){$known+= [Convert]::ToBase64String($originalBytes)} else {$known+= $null}
      if($current -notin $known){throw 'Runtime.ps1 changed unexpectedly; preserve the profile and inspect it manually.'}
      if($runtimeExisted){
        if($null -eq $current){throw 'The original Runtime.ps1 disappeared; preserve the profile and inspect it manually.'}
        Set-PacLockedBytes $runtime $current $originalBytes
      } elseif($null -ne $current -and !$createdRuntime){
        throw 'Runtime.ps1 was not created by this installer; preserve it for manual inspection.'
      } elseif($null -ne $current){
        throw 'Runtime.ps1 was created during this installation; preserve it for manual inspection.'
      }
      $resolvedProfile=(Resolve-Path -LiteralPath $profile).Path
      $expectedPac=[IO.Path]::GetFullPath((Join-Path $resolvedProfile 'pac-bridge'))
      $actualPac=[IO.Path]::GetFullPath((Resolve-Path -LiteralPath $pac).Path)
      if($actualPac -ine $expectedPac -or ((Get-Item -LiteralPath $pac -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'PAC profile location changed; preserve it for manual inspection.'}
      throw 'The failed PAC profile was retained for manual inspection; it was not moved or deleted.'
    } catch { throw ('Installation failed and safe automatic recovery was refused: '+$_.Exception.Message+' Original error: '+$failure.Exception.Message) }
  }
  throw $failure
}
