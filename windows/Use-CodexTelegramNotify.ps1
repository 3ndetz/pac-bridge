[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$SenderModulePath)
$ErrorActionPreference='Stop'
$module=(Resolve-Path -LiteralPath $SenderModulePath).Path
if(!(Test-Path -LiteralPath $module -PathType Leaf)){throw 'The existing local Telegram sender module is required.'}
$pac=Join-Path $env:USERPROFILE '.hapi-servermall\pac-bridge'
if(!(Test-Path -LiteralPath (Join-Path $pac 'provider-current.json') -PathType Leaf)){throw 'Configure the PAC provider first.'}
$notify=Join-Path $pac 'notify'
if(!(Test-Path -LiteralPath $notify)){New-Item -ItemType Directory -Path $notify | Out-Null}
foreach($name in @('tg-notify.cjs','telegram-notify.cjs')){if(Test-Path -LiteralPath (Join-Path $notify $name)){throw 'A separate Telegram sender is already configured; inspect it before changing notification routing.'}}
$pointer=Join-Path $notify 'codex-telegram-module.txt'
if(Test-Path -LiteralPath $pointer){throw 'A Codex Telegram sender is already configured.'}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $notify /inheritance:r /grant:r "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
if($LASTEXITCODE -ne 0){throw 'Failed to protect notification settings.'}
[IO.File]::WriteAllText($pointer,$module,[Text.UTF8Encoding]::new($false))
Write-Output 'The existing local Codex Telegram sender is selected. Install the current provider loader and restart the runner at a suitable time.'
