$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$homePath=(New-Item -ItemType Directory -Path (Join-Path $env:TEMP ('pac-live-dispatch-'+[guid]::NewGuid().ToString('N')))).FullName
$pac=Join-Path $homePath '.hapi-servermall\pac-bridge'
$old='a'*40;$current='b'*40
$oldVersion=Join-Path $pac ('provider-versions/'+$old)
$newVersion=Join-Path $pac ('provider-versions/'+$current)
New-Item -ItemType Directory -Force -Path (Join-Path $oldVersion 'bin'),(Join-Path $newVersion 'adapters') | Out-Null
[IO.File]::WriteAllText((Join-Path $pac 'provider-current.json'),(@{revision=$current;namedProviders=$true;legacyMigration=$true}|ConvertTo-Json))
[IO.File]::WriteAllText((Join-Path $newVersion 'adapters\provider-dispatch.mjs'),'// synthetic')
$node=(Get-Command node.exe).Source
$oldAdapter=Join-Path $oldVersion 'adapters\pac-hapi-opencode.mjs'
$wrapper=Join-Path $oldVersion 'bin\opencode.cmd'
$original="@echo off`r`n`"$node`" `"$oldAdapter`" %*`r`nexit /b %ERRORLEVEL%`r`n"
[IO.File]::WriteAllText($wrapper,$original,[Text.UTF8Encoding]::new($false))
$previous=$env:USERPROFILE
try {
 $env:USERPROFILE=$homePath
 & (Join-Path $root 'windows\Enable-LiveProviderDispatch.ps1') -WrapperRevision $old
 if(!([IO.File]::ReadAllText($wrapper)).Contains('provider-dispatch.mjs')){throw 'Dispatch was not installed.'}
 & (Join-Path $root 'windows\Enable-LiveProviderDispatch.ps1') -WrapperRevision $old -Restore
 if([IO.File]::ReadAllText($wrapper) -cne $original){throw 'Original wrapper was not restored exactly.'}
 Write-Output 'Synthetic live dispatch and exact rollback passed.'
} finally {$env:USERPROFILE=$previous}
