[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$TelegramConfigPath)
$ErrorActionPreference = 'Stop'
$pac = Join-Path $env:USERPROFILE '.hapi-servermall\pac-bridge'
$source = Join-Path $pac 'source\scripts\telegram-notify.cjs'
$wrapper = Join-Path $pac 'bin\opencode.cmd'
$notify = Join-Path $pac 'notify'
if (!(Test-Path -LiteralPath $source -PathType Leaf) -or !(Test-Path -LiteralPath $wrapper -PathType Leaf)) { throw 'Install the PAC Bridge profile before enabling notifications.' }
$config = (Resolve-Path -LiteralPath $TelegramConfigPath).Path
if (!(Test-Path -LiteralPath $config -PathType Leaf)) { throw 'Telegram configuration file is missing.' }
if (Test-Path -LiteralPath $notify) { throw 'A notification directory already exists. Review it before changing notification settings.' }
$body = [IO.File]::ReadAllText($wrapper)
if ($body -match 'PAC_TURN_NOTIFY_SCRIPT') { throw 'A completion sender is already configured.' }
if ($notify -match '["%!\r\n]') { throw 'The notification path cannot be represented safely in a Windows command wrapper.' }
New-Item -ItemType Directory -Path $notify | Out-Null
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $notify /inheritance:r /grant:r "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to protect notification credentials.' }
Copy-Item -LiteralPath $config -Destination (Join-Path $notify 'tg-notify.env')
Copy-Item -LiteralPath $source -Destination (Join-Path $notify 'telegram-notify.cjs')
$line = 'set "PAC_TURN_NOTIFY_SCRIPT=' + (Join-Path $notify 'telegram-notify.cjs') + '"'
$updated = $body -replace '(?im)^@echo off\r?\n', ("@echo off`r`n"+$line+"`r`n")
if ($updated -eq $body) { throw 'OpenCode wrapper format was not recognized.' }
[IO.File]::WriteAllText(($wrapper+'.new'), $updated, [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath ($wrapper+'.new') -Destination $wrapper -Force
Write-Output 'Telegram completion notifications are enabled for newly started PAC chats.'
