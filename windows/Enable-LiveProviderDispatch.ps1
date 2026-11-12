[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$WrapperRevision,[switch]$Restore)
$ErrorActionPreference='Stop'
if($WrapperRevision -cnotmatch '^[0-9a-f]{40}$'){throw 'A full existing wrapper revision is required.'}
$pac=Join-Path $env:USERPROFILE '.hapi-servermall\pac-bridge'
$version=Join-Path $pac ('provider-versions/'+$WrapperRevision)
$wrapper=Join-Path $version 'bin\opencode.cmd'
$backup=Join-Path $pac ('wrapper-before-dispatch-'+$WrapperRevision+'.cmd')
$metadata=Join-Path $pac ('wrapper-dispatch-'+$WrapperRevision+'.json')
if(!(Test-Path -LiteralPath $wrapper -PathType Leaf)){throw 'Existing generated wrapper not found.'}
if($Restore){
  if(!(Test-Path -LiteralPath $backup -PathType Leaf) -or !(Test-Path -LiteralPath $metadata -PathType Leaf)){throw 'Dispatch rollback record is missing.'}
  $record=Get-Content -LiteralPath $metadata -Raw -Encoding UTF8 | ConvertFrom-Json
  if((Get-FileHash -LiteralPath $wrapper -Algorithm SHA256).Hash -ne $record.installedHash -or (Get-FileHash -LiteralPath $backup -Algorithm SHA256).Hash -ne $record.backupHash){throw 'The wrapper or its backup changed; inspect before restoring.'}
  $temp=$wrapper+'.restore-'+[guid]::NewGuid().ToString('N')
  Copy-Item -LiteralPath $backup -Destination $temp
  Move-Item -LiteralPath $temp -Destination $wrapper -Force
  Write-Output 'Original wrapper restored for new child processes. Running chats were not changed.'
  return
}
if((Test-Path -LiteralPath $backup) -or (Test-Path -LiteralPath $metadata)){throw 'A previous dispatch change exists; inspect or restore it first.'}
$current=Get-Content -LiteralPath (Join-Path $pac 'provider-current.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if($current.revision -cnotmatch '^[0-9a-f]{40}$'){throw 'Invalid current provider revision.'}
$dispatcher=Join-Path $pac ('provider-versions/'+$current.revision+'/adapters/provider-dispatch.mjs')
if(!(Test-Path -LiteralPath $dispatcher -PathType Leaf)){throw 'The current provider has no dispatch entry point.'}
$before=[IO.File]::ReadAllText($wrapper)
$expectedAdapter=Join-Path $version 'adapters\pac-hapi-opencode.mjs'
$match=[regex]::Match($before, '^@echo off\r?\n"([^"\r\n]+)" "([^"\r\n]+)" %\*\r?\nexit /b %ERRORLEVEL%\r?\n?$')
if(!$match.Success -or $match.Groups[2].Value -cne $expectedAdapter -or !(Test-Path -LiteralPath $match.Groups[1].Value -PathType Leaf)){throw 'The existing wrapper differs from the generated format; no change was made.'}
if($dispatcher -match '["%!\r\n]'){throw 'The dispatcher path cannot be represented safely in a command wrapper.'}
$replacement="@echo off`r`n`"$($match.Groups[1].Value)`" `"$dispatcher`" %*`r`nexit /b %ERRORLEVEL%`r`n"
Copy-Item -LiteralPath $wrapper -Destination $backup
$temp=$wrapper+'.new-'+[guid]::NewGuid().ToString('N')
[IO.File]::WriteAllText($temp,$replacement,[Text.UTF8Encoding]::new($false))
$record=@{backupHash=(Get-FileHash -LiteralPath $backup -Algorithm SHA256).Hash;installedHash=(Get-FileHash -LiteralPath $temp -Algorithm SHA256).Hash}
[IO.File]::WriteAllText($metadata,($record|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
if([IO.File]::ReadAllText($wrapper) -cne $before){throw 'The existing wrapper changed during preparation.'}
Move-Item -LiteralPath $temp -Destination $wrapper -Force
Write-Output 'New child processes use the current provider version. Running chats were not changed.'
