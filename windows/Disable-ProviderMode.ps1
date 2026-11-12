[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$KitPath)
$ErrorActionPreference='Stop'
$kit=(Resolve-Path -LiteralPath $KitPath).Path
$runtime=Join-Path $kit 'windows\Runtime.ps1'
$pac=Join-Path $env:USERPROFILE '.hapi-servermall\pac-bridge'
if(!(Test-Path -LiteralPath $runtime -PathType Leaf) -or !(Test-Path -LiteralPath $pac -PathType Container)){throw 'An existing PAC runtime is required.'}
$text=[IO.File]::ReadAllText($runtime)
$marker='# PAC Bridge provider loader v1'
$line=". (Join-Path `$env:USERPROFILE '.hapi-servermall\pac-bridge\provider-runtime.ps1')"
$block=$marker+"`r`n"+$line
if(([regex]::Matches($text,[regex]::Escape($marker))).Count -ne 1 -or !$text.Contains($block)){throw 'Provider loader is absent, duplicated or modified; inspect the runtime manually.'}
$backup=Join-Path $pac ('runtime-before-provider-disable-'+[guid]::NewGuid().ToString()+'.ps1')
Copy-Item -LiteralPath $runtime -Destination $backup
$temporary=$runtime+'.new-'+[guid]::NewGuid().ToString()
[IO.File]::WriteAllText($temporary,$text.Replace($block,''),[Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $temporary -Destination $runtime -Force
Write-Output 'Provider loader disabled for the next runner start. The active runner and stored session data were not changed.'
