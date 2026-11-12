$ErrorActionPreference = 'Stop'
$root = Join-Path $env:TEMP ('pac-repo-installer-test-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$script = Join-Path $root 'Install-FromRepo.ps1'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../windows/Install-FromRepo.ps1') -Destination $script
$binary = Join-Path $root 'runtime.exe'
[IO.File]::WriteAllText($binary, 'synthetic runtime')
$hash = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText((Join-Path $root 'runtime-manifest.json'), (@{hapiSha256=$hash}|ConvertTo-Json))
$stub = @'
param($KitPath, $KeysPath, $OpenCodePath, $HapiBinaryPath)
[IO.File]::WriteAllText($env:PAC_INSTALLER_PROBE_RESULT, (@{kit=$KitPath;keys=$KeysPath;opencode=$OpenCodePath;binary=$HapiBinaryPath}|ConvertTo-Json))
'@
[IO.File]::WriteAllText((Join-Path $root 'Install-PacRunner.ps1'), $stub)
$env:PAC_INSTALLER_PROBE_RESULT = Join-Path $root 'result.json'
& $script -KitPath 'kit' -KeysPath 'keys' -OpenCodePath 'opencode' -HapiBinaryPath $binary
$result = Get-Content -LiteralPath $env:PAC_INSTALLER_PROBE_RESULT -Raw | ConvertFrom-Json
if ($result.kit -ne 'kit' -or $result.keys -ne 'keys' -or $result.opencode -ne 'opencode' -or $result.binary -ne $binary) { throw 'Installer did not forward its arguments.' }
[IO.File]::WriteAllText($binary, 'damaged runtime')
$rejected = $false
try { & $script -KitPath 'kit' -KeysPath 'keys' -OpenCodePath 'opencode' -HapiBinaryPath $binary } catch { $rejected = $_.Exception.Message -match 'checksum mismatch' }
if (!$rejected) { throw 'Installer did not reject a changed runtime.' }
Write-Output 'Repository installer forwards arguments and rejects an invalid checksum.'
